<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  MEMORY_CATEGORY_COLORS,
  type MemoryGraphLink,
  type MemoryGraphNode,
} from "@/api/memory";

/**
 * MemoryGraph —— 3D 发光神经网络（宇宙状，从中心向四周发散）。
 *
 * 渲染策略：
 *   - 节点用 InstancedMesh（一个 draw call 画完 500 个球，hover 变色靠 instanceColor）
 *   - 辉光用 Points + 自定义 shader（径向衰减 + 加法混合），叠在实体球上形成「发光点」
 *   - 连线用 LineSegments + 顶点色，透明度按 weight
 *   - 中心核心节点单独一个球 + 两个 sprite 光晕，做呼吸动画
 *
 * 位置是**确定性**的（按 id 哈希），所以刷新页面不会整个宇宙重排，
 * 用户对「我的记忆在哪个方位」的空间记忆不会被破坏。
 */

const props = defineProps<{
  nodes: MemoryGraphNode[];
  links: MemoryGraphLink[];
  /** 空字符串 = 全部；否则非该类节点会被调暗（不隐藏，保留宇宙整体感） */
  activeCategory: string;
  selectedId: string;
}>();

const emit = defineEmits<{
  (e: "select", id: string): void;
}>();

const containerRef = ref<HTMLDivElement | null>(null);
const hoveredId = ref("");
const ready = ref(false);

let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let controls: OrbitControls | null = null;
let rafId = 0;
let resizeObserver: ResizeObserver | null = null;

/** 节点图元（每次数据变化时重建） */
let nodeMesh: THREE.InstancedMesh | null = null;
let glowPoints: THREE.Points | null = null;
let linkLines: THREE.LineSegments | null = null;
let coreGroup: THREE.Group | null = null;

/** id → 实例索引 / 世界坐标（供交互与高亮使用） */
let indexById = new Map<string, number>();
let positionById = new Map<string, THREE.Vector3>();
/** 每个实例的基础缩放（重要性映射），高亮时在此基础上放大 */
let baseScale: number[] = [];
let nodeList: MemoryGraphNode[] = [];

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let pointerDownAt = { x: 0, y: 0 };

// ===========================================================================
// 布局
// ===========================================================================

/** FNV-1a 哈希 → [0,1)，保证同一 id 每次得到同样的位置 */
function hash01(input: string, salt = 0): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

/**
 * 球壳分布 + 分类扇区 + 星系盘压扁。
 *
 * 每个分类占一个方位角扇区，所以「同类的记忆会聚在同一侧」——
 * 这让 3D 图真的能读出结构，而不只是一团随机点。
 */
function layoutNodes(nodes: MemoryGraphNode[]): THREE.Vector3[] {
  const categories = [...new Set(nodes.map((n) => n.category))];
  const sectorSize = (Math.PI * 2) / Math.max(1, categories.length);

  return nodes.map((node) => {
    const catIndex = Math.max(0, categories.indexOf(node.category));
    const sectorStart = catIndex * sectorSize;

    // phi: 0..PI（从北极到南极），由哈希决定纬度
    const phi = Math.acos(1 - 2 * hash01(node.id, 1));
    // theta: 分类扇区内偏移
    const theta = sectorStart + hash01(node.id, 2) * sectorSize;

    // 越重要越靠近核心：6 ~ 15
    const radius = 6 + (1 - node.importance) * 7 + hash01(node.id, 3) * 2.5;

    const x = radius * Math.sin(phi) * Math.cos(theta);
    const z = radius * Math.sin(phi) * Math.sin(theta);
    // 压扁 y，形成星系盘而不是一个均匀的球
    const y = radius * Math.cos(phi) * 0.55;

    return new THREE.Vector3(x, y, z);
  });
}

// ===========================================================================
// 构建
// ===========================================================================

function disposeObject(obj: THREE.Object3D | null) {
  if (!obj) return;
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const material = mesh.material as
      | THREE.Material
      | THREE.Material[]
      | undefined;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else material?.dispose();
  });
  obj.removeFromParent();
}

function clearGraph() {
  if (!scene) return;
  disposeObject(nodeMesh);
  disposeObject(glowPoints);
  disposeObject(linkLines);
  disposeObject(coreGroup);
  nodeMesh = null;
  glowPoints = null;
  linkLines = null;
  coreGroup = null;
}

function buildCore() {
  if (!scene) return;
  const group = new THREE.Group();

  const coreMat = new THREE.MeshBasicMaterial({ color: 0xdcd6ff });
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.9, 24, 24), coreMat);
  group.add(core);

  // 光晕：canvas 生成径向渐变纹理，比 shader 更省事且效果柔和
  const glowTexture = createGlowTexture();
  const glowMat = new THREE.SpriteMaterial({
    map: glowTexture,
    color: 0xa78bfa,
    transparent: true,
    opacity: 0.75,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const glow = new THREE.Sprite(glowMat);
  glow.scale.setScalar(9);
  group.add(glow);

  const haloMat = glowMat.clone();
  haloMat.opacity = 0.28;
  haloMat.color = new THREE.Color(0x60a5fa);
  const halo = new THREE.Sprite(haloMat);
  halo.scale.setScalar(16);
  group.add(halo);

  scene.add(group);
  coreGroup = group;
}

function createGlowTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2,
  );
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.25, "rgba(255,255,255,0.55)");
  gradient.addColorStop(0.6, "rgba(255,255,255,0.12)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function buildGraph() {
  if (!scene) return;
  clearGraph();

  nodeList = props.nodes;
  indexById = new Map();
  positionById = new Map();
  baseScale = [];

  if (nodeList.length === 0) return;

  const positions = layoutNodes(nodeList);
  nodeList.forEach((node, i) => {
    indexById.set(node.id, i);
    positionById.set(node.id, positions[i]);
  });

  // ---- 实体球（InstancedMesh）----
  const geometry = new THREE.SphereGeometry(1, 12, 12);
  const material = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0.95,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, nodeList.length);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  const dummy = new THREE.Object3D();
  nodeList.forEach((node, i) => {
    // 0.16 ~ 0.5：重要度映射到半径
    const scale = 0.16 + node.importance * 0.34;
    baseScale[i] = scale;
    dummy.position.copy(positions[i]);
    dummy.scale.setScalar(scale);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    mesh.setColorAt(i, nodeColor(node, false));
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

  scene.add(mesh);
  nodeMesh = mesh;

  // ---- 辉光（Points + shader）----
  const glowGeometry = new THREE.BufferGeometry();
  const glowPositions: number[] = [];
  const glowColors: number[] = [];
  const glowSizes: number[] = [];

  nodeList.forEach((node, i) => {
    const p = positions[i];
    glowPositions.push(p.x, p.y, p.z);
    const color = nodeColor(node, false);
    glowColors.push(color.r, color.g, color.b);
    // 点尺寸（世界单位近似），重要度越大辉光越大
    glowSizes.push(0.9 + node.importance * 1.9);
  });

  glowGeometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(glowPositions, 3),
  );
  glowGeometry.setAttribute(
    "aColor",
    new THREE.Float32BufferAttribute(glowColors, 3),
  );
  glowGeometry.setAttribute(
    "aSize",
    new THREE.Float32BufferAttribute(glowSizes, 1),
  );

  const glowMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
      uDimOthers: { value: 1 },
    },
    vertexShader: `
      attribute vec3 aColor;
      attribute float aSize;
      uniform float uPixelRatio;
      varying vec3 vColor;
      void main() {
        vColor = aColor;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * uPixelRatio * (260.0 / -mvPosition.z);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      void main() {
        vec2 coord = gl_PointCoord - vec2(0.5);
        float dist = length(coord);
        if (dist > 0.5) discard;
        float alpha = pow(smoothstep(0.5, 0.0, dist), 2.4);
        gl_FragColor = vec4(vColor, alpha * 0.85);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(glowGeometry, glowMaterial);
  scene.add(points);
  glowPoints = points;

  // ---- 连线 ----
  buildLinks();
}

function buildLinks() {
  if (!scene) return;
  disposeObject(linkLines);
  linkLines = null;

  if (props.links.length === 0) return;

  const linePositions: number[] = [];
  const lineColors: number[] = [];

  for (const link of props.links) {
    const a = positionById.get(link.source);
    const b = positionById.get(link.target);
    if (!a || !b) continue;

    linePositions.push(a.x, a.y, a.z, b.x, b.y, b.z);

    const strength = Math.min(1, Math.max(0.15, link.weight));
    // 连线用偏冷的蓝紫，避免和节点色抢视觉
    const c = new THREE.Color(0x8b9cff).multiplyScalar(0.35 + strength * 0.5);
    lineColors.push(c.r, c.g, c.b, c.r, c.g, c.b);
  }

  if (linePositions.length === 0) return;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(linePositions, 3),
  );
  geometry.setAttribute(
    "color",
    new THREE.Float32BufferAttribute(lineColors, 3),
  );

  const material = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.42,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  const lines = new THREE.LineSegments(geometry, material);
  scene.add(lines);
  linkLines = lines;
}

// ===========================================================================
// 视觉状态
// ===========================================================================

function nodeColor(node: MemoryGraphNode, highlighted: boolean): THREE.Color {
  const hex = MEMORY_CATEGORY_COLORS[node.category] ?? "#94a3b8";
  const color = new THREE.Color(hex);
  const dimmed =
    props.activeCategory !== "" && node.category !== props.activeCategory;
  if (dimmed) return color.multiplyScalar(0.18);
  if (highlighted) return color.multiplyScalar(1.9);
  return color;
}

/** 按当前过滤条件与高亮状态刷新所有实例颜色 */
function refreshNodeColors() {
  if (!nodeMesh) return;
  const hoverIndex = hoveredId.value
    ? indexById.get(hoveredId.value)
    : undefined;
  const selectedIndex = props.selectedId
    ? indexById.get(props.selectedId)
    : undefined;

  // 复用一个 dummy，避免在 500 次循环里反复 new
  const dummy = new THREE.Object3D();

  nodeList.forEach((node, i) => {
    const highlighted = i === hoverIndex || i === selectedIndex;
    nodeMesh!.setColorAt(i, nodeColor(node, highlighted));

    const pos = positionById.get(node.id);
    if (!pos) return;
    dummy.position.copy(pos);
    const bump = i === hoverIndex ? 1.5 : i === selectedIndex ? 1.3 : 1;
    dummy.scale.setScalar(baseScale[i] * bump);
    dummy.updateMatrix();
    nodeMesh!.setMatrixAt(i, dummy.matrix);
  });

  nodeMesh.instanceMatrix.needsUpdate = true;
  if (nodeMesh.instanceColor) nodeMesh.instanceColor.needsUpdate = true;

  // 辉光层同步颜色（同一套 indexById 顺序）
  if (glowPoints) {
    const attr = glowPoints.geometry.getAttribute("aColor");
    nodeList.forEach((node, i) => {
      const highlighted = i === hoverIndex || i === selectedIndex;
      const color = nodeColor(node, highlighted);
      attr.setXYZ(i, color.r, color.g, color.b);
    });
    attr.needsUpdate = true;
  }

  if (linkLines) {
    linkLines.visible = props.activeCategory === "";
  }
}

// ===========================================================================
// 交互
// ===========================================================================

function updatePointer(event: PointerEvent) {
  const el = containerRef.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
}

function pickNode(event: PointerEvent): MemoryGraphNode | null {
  if (!camera || !nodeMesh) return null;
  updatePointer(event);
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(nodeMesh, false);
  const hit = hits.find((h) => h.instanceId !== undefined);
  if (!hit || hit.instanceId === undefined) return null;
  return nodeList[hit.instanceId] ?? null;
}

function onPointerMove(event: PointerEvent) {
  const node = pickNode(event);
  const nextId = node?.id ?? "";
  if (nextId !== hoveredId.value) {
    hoveredId.value = nextId;
    refreshNodeColors();
    const el = containerRef.value;
    if (el) el.style.cursor = nextId ? "pointer" : "grab";
  }
}

function onPointerDown(event: PointerEvent) {
  pointerDownAt = { x: event.clientX, y: event.clientY };
}

function onPointerUp(event: PointerEvent) {
  // 拖拽旋转后不要误触发选中：位移超过 4px 视为拖拽
  const moved =
    Math.abs(event.clientX - pointerDownAt.x) +
    Math.abs(event.clientY - pointerDownAt.y);
  if (moved > 4) return;

  const node = pickNode(event);
  if (node) emit("select", node.id);
}

function onPointerLeave() {
  if (hoveredId.value) {
    hoveredId.value = "";
    refreshNodeColors();
  }
}

// ===========================================================================
// 生命周期
// ===========================================================================

function init() {
  const el = containerRef.value;
  if (!el) return;

  const width = el.clientWidth || 800;
  const height = el.clientHeight || 600;

  renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height);
  el.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(52, width / height, 0.1, 500);
  camera.position.set(0, 12, 32);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.rotateSpeed = 0.55;
  controls.zoomSpeed = 0.8;
  controls.minDistance = 8;
  controls.maxDistance = 90;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.32;
  controls.target.set(0, 0, 0);

  // 背景星尘：给「宇宙」一点纵深，不参与交互
  const starGeometry = new THREE.BufferGeometry();
  const starPositions = new Float32Array(1500 * 3);
  for (let i = 0; i < 1500; i++) {
    const r = 40 + Math.random() * 90;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(1 - 2 * Math.random());
    starPositions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    starPositions[i * 3 + 1] = r * Math.cos(phi);
    starPositions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
  }
  starGeometry.setAttribute(
    "position",
    new THREE.BufferAttribute(starPositions, 3),
  );
  const stars = new THREE.Points(
    starGeometry,
    new THREE.PointsMaterial({
      color: 0x9aa8ff,
      size: 0.28,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  scene.add(stars);

  buildCore();
  buildGraph();
  refreshNodeColors();

  el.addEventListener("pointermove", onPointerMove);
  el.addEventListener("pointerdown", onPointerDown);
  el.addEventListener("pointerup", onPointerUp);
  el.addEventListener("pointerleave", onPointerLeave);

  resizeObserver = new ResizeObserver(() => {
    if (!renderer || !camera || !containerRef.value) return;
    const w = containerRef.value.clientWidth;
    const h = containerRef.value.clientHeight;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  });
  resizeObserver.observe(el);

  ready.value = true;
  animate();
}

function animate() {
  rafId = requestAnimationFrame(animate);
  if (!renderer || !scene || !camera) return;
  if (document.hidden) return; // 页面不可见时不渲染，省电

  const t = performance.now() / 1000;

  // 核心呼吸
  if (coreGroup) {
    const pulse = 1 + Math.sin(t * 1.5) * 0.05;
    coreGroup.children[0]?.scale.setScalar(pulse);
    const glow = coreGroup.children[1] as THREE.Sprite | undefined;
    if (glow) glow.material.opacity = 0.62 + Math.sin(t * 1.5) * 0.14;
  }

  controls?.update();
  renderer.render(scene, camera);
}

onMounted(init);

onBeforeUnmount(() => {
  cancelAnimationFrame(rafId);
  resizeObserver?.disconnect();
  const el = containerRef.value;
  if (el) {
    el.removeEventListener("pointermove", onPointerMove);
    el.removeEventListener("pointerdown", onPointerDown);
    el.removeEventListener("pointerup", onPointerUp);
    el.removeEventListener("pointerleave", onPointerLeave);
  }
  controls?.dispose();
  clearGraph();
  if (renderer) {
    renderer.dispose();
    renderer.domElement.remove();
    renderer = null;
  }
  scene = null;
  camera = null;
});

watch(
  () => [props.nodes, props.links],
  () => {
    if (!ready.value) return;
    buildGraph();
    refreshNodeColors();
  },
  { deep: false },
);

watch(
  () => [props.activeCategory, props.selectedId],
  () => refreshNodeColors(),
);
</script>

<template>
  <div ref="containerRef" class="memory-graph">
    <div v-if="nodes.length === 0" class="empty-orb">
      <div class="orb"></div>
      <p>还没有任何记忆</p>
      <span>和小蝶聊几句，重要的内容会被自动记住</span>
    </div>
    <div v-else-if="hoveredId" class="hover-chip">
      {{ nodes.find((n) => n.id === hoveredId)?.summary }}
    </div>
  </div>
</template>

<style scoped lang="less">
@import "../../styles/variables.less";

.memory-graph {
  position: relative;
  width: 100%;
  height: 100%;
  cursor: grab;
  overflow: hidden;

  &:active {
    cursor: grabbing;
  }

  :deep(canvas) {
    display: block;
    width: 100% !important;
    height: 100% !important;
  }
}

.empty-orb {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: @space-3;
  color: rgba(226, 232, 240, 0.75);
  text-align: center;

  .orb {
    width: 96px;
    height: 96px;
    border-radius: 50%;
    background: radial-gradient(circle at 35% 30%, #c4b5fd 0%, #7c5cfc 45%, rgba(124, 92, 252, 0) 72%);
    box-shadow: 0 0 60px rgba(124, 92, 252, 0.55);
    animation: orb-breathe 3.2s ease-in-out infinite;
  }

  p {
    font-size: @font-md;
    font-weight: 600;
    margin: 0;
  }

  span {
    font-size: @font-xs;
    color: rgba(148, 163, 184, 0.9);
  }
}

@keyframes orb-breathe {
  0%,
  100% {
    transform: scale(1);
    opacity: 0.85;
  }
  50% {
    transform: scale(1.08);
    opacity: 1;
  }
}

.hover-chip {
  position: absolute;
  left: 50%;
  bottom: @space-5;
  transform: translateX(-50%);
  max-width: 70%;
  padding: @space-2 @space-4;
  border-radius: @radius-pill;
  background: rgba(15, 23, 42, 0.78);
  border: 1px solid rgba(148, 163, 184, 0.28);
  color: #e2e8f0;
  font-size: @font-xs;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
  backdrop-filter: blur(6px);
}
</style>
