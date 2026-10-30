<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import {
  MEMORY_CATEGORY_COLORS,
  MEMORY_CATEGORY_LABELS,
  type MemoryGraphLink,
  type MemoryGraphNode,
} from "@/api/memory";

/**
 * MemoryGraph —— 记忆星图（3D 星云 + 星座）。
 *
 * 为什么不是「球 + 直线」的老画法：
 *   - 实体球在加法混合下会糊成一片糖果色圆点，且没有明暗层次；
 *   - 均匀分布的节点 + 直连线会织成一张「铁丝网」，越看越乱。
 *
 * 这一版的四层结构：
 *   1. 星点层：Points + 自定义 shader（炽白核心 + 指数衰减光晕 + 轻微闪烁），
 *      靠 UnrealBloom 放大成真正的「发光星」，尺寸映射重要度、亮度映射连通度；
 *   2. 星云层：每个分类一团同色色雾（大 sprite），让「簇」有体积而不是散点；
 *   3. 连线层：二次贝塞尔弧线（盘面内弯曲）+ 长度衰减，静息态几乎隐形，
 *      只有点选/悬停时才亮起 —— 静时是星图，动时才是网络；
 *   4. 景深层：按视距衰减亮度与尺寸，配合星尘与 ACES 色调映射做出纵深。
 *
 * 布局是**确定性**的（按 id 哈希）：分类各占一个方位，同一分类的相近记忆
 * 抱成子簇，越重要越靠近簇心。刷新页面不会重排，用户的空间记忆不会被破坏。
 */

const props = defineProps<{
  nodes: MemoryGraphNode[];
  links: MemoryGraphLink[];
  /** 空字符串 = 全部；否则非该类节点会被压暗 */
  activeCategory: string;
  selectedId: string;
}>();

const emit = defineEmits<{
  (e: "select", id: string): void;
}>();

const containerRef = ref<HTMLDivElement | null>(null);
const hoveredId = ref("");
const ready = ref(false);
const tip = ref<{
  x: number;
  y: number;
  label: string;
  text: string;
  color: string;
} | null>(null);

let renderer: THREE.WebGLRenderer | null = null;
let composer: EffectComposer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let controls: OrbitControls | null = null;
let rafId = 0;
let resizeObserver: ResizeObserver | null = null;

/** 光晕/星云/星尘共用的径向渐变贴图（只建一次，重建图时不重新生成） */
let softTexture: THREE.Texture | null = null;

/** 图元（数据变化时整体重建） */
let nodePoints: THREE.Points | null = null;
let nodeMaterial: THREE.ShaderMaterial | null = null;
let linkLines: THREE.LineSegments | null = null;
let linkMaterial: THREE.ShaderMaterial | null = null;
let linkAlphaAttr: THREE.BufferAttribute | null = null;
let hazeGroup: THREE.Group | null = null;
let coreGroup: THREE.Group | null = null;

/** id → 实例索引 / 世界坐标 */
let indexById = new Map<string, number>();
let positionById = new Map<string, THREE.Vector3>();
/** 邻居表（高亮时决定谁被点亮） */
let neighborsOf = new Map<string, Set<string>>();
/** 每条连线在顶点缓冲里的区间 */
let linkMeta: Array<{ a: string; b: string; start: number; count: number }> = [];
/** 连线的基础透明度（长度衰减后），高亮时在此基础上放大 */
let linkBaseAlpha: number[] = [];
/** 节点基础色（未压暗），过滤与高亮都基于它重算 */
let baseColors: number[] = [];
let nodeList: MemoryGraphNode[] = [];

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let pointerDownAt = { x: 0, y: 0 };

// ===========================================================================
// 布局
// ===========================================================================

/**
 * 确定性伪随机 → [0,1)。
 *
 * 用「盐值参与串哈希 + MurmurHash3 收尾」而不是「盐值异或进初始状态」：
 * 后者对 `FACT-1 … FACT-61` 这类只差末位的 id 会产生**高度相关**的结果，
 * 节点于是排成一条弧线（视觉上像风筝骨架），而不是自然散布。
 * 收尾的几步 avalanche 把相关性彻底打散。
 */
function hash01(input: string, salt = 0): number {
  const s = `${salt}|${input}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // murmur3 fmix32
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

function categoryColor(category: string): string {
  return MEMORY_CATEGORY_COLORS[category] ?? "#94a3b8";
}

/** 分类 → 簇心：围成一圈，y 稍微错开，避免看起来像平面圆环 */
function categoryCenters(
  nodes: MemoryGraphNode[],
  radius = 8.6,
): Map<string, THREE.Vector3> {
  const categories = [...new Set(nodes.map((n) => n.category))];
  const map = new Map<string, THREE.Vector3>();
  categories.forEach((c, i) => {
    const a = (i / Math.max(1, categories.length)) * Math.PI * 2 - Math.PI / 2;
    map.set(
      c,
      new THREE.Vector3(
        Math.cos(a) * radius,
        Math.sin(i * 2.1) * 1.3,
        Math.sin(a) * radius,
      ),
    );
  });
  return map;
}

/**
 * 每个分类一团，团内再按「相近摘要」分子簇，重要度决定离簇心的远近。
 *
 * 注意 fill 系数：如果所有点都落在同一个半径上，它们会贴在球壳表面，
 * 连线就变成多边形的边（看起来像风筝骨架）。用 fill 把点填进体积里，
 * 连线才会散开成「星团内部的丝」。
 */
function layoutNodes(nodes: MemoryGraphNode[]): THREE.Vector3[] {
  const centers = categoryCenters(nodes);

  const topicOffset = new Map<string, THREE.Vector3>();
  [...new Set(nodes.map((n) => `${n.category}:${n.summary.slice(0, 12)}`))].forEach(
    (t) => {
      const a = hash01(t, 11) * Math.PI * 2;
      const r = 1.1 + hash01(t, 12) * 2.3;
      topicOffset.set(
        t,
        new THREE.Vector3(
          Math.cos(a) * r,
          (hash01(t, 13) - 0.5) * 2.0,
          Math.sin(a) * r,
        ),
      );
    },
  );

  return nodes.map((node) => {
    const c = (centers.get(node.category) ?? new THREE.Vector3()).clone();
    c.add(
      topicOffset.get(`${node.category}:${node.summary.slice(0, 12)}`) ??
        new THREE.Vector3(),
    );

    const dir = new THREE.Vector3(
      hash01(node.id, 21) - 0.5,
      hash01(node.id, 22) - 0.5,
      hash01(node.id, 23) - 0.5,
    ).normalize();
    // 越重要越靠近簇心：簇心天然是「最要紧的那几条记忆」
    const reach = 0.45 + (1 - node.importance) * 3.6 + hash01(node.id, 24) * 0.9;
    const fill = 0.28 + Math.pow(hash01(node.id, 25), 0.55) * 0.9;
    return c.addScaledVector(dir, reach * fill);
  });
}

// ===========================================================================
// 贴图 / shader
// ===========================================================================

/** 径向渐变贴图：光晕、星云、星尘共用一张 */
function createRadialTexture(stops: Array<[number, string]>): THREE.Texture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2,
  );
  stops.forEach(([offset, color]) => g.addColorStop(offset, color));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

const STAR_VERT = `
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aPhase;
  attribute float aHl;
  attribute float aSpike;
  uniform float uPixelRatio;
  uniform float uTime;
  uniform float uScale;
  varying vec3 vColor;
  varying float vHl;
  varying float vFade;
  varying float vSpike;
  void main() {
    vColor = aColor;
    vHl = aHl;
    vSpike = aSpike;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float dist = -mv.z;
    // 远处更暗更小：给三维纵深，避免前后节点糊在同一平面
    vFade = clamp(1.0 - smoothstep(22.0, 60.0, dist), 0.4, 1.0);
    float twinkle = 0.9 + 0.1 * sin(uTime * 1.5 + aPhase * 6.283);
    float boost = 1.0 + aHl * 0.75;
    gl_PointSize = aSize * boost * twinkle * vFade * uPixelRatio * (uScale / dist);
    gl_Position = projectionMatrix * mv;
  }
`;

const STAR_FRAG = `
  varying vec3 vColor;
  varying float vHl;
  varying float vFade;
  varying float vSpike;
  void main() {
    vec2 p = gl_PointCoord - vec2(0.5);
    float d = length(p) * 2.0;
    if (d > 1.0) discard;
    float core = smoothstep(0.30, 0.0, d);
    float halo = pow(max(0.0, 1.0 - d), 3.4);

    // 十字星芒：只给最重要的那几颗，像望远镜拍出来的衍射尖
    float spike = 0.0;
    if (vSpike > 0.5) {
      float sx = exp(-abs(p.x) * 46.0) * smoothstep(0.5, 0.05, abs(p.y));
      float sy = exp(-abs(p.y) * 46.0) * smoothstep(0.5, 0.05, abs(p.x));
      spike = (sx + sy) * 0.55;
    }

    vec3 hot = mix(vColor, vec3(1.0), core * 0.42);
    hot = mix(hot, vec3(1.0), vHl * 0.3);
    float alpha = (core * 0.95 + halo * 0.6) * vFade + spike;
    gl_FragColor = vec4(hot * (1.0 + vHl * 0.5), alpha);
  }
`;

const LINK_VERT = `
  attribute float aAlpha;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vColor = color;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vAlpha = aAlpha * clamp(1.0 - smoothstep(24.0, 60.0, -mv.z), 0.3, 1.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const LINK_FRAG = `
  uniform float uOpacity;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    gl_FragColor = vec4(vColor, vAlpha * uOpacity);
  }
`;

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
  disposeObject(nodePoints);
  disposeObject(linkLines);
  disposeObject(hazeGroup);
  nodePoints = null;
  nodeMaterial = null;
  linkLines = null;
  linkMaterial = null;
  linkAlphaAttr = null;
  hazeGroup = null;
}

function buildHaze(
  nodes: MemoryGraphNode[],
  centers: Map<string, THREE.Vector3>,
  texture: THREE.Texture,
) {
  if (!scene) return;
  const group = new THREE.Group();

  // 每个分类一团同色色雾：让「簇」有体积，而不是一串散点
  const counts = new Map<string, number>();
  nodes.forEach((n) => counts.set(n.category, (counts.get(n.category) ?? 0) + 1));

  centers.forEach((center, category) => {
    const count = counts.get(category) ?? 0;
    if (count === 0) return;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: texture,
        color: new THREE.Color(categoryColor(category)),
        transparent: true,
        // 条目越多雾越浓，但封顶，避免大类糊成一坨
        opacity: 0.055 + Math.min(0.05, count * 0.0015),
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
      }),
    );
    sprite.position.copy(center);
    sprite.scale.setScalar(9 + Math.min(8, count * 0.06));
    group.add(sprite);
  });

  // 整体一层极淡的紫色底雾，把空黑背景托出「深空」感
  const base = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      color: 0x3b1d8f,
      transparent: true,
      opacity: 0.32,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    }),
  );
  base.scale.setScalar(52);
  base.position.set(0, 0, -8);
  group.add(base);

  scene.add(group);
  hazeGroup = group;
}

function buildNodes(texture: THREE.Texture) {  if (!scene) return;
  const count = nodeList.length;
  const positions = layoutNodes(nodeList);

  indexById = new Map();
  positionById = new Map();
  baseColors = [];

  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const phase = new Float32Array(count);
  const hl = new Float32Array(count);
  const spike = new Float32Array(count);

  nodeList.forEach((node, i) => {
    const p = positions[i];
    pos.set([p.x, p.y, p.z], i * 3);
    positionById.set(node.id, p);
    indexById.set(node.id, i);

    const c = new THREE.Color(categoryColor(node.category));
    // 同色系内的轻微色相/明度抖动：一整簇同色会显得像串珠
    c.offsetHSL(
      (hash01(node.id, 42) - 0.5) * 0.045,
      0,
      (hash01(node.id, 43) - 0.5) * 0.12,
    );
    // 重要度也压一点亮度：次要记忆退成背景里的暗星，主角才立得住
    const bright = 0.55 + node.importance * 0.45;
    col.set([c.r * bright, c.g * bright, c.b * bright], i * 3);
    baseColors.push(c.r * bright, c.g * bright, c.b * bright);

    // 重要度 → 星等；连通度 → 再加一点，让「中心节点」自然更亮
    size[i] =
      (2.2 + Math.pow(node.importance, 1.2) * 7.0) *
      (1 + Math.min(node.degree, 4) * 0.06) *
      // 星等抖动：避免所有星一样大，看起来像按网格摆的串珠
      (0.72 + hash01(node.id, 41) * 0.56);
    phase[i] = hash01(node.id, 31);
    spike[i] = node.importance > 0.78 ? 1 : 0;
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
  geometry.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
  geometry.setAttribute("aPhase", new THREE.BufferAttribute(phase, 1));
  geometry.setAttribute("aHl", new THREE.BufferAttribute(hl, 1));
  geometry.setAttribute("aSpike", new THREE.BufferAttribute(spike, 1));

  nodeMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
      uTime: { value: 0 },
      uScale: { value: 78 },
    },
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  nodePoints = new THREE.Points(geometry, nodeMaterial);
  scene.add(nodePoints);

  // 星云要跟着簇心走，所以放在节点之后构建
  buildHaze(nodeList, categoryCenters(nodeList), texture);
}

function buildLinks() {
  if (!scene) return;
  const SEG = 12;
  const verts: number[] = [];
  const colors: number[] = [];
  const alphas: number[] = [];

  linkMeta = [];
  linkBaseAlpha = [];

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const ctrl = new THREE.Vector3();
  const p = new THREE.Vector3();

  for (const link of props.links) {
    const pa = positionById.get(link.source);
    const pb = positionById.get(link.target);
    if (!pa || !pb) continue;

    a.copy(pa);
    b.copy(pb);
    ctrl.addVectors(a, b).multiplyScalar(0.5);

    const dir = b.clone().sub(a);
    const len = dir.length();
    // 控制点只在盘面内偏移：上下翻越会让连线穿过整团，显得杂乱
    const perp = new THREE.Vector3(-dir.z, 0, dir.x).normalize();
    ctrl.addScaledVector(
      perp,
      (hash01(link.source + link.target, 7) - 0.5) * len * 0.22,
    );

    // 长连线更淡：短程关联是主要结构，跨类长线只做「远处的引力丝」
    const lenFalloff = 1 / (1 + len * 0.16);
    const startIndex = verts.length / 3;

    const srcNode = nodeList[indexById.get(link.source) ?? -1];
    const dstNode = nodeList[indexById.get(link.target) ?? -1];
    const ca = new THREE.Color(
      categoryColor(srcNode?.category ?? "OTHER"),
    );
    const cb = new THREE.Color(
      categoryColor(dstNode?.category ?? "OTHER"),
    );

    let prev: THREE.Vector3 | null = null;
    for (let s = 0; s <= SEG; s++) {
      const t = s / SEG;
      p.copy(a).multiplyScalar((1 - t) * (1 - t));
      p.addScaledVector(ctrl, 2 * (1 - t) * t);
      p.addScaledVector(b, t * t);

      if (prev) {
        verts.push(prev.x, prev.y, prev.z, p.x, p.y, p.z);
        // 颜色沿弧线从源端渐变到目标端
        const c1 = ca.clone().lerp(cb, Math.max(0, (s - 1) / SEG));
        const c2 = ca.clone().lerp(cb, t);
        colors.push(c1.r, c1.g, c1.b, c2.r, c2.g, c2.b);

        const w = Math.min(1, Math.max(0.2, link.weight)) * lenFalloff;
        alphas.push(w, w);
      }
      prev = p.clone();
    }

    linkMeta.push({
      a: link.source,
      b: link.target,
      start: startIndex,
      count: verts.length / 3 - startIndex,
    });
  }

  if (verts.length === 0) return;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  linkAlphaAttr = new THREE.Float32BufferAttribute(alphas, 1);
  geometry.setAttribute("aAlpha", linkAlphaAttr);

  linkBaseAlpha = alphas.slice();

  linkMaterial = new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: 0.032 } },
    vertexShader: LINK_VERT,
    fragmentShader: LINK_FRAG,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  linkLines = new THREE.LineSegments(geometry, linkMaterial);
  scene.add(linkLines);
}

// ===========================================================================
// 视觉状态：分类过滤 + 焦点高亮
// ===========================================================================

/**
 * 一次算完所有「谁亮谁暗」。
 *
 * 焦点优先级：悬停 > 选中。静息态连线几乎隐形（0.032），
 * 只有焦点节点及其邻居的连线会被提亮 —— 这样静态画面干净，
 * 交互时又能一眼看清「这条记忆和谁连着」。
 */
function refreshVisualState() {
  if (!nodePoints) return;

  const focusId = hoveredId.value || props.selectedId;
  const category = props.activeCategory;
  const neighbors = focusId ? neighborsOf.get(focusId) : undefined;

  const colAttr = nodePoints.geometry.getAttribute("aColor") as THREE.BufferAttribute;
  const hlAttr = nodePoints.geometry.getAttribute("aHl") as THREE.BufferAttribute;

  nodeList.forEach((node, i) => {
    const catOk = !category || node.category === category;

    let k = 1;
    let highlight = 0;

    if (!catOk) k *= 0.18;

    if (focusId) {
      if (node.id === focusId) {
        k = Math.max(k, 1.25);
        highlight = 1;
      } else if (neighbors?.has(node.id)) {
        k = Math.max(k, 1);
        highlight = 0.35;
      } else {
        k *= 0.16;
      }
    }

    colAttr.setXYZ(
      i,
      baseColors[i * 3] * k,
      baseColors[i * 3 + 1] * k,
      baseColors[i * 3 + 2] * k,
    );
    hlAttr.setX(i, highlight);
  });

  colAttr.needsUpdate = true;
  hlAttr.needsUpdate = true;

  if (linkAlphaAttr && linkMaterial) {
    linkMeta.forEach((meta) => {
      const catOkA =
        !category ||
        nodeList[indexById.get(meta.a) ?? -1]?.category === category;
      const catOkB =
        !category ||
        nodeList[indexById.get(meta.b) ?? -1]?.category === category;

      let factor = catOkA && catOkB ? 1 : 0;
      if (focusId) {
        const related = meta.a === focusId || meta.b === focusId;
        factor *= related ? 1 : 0.08;
      }

      for (let v = 0; v < meta.count; v++) {
        linkAlphaAttr!.setX(meta.start + v, linkBaseAlpha[meta.start + v] * factor);
      }
    });
    linkAlphaAttr.needsUpdate = true;
    linkMaterial.uniforms.uOpacity.value = focusId ? 0.55 : 0.032;
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
  if (!camera || !nodePoints) return null;
  updatePointer(event);
  raycaster.setFromCamera(pointer, camera);
  // 点的拾取半径是世界单位，跟 shader 里的屏幕像素尺寸无关，取个经验值
  raycaster.params.Points.threshold = 0.38;
  const hits = raycaster.intersectObject(nodePoints, false);
  const hit = hits[0];
  if (!hit || hit.index === undefined) return null;
  return nodeList[hit.index] ?? null;
}

/** 把节点世界坐标投到容器内的像素坐标，供浮动标签定位 */
function projectToScreen(position: THREE.Vector3) {
  const el = containerRef.value;
  if (!el || !camera) return null;
  const v = position.clone().project(camera);
  return {
    x: ((v.x + 1) / 2) * el.clientWidth,
    y: ((1 - v.y) / 2) * el.clientHeight,
  };
}

function updateTip(node: MemoryGraphNode) {
  const pos = positionById.get(node.id);
  if (!pos) return;
  const screen = projectToScreen(pos);
  if (!screen) return;
  tip.value = {
    x: screen.x,
    y: screen.y,
    label: MEMORY_CATEGORY_LABELS[node.category] ?? node.category,
    text: node.summary,
    color: categoryColor(node.category),
  };
}

function onPointerMove(event: PointerEvent) {
  const node = pickNode(event);
  const nextId = node?.id ?? "";
  if (nextId === hoveredId.value) {
    // 同一节点上继续移动，标签跟随（相机会转，位置会漂）
    if (node) updateTip(node);
    return;
  }

  hoveredId.value = nextId;
  if (node) updateTip(node);
  else tip.value = null;

  // 悬停时暂停自转：否则标签跟着转，读不了
  if (controls) controls.autoRotate = nextId === "";

  refreshVisualState();
  const el = containerRef.value;
  if (el) el.style.cursor = nextId ? "pointer" : "grab";
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
  if (!hoveredId.value) return;
  hoveredId.value = "";
  tip.value = null;
  if (controls) controls.autoRotate = true;
  refreshVisualState();
  const el = containerRef.value;
  if (el) el.style.cursor = "grab";
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
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  el.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 400);
  camera.position.set(0, 16, 23);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.rotateSpeed = 0.55;
  controls.zoomSpeed = 0.8;
  controls.minDistance = 8;
  controls.maxDistance = 90;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.22;
  controls.target.set(0, 0, 0);

  // 辉光后处理：没有这一步，星点只是「彩色圆点」，有了才像真的在发光
  composer = new EffectComposer(renderer);
  composer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  composer.setSize(width, height);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(
    new UnrealBloomPass(new THREE.Vector2(width, height), 0.88, 0.75, 0.15),
  );
  composer.addPass(new OutputPass());

  softTexture = createRadialTexture([
    [0, "rgba(255,255,255,0.85)"],
    [0.35, "rgba(255,255,255,0.28)"],
    [0.7, "rgba(255,255,255,0.06)"],
    [1, "rgba(255,255,255,0)"],
  ]);

  buildBackgroundStars(softTexture);

  // 中心的一层柔光，给画面一个「引力中心」，不画实体球
  coreGroup = new THREE.Group();
  const coreGlow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: softTexture,
      color: 0xa78bfa,
      transparent: true,
      opacity: 0.16,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    }),
  );
  coreGlow.scale.setScalar(16);
  coreGroup.add(coreGlow);
  scene.add(coreGroup);

  nodeList = props.nodes;
  rebuild();

  el.addEventListener("pointermove", onPointerMove);
  el.addEventListener("pointerdown", onPointerDown);
  el.addEventListener("pointerup", onPointerUp);
  el.addEventListener("pointerleave", onPointerLeave);

  resizeObserver = new ResizeObserver(() => {
    if (!renderer || !camera || !composer || !containerRef.value) return;
    const w = containerRef.value.clientWidth;
    const h = containerRef.value.clientHeight;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h);
    composer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  });
  resizeObserver.observe(el);

  ready.value = true;
  animate();
}

/** 远景星尘：给「宇宙」纵深，不参与交互 */
function buildBackgroundStars(texture: THREE.Texture) {
  if (!scene) return;
  const COUNT = 1400;
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(COUNT * 3);
  const colors = new Float32Array(COUNT * 3);

  for (let i = 0; i < COUNT; i++) {
    const r = 55 + Math.random() * 90;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(1 - 2 * Math.random());
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi) * 0.7;
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);

    const c = new THREE.Color(0xffffff).lerp(new THREE.Color(0x93a5ff), Math.random());
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }

  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  scene.add(
    new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        size: 1.0,
        vertexColors: true,
        transparent: true,
        opacity: 0.3,
        sizeAttenuation: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        map: texture,
      }),
    ),
  );
}

/** 数据变了就整体重建（节点 + 星云 + 连线），再重算一次亮暗 */
function rebuild() {
  clearGraph();
  nodeList = props.nodes;

  neighborsOf = new Map();
  for (const link of props.links) {
    if (!neighborsOf.has(link.source)) neighborsOf.set(link.source, new Set());
    if (!neighborsOf.has(link.target)) neighborsOf.set(link.target, new Set());
    neighborsOf.get(link.source)!.add(link.target);
    neighborsOf.get(link.target)!.add(link.source);
  }

  if (nodeList.length === 0) return;

  if (!softTexture) return;
  buildNodes(softTexture);
  buildLinks();
  refreshVisualState();
}

function animate() {
  rafId = requestAnimationFrame(animate);
  if (!renderer || !composer || !camera) return;
  if (document.hidden) return; // 页面不可见时不渲染，省电

  const t = performance.now() / 1000;

  if (nodeMaterial) nodeMaterial.uniforms.uTime.value = t;
  if (coreGroup) {
    const glow = coreGroup.children[0] as THREE.Sprite | undefined;
    if (glow) glow.material.opacity = 0.14 + Math.sin(t * 0.9) * 0.04;
  }

  controls?.update();
  composer.render();
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
  disposeObject(coreGroup);
  coreGroup = null;
  softTexture?.dispose();
  softTexture = null;
  composer?.dispose();
  composer = null;
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
    rebuild();
  },
  { deep: false },
);

watch(
  () => [props.activeCategory, props.selectedId],
  () => refreshVisualState(),
);
</script>

<template>
  <div ref="containerRef" class="memory-graph">
    <div v-if="nodes.length === 0" class="empty-orb">
      <div class="orb-core">
        <i class="ring r1"></i>
        <i class="ring r2"></i>
        <i class="ring r3"></i>
      </div>
      <p>这里还是一张空白星图</p>
      <span>和小蝶聊几句，值得记住的事会在这里点亮成星</span>
    </div>

    <transition name="tip">
      <div
        v-if="tip"
        class="star-tip"
        :style="{ left: `${tip.x}px`, top: `${tip.y}px` }"
      >
        <span class="tip-cat" :style="{ color: tip.color }">{{ tip.label }}</span>
        <span class="tip-text">{{ tip.text }}</span>
      </div>
    </transition>
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

  /* 极淡的颗粒：纯色渐变容易显得「塑料」，一层噪点能压出胶片质感 */
  &::after {
    content: "";
    position: absolute;
    inset: 0;
    pointer-events: none;
    opacity: 0.035;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3'/%3E%3C/filter%3E%3Crect width='120' height='120' filter='url(%23n)'/%3E%3C/svg%3E");
    mix-blend-mode: overlay;
  }
}

/* ---------- 空状态：一圈静默的轨道，比一个发光球体更克制 ---------- */
.empty-orb {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: @space-2;
  color: rgba(226, 232, 240, 0.72);
  text-align: center;
  pointer-events: none;

  .orb-core {
    position: relative;
    width: 120px;
    height: 120px;
    margin-bottom: @space-4;

    &::after {
      content: "";
      position: absolute;
      left: 50%;
      top: 50%;
      width: 8px;
      height: 8px;
      margin: -4px 0 0 -4px;
      border-radius: 50%;
      background: #fff;
      box-shadow:
        0 0 12px 4px rgba(196, 181, 253, 0.85),
        0 0 42px 14px rgba(124, 92, 252, 0.45);
      animation: core-pulse 3.4s ease-in-out infinite;
    }

    .ring {
      position: absolute;
      inset: 0;
      border-radius: 50%;
      border: 1px solid rgba(167, 139, 250, 0.22);

      &.r2 {
        inset: 18px;
        border-color: rgba(167, 139, 250, 0.14);
      }

      &.r3 {
        inset: 36px;
        border-color: rgba(167, 139, 250, 0.09);
      }
    }
  }

  p {
    font-size: @font-sm;
    font-weight: 600;
    margin: 0;
    letter-spacing: 0.02em;
  }

  span {
    font-size: @font-xs;
    color: rgba(148, 163, 184, 0.8);
  }
}

@keyframes core-pulse {
  0%,
  100% {
    opacity: 0.75;
    transform: scale(0.92);
  }
  50% {
    opacity: 1;
    transform: scale(1.12);
  }
}

/* ---------- 悬停标签：贴着星点，而不是甩在屏幕底部 ---------- */
.star-tip {
  position: absolute;
  transform: translate(-50%, calc(-100% - 18px));
  max-width: 260px;
  padding: 6px 10px;
  border-radius: @radius-lg;
  background: rgba(10, 14, 26, 0.82);
  border: 1px solid rgba(148, 163, 184, 0.2);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(10px);
  pointer-events: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
  z-index: 2;

  .tip-cat {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
  }

  .tip-text {
    font-size: @font-xs;
    line-height: 1.5;
    color: rgba(226, 232, 240, 0.9);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
}

.tip-enter-active,
.tip-leave-active {
  transition: opacity 120ms ease, transform 120ms ease;
}

.tip-enter-from,
.tip-leave-to {
  opacity: 0;
  transform: translate(-50%, calc(-100% - 10px));
}
</style>
