(() => {
"use strict";
if (!window.THREE) { document.body.insertAdjacentHTML("beforeend",'<p class="err">3D表示の部品を読み込めませんでした。再読み込みしてください。</p>'); return; }

/* ===== 天体プロフィール：天体固有の数字はここだけ ===== */
const EARTH = Object.freeze({ name: "地球", radiusM: 6371000, axialTiltDeg: 23.44 });

/* ===== データ目録（Manifest）：出典・時刻・種別はすべてここから =====
   まず自動取得の最新（data/latest）を探し、なければサンプル（data/sample）で動く。 */
const SOURCES = ["data/latest/", "data/sample/"];
async function getJSON(url) { const r = await fetch(url, { cache: "no-cache" }); if (!r.ok) throw new Error(url + " " + r.status); return r.json(); }
async function getBin(url) { const r = await fetch(url); if (!r.ok) throw new Error(url + " " + r.status); return r.arrayBuffer(); }
async function loadCatalog() {
  let base = null, manifest = null;
  for (const b of SOURCES) { try { manifest = await getJSON(b + "manifest.json"); base = b; break; } catch (e) { console.info("見つからない:", b, e.message); } }
  if (!manifest) throw new Error("manifest.json がどこにもありません");
  const bufs = {}, extra = {};
  const [land, coast] = await Promise.all([getBin("data/land.bin"), getBin("data/coast.bin")]);
  await Promise.all(Object.entries(manifest.layers).map(async ([id, L]) => {
    bufs[id] = await getBin(base + L.file);
    if (L.meta.licenseFile) { try { const r = await fetch(base + L.meta.licenseFile); if (r.ok) extra[id] = await r.text(); } catch (_) {} }
  }));
  const MAP = { land: { meta: { title: "陸地", kind: "観測（地図）", credit: "Natural Earth 1:50m（パブリックドメイン）" } },
                coast: { meta: { title: "海岸線", kind: "観測（地図）", credit: "Natural Earth 1:50m（パブリックドメイン）" } } };
  const mapBufs = { land, coast };
  return {
    mode: manifest.mode, generatedAt: manifest.generatedAt ? new Date(manifest.generatedAt) : null, base,
    has: id => id in manifest.layers,
    meta: id => (manifest.layers[id] || MAP[id]).meta,
    license: id => extra[id] || null,
    gridInfo: id => manifest.layers[id].grid,
    /** 線・面の頂点列（緯度経度）。区切りごとに配列を返す */
    paths(id) { const raw = new Int16Array(mapBufs[id]), s = 100, out = []; let cur = []; for (let i = 0; i < raw.length; i += 2) { if (raw[i] === 32767) { if (cur.length) out.push(cur); cur = []; continue; } cur.push([raw[i] / s, raw[i+1] / s]); } if (cur.length) out.push(cur); return out; },
    /** 保存形式（圧縮）を物理量に戻す係。端子はこの形式を知らない */
    scalarValues(id) {
      const q = new Uint8Array(bufs[id]), e = this.meta(id).encoding, out = new Float32Array(q.length);
      const L = Math.log1p(e.max);
      const decoders = { log1p: c => c === e.missing ? NaN : c === e.zero ? 0 : Math.expm1((c - 1) / e.levels * L) };
      const dec = decoders[e.type]; for (let i = 0; i < q.length; i++) out[i] = dec(q[i]);
      return out;
    },
    /** そのデータが時計の時刻に有効か（一時点 or 期間。期間は終わりの時刻も含む） */
    validAt(id, t) { const m = this.meta(id); if (m.validFrom) return new Date(m.validFrom) <= t && t <= new Date(m.validTo); return m.validTime ? +new Date(m.validTime) === +t : true; },
    grid(id) { return { grid: manifest.layers[id].grid, raw: new Int16Array(bufs[id]), meta: this.meta(id) }; },
  };
}

let Catalog;
(async () => {
try { Catalog = await loadCatalog(); }
catch (e) { document.getElementById("loading").textContent = "データを読み込めませんでした（" + e.message + "）"; return; }
document.getElementById("loading").remove();

/* ===== 地球儀の時計（ひとつだけ）：風の有効時刻で止める（再生・予報送りは後から） ===== */
const Clock = { time: new Date(Catalog.meta("wind-10m").validTime), now() { return this.time; } };

/* ===== 流れ場の問い合わせ口（Flow Field Interface） ===== */
function createGridFlowField(id) {
  const { grid: g, raw, meta } = Catalog.grid(id);
  const U = new Float32Array(g.nx * g.ny), V = new Float32Array(g.nx * g.ny);
  for (let i = 0; i < U.length; i++) { U[i] = raw[2*i] / g.scale; V[i] = raw[2*i+1] / g.scale; }
  return {
    meta,
    sample(lonDeg, latDeg /*, time */) {
      let x = (((lonDeg - g.lo1) % 360) + 360) % 360 / g.dx, y = (g.la1 - latDeg) / g.dy;
      if (y < 0) y = 0; if (y > g.ny - 1) y = g.ny - 1;
      const i0 = Math.floor(x) % g.nx, i1 = (i0 + 1) % g.nx, fx = x - Math.floor(x);
      const j0 = Math.floor(y), j1 = Math.min(j0 + 1, g.ny - 1), fy = y - j0;
      const a = j0*g.nx+i0, b = j0*g.nx+i1, c = j1*g.nx+i0, d = j1*g.nx+i1;
      return [ (U[a]*(1-fx)+U[b]*fx)*(1-fy) + (U[c]*(1-fx)+U[d]*fx)*fy,
               (V[a]*(1-fx)+V[b]*fx)*(1-fy) + (V[c]*(1-fx)+V[d]*fx)*fy ];
    },
  };
}

/* ===== 値の場の問い合わせ口（Scalar Field Interface）
   返すのは「その地点の値」か、データがないなら null。0 とは区別する。 ===== */
function createGridScalarField(id) {
  const g = Catalog.gridInfo(id), meta = Catalog.meta(id), vals = Catalog.scalarValues(id);
  const point = g.registration === "point";   // 格子点の値（GFS）か、升目の値（IMERG）か
  const at = (i, j) => vals[j * g.nx + ((i % g.nx) + g.nx) % g.nx];
  return {
    id, meta,
    sample(lonDeg, latDeg /*, time */) {
      const fx = (((lonDeg - g.lon0) % 360) + 360) % 360 / g.dx, fy = (g.lat0 - latDeg) / g.dy;
      if (!point) {
        let y = Math.floor(fy); if (y < 0) y = 0; if (y > g.ny - 1) y = g.ny - 1;
        const v = at(Math.floor(fx), y); return Number.isNaN(v) ? null : v;
      }
      const y = Math.min(Math.max(fy, 0), g.ny - 1), i0 = Math.floor(fx), j0 = Math.min(Math.floor(y), g.ny - 2);
      const tx = fx - i0, ty = y - j0, a = at(i0, j0), b = at(i0 + 1, j0), c = at(i0, j0 + 1), d = at(i0 + 1, j0 + 1);
      if ([a, b, c, d].some(Number.isNaN)) { const v = at(Math.round(fx), Math.round(y)); return Number.isNaN(v) ? null : v; }
      return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    },
  };
}

/* ===== 太陽位置（天文・幾何の計算） ===== */
function subsolarPoint(date) {
  const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
  const L = (280.460 + 0.9856474 * n) % 360, g = ((357.528 + 0.9856003 * n) % 360) * Math.PI / 180;
  const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2*g)) * Math.PI / 180;
  const eps = (EARTH.axialTiltDeg - 0.0000004 * n) * Math.PI / 180;
  const decl = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const gmst = (280.46061837 + 360.98564736629 * n) % 360;
  let lon = ra * 180 / Math.PI - gmst; lon = ((lon + 540) % 360) - 180;
  return { lat: decl * 180 / Math.PI, lon };
}

const D2R = Math.PI / 180;
function toXYZ(latDeg, lonDeg, r, out, o) {
  const la = latDeg * D2R, lo = lonDeg * D2R, c = Math.cos(la);
  out[o] = r * c * Math.cos(lo); out[o+1] = r * Math.sin(la); out[o+2] = -r * c * Math.sin(lo);
}

/* ===== 風速 → 線の色（凡例と描画で同じ表を使う） ===== */
const LINE_STOPS = [
  [0,  [0.42, 0.52, 0.74]],
  [4,  [0.38, 0.74, 0.96]],
  [8,  [0.44, 0.92, 0.86]],
  [12, [0.72, 0.95, 0.54]],
  [16, [0.99, 0.87, 0.40]],
  [22, [1.00, 0.60, 0.30]],
  [30, [1.00, 0.40, 0.46]],
];

const field = createGridFlowField("wind-10m");
const stage = document.getElementById("stage");
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
stage.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 100);

/* ===== 静かな地球：海と陸だけ。色は風の線に任せる ===== */
function buildLandMask() {
  const W = 2048, H = 1024, cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d"); ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H); ctx.fillStyle = "#fff";
  const X = lon => (lon + 180) / 360 * W, Y = lat => (90 - lat) / 180 * H;
  for (const ring of Catalog.paths("land")) {
    const pts = []; let off = 0, prev = ring[0][0];
    for (const [lo, la] of ring) { const d = lo - prev; if (d > 180) off -= 360; else if (d < -180) off += 360; prev = lo; pts.push([lo + off, la]); }
    const span = pts[pts.length-1][0] - pts[0][0];
    if (Math.abs(span) > 300) { const pole = pts.reduce((s, p) => s + p[1], 0) / pts.length < 0 ? -90 : 90; pts.push([pts[pts.length-1][0], pole], [pts[0][0], pole]); }
    for (const shift of [-360, 0, 360]) {
      ctx.beginPath(); pts.forEach(([lo, la], k) => k ? ctx.lineTo(X(lo + shift), Y(la)) : ctx.moveTo(X(lo + shift), Y(la))); ctx.closePath(); ctx.fill();
    }
  }
  const tex = new THREE.CanvasTexture(cv); tex.generateMipmaps = false; tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
  return tex;
}
const sunDir = new THREE.Vector3();
const globe = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 96), new THREE.ShaderMaterial({
  uniforms: { uLand: { value: buildLandMask() }, uSun: { value: sunDir } },
  vertexShader: `varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D uLand; uniform vec3 uSun; varying vec3 vPos;
    const float PI = 3.141592653589793;
    void main(){
      vec3 n = normalize(vPos);
      float lat = asin(clamp(n.y,-1.0,1.0)), lon = atan(-n.z, n.x);
      float land = texture2D(uLand, vec2((lon+PI)/(2.0*PI), (lat+PI*0.5)/PI)).r;
      vec3 ocean = mix(vec3(0.030,0.062,0.118), vec3(0.040,0.090,0.160), 0.5 + 0.5*n.y*n.y);
      vec3 ground = vec3(0.105,0.130,0.160);
      vec3 col = mix(ocean, ground, land);
      float day = smoothstep(-0.10, 0.16, dot(n, normalize(uSun)));
      col *= mix(0.42, 1.45, day);
      float rim = dot(n, normalize(cameraPosition));
      col += vec3(0.05,0.10,0.20) * pow(1.0 - clamp(rim,0.0,1.0), 3.0) * (0.35 + 0.65*day);
      gl_FragColor = vec4(col, 1.0);
    }`,
}));
scene.add(globe);

/* ===== 値の面を描く係（Renderer）。色の意味は Visual Profile が決める ===== */
const RAIN_PROFILE = {
  label: "雨の色＝降水の強さ（mm/h）",
  stops: [[0.1,[0.82,0.87,1.00,0.12]],[1,[0.78,0.82,1.00,0.26]],[5,[0.74,0.66,1.00,0.40]],[15,[0.90,0.55,1.00,0.52]],[40,[1.00,0.43,0.78,0.62]]],   // 透け具合：下の風と地形が見えるように控えめ
  ticks: [0.1, 1, 5, 15, 40],
  /** 値の見せ方：単位・桁・「なし」の言い方・補足 */
  present: { name: "降水", units: "mm/h", digits: 1, below: [0.1, "0.1 mm/h 未満"], missing: "データなし" },
};
function presentValue(layer, v) {
  const p = layer.profile.present, m = layer.field.meta;
  const txt = v === null ? p.missing : v < p.below[0] ? p.below[1] : `${v.toFixed(p.digits)} ${p.units}`;
  const span = m.validFrom ? `${m.validFrom.slice(0,16).replace("T"," ")}〜${m.validTo.slice(11,16)} UTC` : "";
  return `${p.name} <span class="num">${txt}</span> <span style="color:var(--ink-faint)">（${m.kind}${span ? "・" + span : ""}）</span>`;
}
function rampRGBA(stops, v) {
  if (v < stops[0][0]) return null;
  for (let k = 1; k < stops.length; k++) if (v <= stops[k][0]) {
    const [a, ca] = stops[k-1], [b, cb] = stops[k], t = (Math.log(v) - Math.log(a)) / (Math.log(b) - Math.log(a));
    return ca.map((c, i) => c + (cb[i] - c) * t);
  }
  return stops[stops.length-1][1];
}
function createScalarLayer(field, profile) {
  const W = 1440, H = 720, cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d"), img = ctx.createImageData(W, H), px = img.data;
  for (let y = 0; y < H; y++) {
    const lat = 90 - (y + 0.5) / H * 180;
    for (let x = 0; x < W; x++) {
      const v = field.sample(-180 + (x + 0.5) / W * 360, lat, Clock.now());
      if (v === null) continue;                       // データなし：塗らない（晴れとは言わない）
      const c = rampRGBA(profile.stops, v); if (!c) continue;
      const p = (y * W + x) * 4; px[p] = c[0]*255; px[p+1] = c[1]*255; px[p+2] = c[2]*255; px[p+3] = c[3]*255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv); tex.generateMipmaps = false; tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1.0008, 128, 96), new THREE.ShaderMaterial({
    uniforms: { uTex: { value: tex } }, transparent: true, depthWrite: false,
    vertexShader: `varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform sampler2D uTex; varying vec3 vPos; const float PI = 3.141592653589793;
      void main(){ vec3 n = normalize(vPos); float lat = asin(clamp(n.y,-1.0,1.0)), lon = atan(-n.z, n.x);
        gl_FragColor = texture2D(uTex, vec2((lon+PI)/(2.0*PI), (lat+PI*0.5)/PI)); }`,
  }));
  mesh.renderOrder = 1; scene.add(mesh);
  return { id: field.id, mesh, field, profile, set visible(v) { mesh.visible = v; }, get visible() { return mesh.visible; } };
}
const SCALAR_LAYERS = [];   // 値の層は全部ここに並ぶ（重なり順も層が持つ）
if (Catalog.has("rain")) SCALAR_LAYERS.push(createScalarLayer(createGridScalarField("rain"), RAIN_PROFILE));

(function addCoast() {
  const seg = [];
  for (const line of Catalog.paths("coast")) for (let k = 1; k < line.length; k++) seg.push(line[k-1], line[k]);
  const pos = new Float32Array(seg.length * 3);
  seg.forEach(([lo, la], k) => toXYZ(la, lo, 1.0012, pos, k * 3));
  const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xa9b8d6, transparent: true, opacity: 0.28 })));
})();

/* ===== 見せる粒子（表示専用）：軌跡はGPUの中で年齢から薄くする =====
   粒子ごとに「いま進んだ一区間」だけを書き込み、古い区間は時間で消える。 */
const VisualParticles = (() => {
  const N = window.innerWidth < 700 ? 5200 : 9000;
  const SLOTS = 34;                 // 軌跡に残す区間数（フレーム）
  const STEP = 0.0115;              // 表示倍率：度 / (m/s) / フレーム
  const R = 1.0035;
  const lat = new Float32Array(N), lon = new Float32Array(N), age = new Float32Array(N), life = new Float32Array(N);
  const V = N * SLOTS * 2;
  const pos = new Float32Array(V * 3), birth = new Float32Array(V).fill(-1e6), spd = new Float32Array(V);
  const geo = new THREE.BufferGeometry();
  const aPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const aBirth = new THREE.BufferAttribute(birth, 1).setUsage(THREE.DynamicDrawUsage);
  const aSpd = new THREE.BufferAttribute(spd, 1).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("position", aPos); geo.setAttribute("aBirth", aBirth); geo.setAttribute("aSpeed", aSpd);
  const stopsGLSL = LINE_STOPS.map(([s, c], i) => `if (s <= ${s.toFixed(1)}) { ${i ? `float t=(s-${LINE_STOPS[i-1][0].toFixed(1)})/${(s - LINE_STOPS[i-1][0]).toFixed(1)}; return mix(vec3(${LINE_STOPS[i-1][1].join(",")}),vec3(${c.join(",")}),t);` : `return vec3(${c.join(",")});`} }`).join("\n");
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uTrail: { value: SLOTS } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `
      attribute float aBirth; attribute float aSpeed; uniform float uTime; uniform float uTrail;
      varying float vA; varying float vS;
      void main(){
        float a = (uTime - aBirth) / uTrail;
        vA = a; vS = aSpeed;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
      }`,
    fragmentShader: `
      varying float vA; varying float vS;
      vec3 ramp(float s){ ${stopsGLSL}
        return vec3(${LINE_STOPS[LINE_STOPS.length-1][1].join(",")}); }
      void main(){
        if (vA < 0.0 || vA > 1.0) discard;
        float fade = pow(1.0 - vA, 1.6);
        float strength = mix(0.22, 1.0, smoothstep(1.0, 15.0, vS));
        gl_FragColor = vec4(ramp(vS) * fade * strength, 1.0);
      }`,
  });
  const lines = new THREE.LineSegments(geo, mat); lines.frustumCulled = false; lines.renderOrder = 2; scene.add(lines);

  const tmpA = [0,0,0], tmpB = [0,0,0];
  function spawn(i) {
    lat[i] = Math.max(-85, Math.min(85, Math.asin(Math.random() * 2 - 1) / D2R));
    lon[i] = Math.random() * 360 - 180; age[i] = 0; life[i] = 60 + Math.random() * 90;
  }
  for (let i = 0; i < N; i++) { spawn(i); age[i] = Math.random() * life[i]; }
  let frame = 0;
  function step(dtScale) {
    frame++;
    const slot = frame % SLOTS, v0 = slot * N * 2;
    for (let i = 0; i < N; i++) {
      const [u, v] = field.sample(lon[i], lat[i], Clock.now());
      const sp = Math.hypot(u, v);
      toXYZ(lat[i], lon[i], R, tmpA, 0);
      const c = Math.max(0.15, Math.cos(lat[i] * D2R));
      lat[i] += v * STEP * dtScale; lon[i] += u * STEP * dtScale / c;
      if (lon[i] > 180) lon[i] -= 360; else if (lon[i] < -180) lon[i] += 360;
      age[i] += dtScale;
      const vi = v0 + i * 2, p = vi * 3;
      if (age[i] > life[i] || lat[i] > 85 || lat[i] < -85 || sp < 0.2) {
        spawn(i); birth[vi] = birth[vi+1] = -1e6; continue;
      }
      toXYZ(lat[i], lon[i], R, tmpB, 0);
      pos[p] = tmpA[0]; pos[p+1] = tmpA[1]; pos[p+2] = tmpA[2]; pos[p+3] = tmpB[0]; pos[p+4] = tmpB[1]; pos[p+5] = tmpB[2];
      birth[vi] = birth[vi+1] = frame; spd[vi] = spd[vi+1] = sp;
    }
    aPos.updateRange.offset = v0 * 3; aPos.updateRange.count = N * 6; aPos.needsUpdate = true;
    aBirth.updateRange.offset = v0; aBirth.updateRange.count = N * 2; aBirth.needsUpdate = true;
    aSpd.updateRange.offset = v0; aSpd.updateRange.count = N * 2; aSpd.needsUpdate = true;
    mat.uniforms.uTime.value = frame;
  }
  return { step, count: N };
})();

/* ===== カメラと操作 ===== */
const controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.enablePan = false; controls.enableDamping = true; controls.dampingFactor = 0.08;
controls.rotateSpeed = 0.45; controls.zoomSpeed = 0.6; controls.minDistance = 1.3; controls.maxDistance = 7;
{ const a = stage.clientWidth / Math.max(1, stage.clientHeight);
  const dist = Math.min(6.5, Math.max(3.1, 1.1 / (Math.tan(19 * D2R) * a)));
  const p = [0,0,0]; toXYZ(34, 138, dist, p, 0); camera.position.set(p[0], p[1], p[2]); }
controls.update();
controls.enableRotate = false;   // 回転は下の「地軸回し」で行う。拡大（ピンチ・ホイール）は OrbitControls のまま

/* ===== 地軸回し：横に動かすと地軸まわりに回り、縦に動かすと北極・南極の方へ傾く =====
   一回のドラッグの最初の動きで向きを決め、そのドラッグの間は向きを固定する */
const Spin = (() => {
  const el = renderer.domElement, sph = new THREE.Spherical();
  const pointers = new Map();
  let lock = null, total = [0, 0], vel = [0, 0], active = false;
  const k = () => 0.0009 + 0.0034 * (camera.position.length() - 1);
  function apply(dx, dy) {
    sph.setFromVector3(camera.position);
    if (lock === "h") sph.theta -= dx * k();
    if (lock === "v") sph.phi = Math.min(Math.PI - 0.06, Math.max(0.06, sph.phi - dy * k()));
    camera.position.setFromSpherical(sph); camera.lookAt(0, 0, 0);
  }
  el.addEventListener("pointerdown", e => {
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.size === 1) { active = true; lock = null; total = [0, 0]; vel = [0, 0]; }
    else { active = false; vel = [0, 0]; }          // 2本指はピンチ拡大に任せる
  });
  el.addEventListener("pointermove", e => {
    const p = pointers.get(e.pointerId); if (!p) return;
    const dx = e.clientX - p[0], dy = e.clientY - p[1]; pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (!active) return;
    total[0] += dx; total[1] += dy;
    if (!lock) {
      if (Math.hypot(total[0], total[1]) < 8) return;
      lock = Math.abs(total[1]) > Math.abs(total[0]) * 1.2 ? "v" : "h";
      document.getElementById("peek")?.classList.add("dim");
    }
    apply(dx, dy); vel = [dx, dy];
  });
  const up = e => {
    pointers.delete(e.pointerId);
    if (pointers.size === 0) { active = false; document.getElementById("peek")?.classList.remove("dim"); }
  };
  el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
  return {
    /** 指を離したあとの惰性 */
    tick() {
      if (active || !lock || Math.hypot(vel[0], vel[1]) < 0.05) return;
      vel = [vel[0] * 0.92, vel[1] * 0.92]; apply(vel[0], vel[1]);
    },
  };
})();
function resize() { const w = stage.clientWidth, h = stage.clientHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
window.addEventListener("resize", resize); resize();

/* ===== Lens（仮）：目録のメタデータだけを読む ===== */
const wm = Catalog.meta("wind-10m");
const fmtUTC = d => d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
const fmtJST = d => { const j = new Date(d.getTime() + 9 * 3600000), z = n => String(n).padStart(2, "0"); return `${j.getUTCFullYear()}/${z(j.getUTCMonth()+1)}/${z(j.getUTCDate())} ${z(j.getUTCHours())}:${z(j.getUTCMinutes())} JST`; };
const shown = Clock.now();
document.getElementById("d-level").textContent = `${wm.level}・${wm.kind}`;
document.getElementById("d-when").textContent = fmtJST(shown);
document.getElementById("d-rows").innerHTML = [
  ["種別", `${wm.kind}（${wm.model}）`],
  ["有効時刻", `<span class="num">${wm.validTime.slice(0,16).replace("T"," ")} UTC</span>`],
  ["予報の初期時刻", `<span class="num">${wm.issuedTime.slice(0,16).replace("T"," ")} UTC</span>`],
  ["鮮度", `${wm.delivery}／通常${wm.usualIntervalH}時間ごと${Catalog.generatedAt ? `<br><span class="num" style="color:var(--ink-faint)">取得 ${fmtJST(Catalog.generatedAt)}</span>` : ""}`],
  ["解像度", wm.resolution],
  ["出典", `${wm.credit}${wm.sampleCredit ? `<br><span style="color:var(--ink-faint)">${wm.sampleCredit}</span>` : ""}`],
  ["地図", Catalog.meta("land").credit],
].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
if (Catalog.license("wind-10m")) { document.getElementById("d-mit").textContent = Catalog.license("wind-10m"); document.getElementById("d-lic").hidden = false; }
document.getElementById("m-mode").textContent = Catalog.mode === "live" ? "最新" : "サンプル";
document.getElementById("d-note").textContent = Catalog.mode === "live"
  ? "風と雨は同じGFSの計算（同じ初期時刻・同じ予報時間）から取っているので、同じ時刻として重ねています。線の速さと長さは見やすさのための表示倍率で、風速の値そのものは変えていません。"
  : "いまは最新データが見つからないため、固定のサンプル（風は2014年、雨は2021年）で動いています。線の速さと長さは見やすさのための表示倍率で、風速の値そのものは変えていません。";
const css = c => `rgb(${c.map(x => Math.round(x * 255)).join(",")})`;
document.getElementById("d-bar").style.background = `linear-gradient(90deg, ${LINE_STOPS.map(([s, c]) => `${css(c)} ${(s / 30 * 100).toFixed(1)}%`).join(", ")})`;
document.getElementById("d-ticks").innerHTML = [0, 10, 20, 30].map(v => `<span>${v}${v === 30 ? " m/s" : ""}</span>`).join("");

/* 層ごとの説明：どのデータも同じ書式で、目録のメタデータから作る */
const fmtSpan = m => m.validFrom ? `${m.validFrom.slice(0,16).replace("T"," ")}〜${m.validTo.slice(11,16)} UTC` : `${m.validTime.slice(0,16).replace("T"," ")} UTC`;
function layerBlock(id, opts) {
  const m = Catalog.meta(id), ok = Catalog.validAt(id, Clock.now());
  const legend = opts.profile ? `<div class="legend"><div class="cap">${opts.profile.label}</div><div class="bar" style="background:linear-gradient(90deg, ${opts.profile.stops.map(([s, c], k) => `rgba(${c.slice(0,3).map(x => Math.round(x*255)).join(",")},${Math.max(c[3], .5)}) ${(k / (opts.profile.stops.length - 1) * 100).toFixed(0)}%`).join(", ")})"></div><div class="ticks">${opts.profile.ticks.map(v => `<span>${v}</span>`).join("")}</div></div>` : "";
  return `<div class="layer">
    <label><input type="checkbox" id="t-${id}" ${opts.visible ? "checked" : ""}> ${m.title}<span style="font-weight:400;color:var(--ink-faint);font-size:11.5px">　${m.kind}</span></label>
    <div class="sub">${fmtSpan(m)}・${m.resolution || ""}${m.coverage ? "・" + m.coverage : ""}<br>出典：${m.credit}${m.sampleCredit ? "（" + m.sampleCredit + "）" : ""}</div>
    ${ok ? "" : `<div class="sub warn">地球儀の時計（${fmtUTC(Clock.now())}）とは別の時刻のデータです</div>`}
    ${legend}</div>`;
}
document.getElementById("d-layers").innerHTML = SCALAR_LAYERS.map(l => layerBlock(l.id, { visible: l.visible, profile: l.profile })).join("");
for (const l of SCALAR_LAYERS) document.getElementById("t-" + l.id).addEventListener("change", e => { l.visible = e.target.checked; updateChip(); });
/** 見る帯の札：いまの時計の時刻が「どれくらい前／後」か。止まっていたら知らせる */
function updateChip() {
  const chip = document.getElementById("d-fresh"), now = Date.now();
  const mismatch = SCALAR_LAYERS.some(l => l.visible && !Catalog.validAt(l.id, Clock.now()));
  let text, ok = false;
  if (Catalog.mode !== "live") text = "サンプル";
  else if (Catalog.generatedAt && now - Catalog.generatedAt > wm.usualIntervalH * 3 * 3600000) text = "更新が止まっています";
  else {
    const h = Math.round((Clock.now() - now) / 3600000);
    text = h === 0 ? "いまごろ" : h < 0 ? `約${-h}時間前` : `約${h}時間後`;
    ok = true;
  }
  if (mismatch) { text = "時刻ちがいを含む"; ok = false; }
  chip.textContent = text; chip.classList.toggle("ok", ok);
}
setInterval(updateChip, 60000);
updateChip();

const dock = document.getElementById("dock"), detail = document.getElementById("lens");
dock.addEventListener("click", () => { const open = detail.hidden; detail.hidden = !open; dock.setAttribute("aria-expanded", String(open)); });
/* 地球を回している間だけ、見る帯を薄くする（消さない） */
const peek = document.getElementById("peek"), peekPick = document.getElementById("peek-pick");
let pickTimer = 0;
function showPick(html) { peekPick.innerHTML = html; peekPick.hidden = false; clearTimeout(pickTimer); pickTimer = setTimeout(() => (peekPick.hidden = true), 5000); }


/* 地点タップ：問い合わせ口から、その地点の風を聞く */
const raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2();
const DIRS = ["北","北北東","北東","東北東","東","東南東","南東","南南東","南","南南西","南西","西南西","西","西北西","北西","北北西"];
let down = null;
renderer.domElement.addEventListener("pointerdown", e => { down = [e.clientX, e.clientY]; hideHint(); });
renderer.domElement.addEventListener("pointerup", e => {
  if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6) return;
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObject(globe)[0]; if (!hit) return;
  const n = hit.point.clone().normalize(), la = Math.asin(n.y) / D2R, lo = Math.atan2(-n.z, n.x) / D2R;
  const [u, v] = field.sample(lo, la, Clock.now()), sp = Math.hypot(u, v), from = (Math.atan2(-u, -v) / D2R + 360) % 360;
  const ll = `${Math.abs(la).toFixed(1)}°${la >= 0 ? "N" : "S"} ${Math.abs(lo).toFixed(1)}°${lo >= 0 ? "E" : "W"}`;
  document.getElementById("d-pick").innerHTML = `<span class="num">${ll}</span>　風速 <span class="num">${sp.toFixed(1)} m/s</span>　${DIRS[Math.round(from / 22.5) % 16]}の風 <span style="color:var(--ink-faint)">（${wm.kind}・格子から補間）</span>`
    + SCALAR_LAYERS.filter(l => l.visible).map(l => "<br>" + presentValue(l, l.field.sample(lo, la, Clock.now()))).join("");
  showPick(document.getElementById("d-pick").innerHTML.replace(/<span style="color:var\(--ink-faint\)">[^<]*<\/span>/g, "").replace(/<br>/g, "　"));
});
const hint = document.getElementById("hint"); let hintGone = false;
function hideHint() { if (!hintGone) { hintGone = true; hint.style.opacity = "0"; } }
setTimeout(hideHint, 7000);

/* ===== 隠し開発メーター（D キー、またはタイトルを3回タップ） ===== */
const meter = document.getElementById("meter"); let taps = 0, tapTimer = 0;
document.getElementById("brand").addEventListener("click", () => { taps++; clearTimeout(tapTimer); tapTimer = setTimeout(() => (taps = 0), 600); if (taps >= 3) { meter.hidden = !meter.hidden; taps = 0; } });
window.addEventListener("keydown", e => { if (e.key === "d" || e.key === "D") meter.hidden = !meter.hidden; });
document.getElementById("m-n").textContent = VisualParticles.count.toLocaleString();
const frames = [];

{ const s = subsolarPoint(Clock.now()), p = [0,0,0]; toXYZ(s.lat, s.lon, 1, p, 0); sunDir.set(p[0], p[1], p[2]); }
let last = performance.now(), meterAt = last;
function loop(now) {
  const dt = Math.min(now - last, 100); last = now;
  frames.push(dt); if (frames.length > 120) frames.shift();
  VisualParticles.step(Math.min(dt / 16.667, 3));
  Spin.tick(); controls.update(); renderer.render(scene, camera);
  if (!meter.hidden && now - meterAt > 400) {
    meterAt = now; const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
    document.getElementById("m-fps").textContent = (1000 / avg).toFixed(0);
    document.getElementById("m-avg").textContent = avg.toFixed(1) + " ms";
    document.getElementById("m-max").textContent = Math.max(...frames).toFixed(1) + " ms";
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
})();
})();
