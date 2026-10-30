// v8：簇状星云布局（每个分类一团，重要度决定离心距离）+ 星点 shader + 弧线 + Bloom
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { makeMockData } from "./mock.js";

const MEMORY_CATEGORY_COLORS = {
  PREFERENCE: "#5eead4",
  FACT: "#7dd3fc",
  TASK: "#fbbf24",
  EVENT: "#c4b5fd",
  EMOTION: "#f9a8d4",
  OTHER: "#94a3b8",
};

function hash01(input, salt = 0) {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

function categoryCenters(nodes, radius = 7.2) {
  const categories = [...new Set(nodes.map((n) => n.category))];
  const map = new Map();
  categories.forEach((c, i) => {
    const a = (i / categories.length) * Math.PI * 2 - Math.PI / 2;
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

function layoutNodes(nodes) {
  const centers = categoryCenters(nodes);
  const topicOffset = new Map();
  [...new Set(nodes.map((n) => n.topic))].forEach((t) => {
    const a = hash01(t, 11) * Math.PI * 2;
    const r = 1.1 + hash01(t, 12) * 2.3;
    topicOffset.set(
      t,
      new THREE.Vector3(Math.cos(a) * r, (hash01(t, 13) - 0.5) * 2.0, Math.sin(a) * r),
    );
  });

  return nodes.map((node) => {
    const c = centers.get(node.category).clone();
    c.add(topicOffset.get(node.topic));
    // 越重要越靠近簇心
    const dir = new THREE.Vector3(
      hash01(node.id, 21) - 0.5,
      (hash01(node.id, 22) - 0.5) * 1.0,
      hash01(node.id, 23) - 0.5,
    ).normalize();
    const reach = 0.45 + (1 - node.importance) * 4.4 + hash01(node.id, 24) * 0.9;
    // 0..1 的体积填充系数：避免所有点都贴在球壳上（那样连线会连成多边形）
    const fill = 0.28 + Math.pow(hash01(node.id, 25), 0.55) * 0.9;
    return c.addScaledVector(dir, reach * fill);
  });
}

function radialTexture(stops) {
  const size = 256;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  stops.forEach(([o, col]) => g.addColorStop(o, col));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
}

const STAR_VERT = `
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aPhase;
  attribute float aHl;
  uniform float uPixelRatio;
  uniform float uTime;
  uniform float uScale;
  varying vec3 vColor;
  varying float vHl;
  varying float vFade;
  void main() {
    vColor = aColor;
    vHl = aHl;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float dist = -mv.z;
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
  void main() {
    vec2 p = gl_PointCoord - vec2(0.5);
    float d = length(p) * 2.0;
    if (d > 1.0) discard;
    float core = smoothstep(0.30, 0.0, d);
    float halo = pow(max(0.0, 1.0 - d), 3.4);
    vec3 hot = mix(vColor, vec3(1.0), core * 0.6);
    hot = mix(hot, vec3(1.0), vHl * 0.3);
    float alpha = (core * 0.95 + halo * 0.6) * vFade;
    gl_FragColor = vec4(hot * (1.0 + vHl * 0.5), alpha);
  }
`;

export function mountGraph(el) {
  const width = el.clientWidth || 1100;
  const height = el.clientHeight || 660;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  el.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 400);
  camera.position.set(0, 20, 27);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.minDistance = 8;
  controls.maxDistance = 90;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.22;

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(width, height), 0.8, 0.72, 0.16);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  const softTex = radialTexture([
    [0, "rgba(255,255,255,0.85)"],
    [0.35, "rgba(255,255,255,0.28)"],
    [0.7, "rgba(255,255,255,0.06)"],
    [1, "rgba(255,255,255,0)"],
  ]);

  const data = makeMockData();
  const centers = categoryCenters(data.nodes);
  const positions = layoutNodes(data.nodes);
  const positionById = new Map();
  data.nodes.forEach((n, i) => positionById.set(n.id, positions[i]));

  // ---- 星云：每个分类一团色雾 ----
  centers.forEach((c, cat) => {
    const color = new THREE.Color(MEMORY_CATEGORY_COLORS[cat] ?? "#94a3b8");
    const sp = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: softTex,
        color,
        transparent: true,
        opacity: 0.09,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
      }),
    );
    sp.position.copy(c);
    sp.scale.setScalar(14);
    scene.add(sp);
  });
  const baseHaze = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: softTex,
      color: 0x3b1d8f,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    }),
  );
  baseHaze.scale.setScalar(52);
  baseHaze.position.set(0, 0, -6);
  scene.add(baseHaze);

  // ---- 背景星尘 ----
  const starGeo = new THREE.BufferGeometry();
  const sp2 = new Float32Array(1400 * 3);
  const sc = new Float32Array(1400 * 3);
  for (let i = 0; i < 1400; i++) {
    const r = 55 + Math.random() * 90;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(1 - 2 * Math.random());
    sp2[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    sp2[i * 3 + 1] = r * Math.cos(phi) * 0.7;
    sp2[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    const col = new THREE.Color(0xffffff).lerp(new THREE.Color(0x93a5ff), Math.random());
    sc[i * 3] = col.r;
    sc[i * 3 + 1] = col.g;
    sc[i * 3 + 2] = col.b;
  }
  starGeo.setAttribute("position", new THREE.BufferAttribute(sp2, 3));
  starGeo.setAttribute("color", new THREE.BufferAttribute(sc, 3));
  scene.add(
    new THREE.Points(
      starGeo,
      new THREE.PointsMaterial({
        size: 1.0,
        vertexColors: true,
        transparent: true,
        opacity: 0.3,
        sizeAttenuation: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        map: softTex,
      }),
    ),
  );

  // ---- 中心核心 ----
  const coreGroup = new THREE.Group();
  const haloA = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: softTex,
      color: 0xa78bfa,
      transparent: true,
      opacity: 0.32,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  haloA.scale.setScalar(16);
  coreGroup.add(haloA);
  scene.add(coreGroup);

  // ---- 节点 ----
  const nPos = new Float32Array(data.nodes.length * 3);
  const nCol = new Float32Array(data.nodes.length * 3);
  const nSize = new Float32Array(data.nodes.length);
  const nPhase = new Float32Array(data.nodes.length);
  const nHl = new Float32Array(data.nodes.length);

  data.nodes.forEach((n, i) => {
    const p = positions[i];
    nPos.set([p.x, p.y, p.z], i * 3);
    const c = new THREE.Color(MEMORY_CATEGORY_COLORS[n.category] ?? "#94a3b8");
    nCol.set([c.r, c.g, c.b], i * 3);
    nSize[i] = (2.4 + Math.pow(n.importance, 1.25) * 6.4) * (1 + Math.min(n.degree, 4) * 0.06);
    nPhase[i] = Math.random();
  });

  const nodeGeo = new THREE.BufferGeometry();
  nodeGeo.setAttribute("position", new THREE.BufferAttribute(nPos, 3));
  nodeGeo.setAttribute("aColor", new THREE.BufferAttribute(nCol, 3));
  nodeGeo.setAttribute("aSize", new THREE.BufferAttribute(nSize, 1));
  nodeGeo.setAttribute("aPhase", new THREE.BufferAttribute(nPhase, 1));
  nodeGeo.setAttribute("aHl", new THREE.BufferAttribute(nHl, 1));

  const nodeMat = new THREE.ShaderMaterial({
    uniforms: { uPixelRatio: { value: 1 }, uTime: { value: 0 }, uScale: { value: 78 } },
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  scene.add(new THREE.Points(nodeGeo, nodeMat));

  // ---- 连线 ----
  const SEG = 12;
  const linkVerts = [];
  const linkColors = [];
  const linkAlpha = [];
  const linkMeta = []; // { a, b, start, count }
  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();
  const tmpC = new THREE.Vector3();
  const tmpP = new THREE.Vector3();

  data.links.forEach((link) => {
    const a = positionById.get(link.source);
    const b = positionById.get(link.target);
    if (!a || !b) return;
    const segStart = linkVerts.length / 3;
    tmpA.copy(a);
    tmpB.copy(b);
    tmpC.addVectors(tmpA, tmpB).multiplyScalar(0.5);
    const dir = tmpB.clone().sub(tmpA);
    const len = dir.length();
    const perp = new THREE.Vector3(-dir.z, 0, dir.x).normalize();
    tmpC.addScaledVector(perp, (hash01(link.source + link.target, 7) - 0.5) * len * 0.22);

    const lenFalloff = 1 / (1 + len * 0.16);
    const srcNode = data.nodes.find((n) => n.id === link.source);
    const dstNode = data.nodes.find((n) => n.id === link.target);
    const ca = new THREE.Color(MEMORY_CATEGORY_COLORS[srcNode.category]);
    const cb = new THREE.Color(MEMORY_CATEGORY_COLORS[dstNode.category]);

    let prev = null;
    for (let s = 0; s <= SEG; s++) {
      const t = s / SEG;
      tmpP.copy(tmpA).multiplyScalar((1 - t) * (1 - t));
      tmpP.addScaledVector(tmpC, 2 * (1 - t) * t);
      tmpP.addScaledVector(tmpB, t * t);
      if (prev) {
        linkVerts.push(prev.x, prev.y, prev.z, tmpP.x, tmpP.y, tmpP.z);
        const c1 = ca.clone().lerp(cb, Math.max(0, (s - 1) / SEG));
        const c2 = ca.clone().lerp(cb, t);
        linkColors.push(c1.r, c1.g, c1.b, c2.r, c2.g, c2.b);
        const w = Math.min(1, Math.max(0.2, link.weight)) * lenFalloff;
        linkAlpha.push(w, w);
      }
      prev = tmpP.clone();
    }
    linkMeta.push({ a: link.source, b: link.target, start: segStart, count: linkVerts.length / 3 - segStart });
  });

  const linkGeo = new THREE.BufferGeometry();
  linkGeo.setAttribute("position", new THREE.Float32BufferAttribute(linkVerts, 3));
  linkGeo.setAttribute("color", new THREE.Float32BufferAttribute(linkColors, 3));
  linkGeo.setAttribute("aAlpha", new THREE.Float32BufferAttribute(linkAlpha, 1));

  const linkMat = new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: 0.045 } },
    vertexShader: `
      attribute float aAlpha;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vColor = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vAlpha = aAlpha * clamp(1.0 - smoothstep(24.0, 60.0, -mv.z), 0.3, 1.0);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      uniform float uOpacity;
      varying vec3 vColor;
      varying float vAlpha;
      void main() { gl_FragColor = vec4(vColor, vAlpha * uOpacity); }
    `,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  scene.add(new THREE.LineSegments(linkGeo, linkMat));

  // ---- 焦点：点选/悬停后「点亮星座」----
  const indexById = new Map();
  data.nodes.forEach((n, i) => indexById.set(n.id, i));
  const neighborsOf = new Map();
  data.links.forEach((l) => {
    if (!neighborsOf.has(l.source)) neighborsOf.set(l.source, new Set());
    if (!neighborsOf.has(l.target)) neighborsOf.set(l.target, new Set());
    neighborsOf.get(l.source).add(l.target);
    neighborsOf.get(l.target).add(l.source);
  });
  const baseColors = new Float32Array(nCol);

  function applyFocus(id) {
    const focused = id ? indexById.get(id) : undefined;
    const nb = id ? neighborsOf.get(id) ?? new Set() : new Set();
    const colAttr = nodeGeo.getAttribute("aColor");
    const hlAttr = nodeGeo.getAttribute("aHl");

    data.nodes.forEach((n, i) => {
      const isFocus = i === focused;
      const isNb = nb.has(n.id);
      const k = !id ? 1 : isFocus ? 1.15 : isNb ? 0.95 : 0.3;
      colAttr.setXYZ(i, baseColors[i * 3] * k, baseColors[i * 3 + 1] * k, baseColors[i * 3 + 2] * k);
      hlAttr.setX(i, isFocus ? 1 : isNb ? 0.35 : 0);
    });
    colAttr.needsUpdate = true;
    hlAttr.needsUpdate = true;

    const alphaAttr = linkGeo.getAttribute("aAlpha");
    linkMeta.forEach((m) => {
      const on = !id || m.a === id || m.b === id;
      const base = on ? 1 : 0.1;
      for (let v = 0; v < m.count; v++) alphaAttr.setX(m.start + v, linkAlpha[m.start + v] * base);
    });
    alphaAttr.needsUpdate = true;
    linkMat.uniforms.uOpacity.value = id ? 0.5 : 0.045;
  }
  window.__focus = applyFocus;

  const clock = new THREE.Clock();
  function animate() {
    requestAnimationFrame(animate);
    const t = clock.getElapsedTime();
    nodeMat.uniforms.uTime.value = t;
    haloA.material.opacity = 0.16 + Math.sin(t * 0.9) * 0.05;
    controls.update();
    composer.render();
  }
  animate();
}
