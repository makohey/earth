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
    if (L.lazy) return;                                   // 選ばれたときだけ読む層（上空の風など）
    bufs[id] = await getBin(base + L.file);
    if (L.meta.licenseFile) { try { const r = await fetch(base + L.meta.licenseFile); if (r.ok) extra[id] = await r.text(); } catch (_) {} }
  }));
  const MAP = { land: { meta: { title: "陸地", kind: "観測（地図）", credit: "Natural Earth 1:50m（パブリックドメイン）" } },
                coast: { meta: { title: "海岸線", kind: "観測（地図）", credit: "Natural Earth 1:50m（パブリックドメイン）" } } };
  const mapBufs = { land, coast };
  return {
    mode: manifest.mode, generatedAt: manifest.generatedAt ? new Date(manifest.generatedAt) : null, base,
    has: id => id in manifest.layers,
    /** あとから読む層を読み込む（一度だけ） */
    async load(id) { if (!bufs[id]) bufs[id] = await getBin(base + manifest.layers[id].file); },
    meta: id => (manifest.layers[id] || MAP[id]).meta,
    license: id => extra[id] || null,
    gridInfo: id => manifest.layers[id].grid,
    /** 線・面の頂点列（緯度経度）。区切りごとに配列を返す */
    paths(id) { const raw = new Int16Array(mapBufs[id]), s = 100, out = []; let cur = []; for (let i = 0; i < raw.length; i += 2) { if (raw[i] === 32767) { if (cur.length) out.push(cur); cur = []; continue; } cur.push([raw[i] / s, raw[i+1] / s]); } if (cur.length) out.push(cur); return out; },
    /** 保存形式（圧縮）を物理量に戻す係。端子はこの形式を知らない */
    scalarValues(id) {
      const e = this.meta(id).encoding, q = e.type === "linear" ? new Int16Array(bufs[id]) : new Uint8Array(bufs[id]), out = new Float32Array(q.length);   // linearByte は Uint8
      const L = Math.log1p(e.max || 1);
      const decoders = {
        log1p: c => c === e.missing ? NaN : c === e.zero ? 0 : Math.expm1((c - 1) / e.levels * L),
        linear: c => c === e.missing ? NaN : c * e.scale + e.offset,
        raw: c => c === e.missing ? NaN : c,
        linearByte: c => c === e.missing ? NaN : c * e.scale + e.offset,
      };
      const dec = decoders[e.type]; for (let i = 0; i < q.length; i++) out[i] = dec(q[i]);
      return out;
    },
    /** そのデータが時計の時刻に有効か（一時点 or 期間。期間は終わりの時刻も含む） */
    validAt(id, t) { const m = this.meta(id);
      if (m.selection?.policy === "latestBefore" && m.validTime) { const v = new Date(m.validTime); return v <= t && t - v <= m.selection.maxAgeMin * 60000; }   // 時計より前で、古すぎない
      if (m.validFrom) return new Date(m.validFrom) <= t && t <= new Date(m.validTo); return m.validTime ? +new Date(m.validTime) === +t : true; },
    grid(id) { return { grid: manifest.layers[id].grid, raw: new Int16Array(bufs[id]), meta: this.meta(id) }; },
    /** 物の層（Feature）の中身。行の形のまま返す */
    rows(id) { return (this._rows ||= {})[id] ||= JSON.parse(new TextDecoder().decode(bufs[id])); },
  };
}

let Catalog;
/* 開発中の層は ?dev=1 のときだけ出す（公開中の地球儀を壊さずに本物のデータで確かめるため）
   2026-09-29：地図・気圧・雲・氷・地震は正規版へ（まことの決定）。いま ?dev=1 だけなのは棚に戻した空港の観測 */
const DEV = new URLSearchParams(location.search).get("dev") === "1";
const ON = true;
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

/* 風の高さ：地上／約1.5km／約5.5km／約10km。上空ほど速いので、線の速さと色の幅を高さごとに変える（scale） */
const WIND_LEVELS = [
  { id: "wind-10m", label: "地上", scale: 1 },
  { id: "wind-850", label: "約1.5km", scale: 1.4 },
  { id: "wind-500", label: "約5.5km", scale: 2.2 },
  { id: "wind-250", label: "約10km", scale: 3.5 },
];
let field = createGridFlowField("wind-10m"), windScale = 1;
const flowCache = { "wind-10m": field };
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
  uniforms: { uLand: { value: buildLandMask() }, uSun: { value: sunDir }, uNight: { value: 1 }, uLights: { value: null }, uLightsOn: { value: 0 }, uIce: { value: null }, uIceOn: { value: 0 }, uBathy: { value: null }, uBathyOn: { value: 0 } },
  vertexShader: `varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D uLand; uniform sampler2D uLights; uniform sampler2D uIce; uniform float uIceOn; uniform sampler2D uBathy; uniform float uBathyOn; uniform vec3 uSun; uniform float uNight; uniform float uLightsOn; varying vec3 vPos;
    const float PI = 3.141592653589793;
    void main(){
      vec3 n = normalize(vPos);
      float lat = asin(clamp(n.y,-1.0,1.0)), lon = atan(-n.z, n.x);
      float land = texture2D(uLand, vec2((lon+PI)/(2.0*PI), (lat+PI*0.5)/PI)).r;
      vec3 ocean = mix(vec3(0.030,0.062,0.118), vec3(0.040,0.090,0.160), 0.5 + 0.5*n.y*n.y);
      vec3 ground = vec3(0.105,0.130,0.160);
      // 海の深さ（動かない地図）：浅い海は明るめの青、深いほど藍色。控えめに
      if (uBathyOn > 0.0) { float b = texture2D(uBathy, vec2((lon+PI)/(2.0*PI), (lat+PI*0.5)/PI)).r * 255.0;
        float t = clamp((b - 20.0) / 200.0, 0.0, 1.0); vec3 deep = mix(vec3(0.105,0.200,0.290), vec3(0.012,0.030,0.075), pow(t, 0.6));
        ocean = mix(ocean, deep, 0.85 * uBathyOn * step(10.0, b)); }
      vec3 col = mix(ocean, ground, land);
      // 陸の氷（氷河・氷床・棚氷。動かない地図）：抑えた冷たい色で。雲や風より前に出さない
      if (uIceOn > 0.0) { float ice = texture2D(uIce, vec2((lon+PI)/(2.0*PI), (lat+PI*0.5)/PI)).r; col = mix(col, vec3(0.42, 0.48, 0.56), ice * 0.80 * uIceOn); }
      float day = smoothstep(-0.10, 0.16, dot(n, normalize(uSun)));
      col *= mix(mix(1.15, 0.42, uNight), 1.45, day);   // uNight=0：昼夜なし（ふつうの地球儀）
      // 夜の街の灯り：夜の側だけに、控えめに（主役の風の線を邪魔しない明るさ）
      if (uLightsOn > 0.0) {
        float li = texture2D(uLights, vec2((lon+PI)/(2.0*PI), (lat+PI*0.5)/PI)).r;
        float night = (1.0 - smoothstep(-0.18, 0.04, dot(n, normalize(uSun)))) * uNight;
        col += vec3(1.00, 0.78, 0.45) * pow(li, 1.3) * 0.95 * night * uLightsOn;
      }
      float rim = dot(n, normalize(cameraPosition));
      col += vec3(0.05,0.10,0.20) * pow(1.0 - clamp(rim,0.0,1.0), 3.0) * (0.35 + 0.65*day);
      gl_FragColor = vec4(col, 1.0);
    }`,
}));
scene.add(globe);

/* ===== 値の面を描く係（Renderer）。色の意味は Visual Profile が決める ===== */
const RAIN_PROFILE = {
  label: "雨の色＝降水の強さ（mm/h）",
  stops: [[0.1,[0.82,0.87,1.00,0.07]],[1,[0.78,0.82,1.00,0.15]],[5,[0.74,0.66,1.00,0.24]],[15,[0.90,0.55,1.00,0.32]],[40,[1.00,0.43,0.78,0.40]]],   // 雨は背景役：風・流星・ISSなど主役の邪魔をしない濃さ
  ticks: [0.1, 1, 5, 15, 40],
  /** 値の見せ方：単位・桁・「なし」の言い方・補足 */
  present: { name: "降水", units: "mm/h", digits: 1, below: [0.1, "0.1 mm/h 未満"], missing: "データなし" },
};
function presentValue(layer, v) {
  if (layer.profile.presentFn) return layer.profile.presentFn(layer, v);
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
/** 正負をまたぐ値（平年差など）用：線形に色を補間 */
function rampLinear(stops, v) {
  if (v <= stops[0][0]) return stops[0][1];
  for (let k = 1; k < stops.length; k++) if (v <= stops[k][0]) { const [a, ca] = stops[k-1], [b, cb] = stops[k], t = (v - a) / (b - a); return ca.map((c, i) => c + (cb[i] - c) * t); }
  return stops[stops.length - 1][1];
}
function createScalarLayer(field, profile) {
  const W = 1440, H = 720, cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d"), img = ctx.createImageData(W, H), px = img.data;
  for (let y = 0; y < H; y++) {
    const lat = 90 - (y + 0.5) / H * 180;
    for (let x = 0; x < W; x++) {
      const v = field.sample(-180 + (x + 0.5) / W * 360, lat, Clock.now());
      if (v === null) {                               // データなし：塗らない（晴れとは言わない）
        if (profile.noDataHatch && (x + y) % 9 === 0) { const p = (y * W + x) * 4; px[p] = px[p+1] = px[p+2] = 215; px[p+3] = 34; }   // 観測範囲外はごく薄い斜線
        continue;
      }
      const c = profile.linear ? rampLinear(profile.stops, v) : rampRGBA(profile.stops, v); if (!c) continue;
      const p = (y * W + x) * 4; px[p] = c[0]*255; px[p+1] = c[1]*255; px[p+2] = c[2]*255; px[p+3] = c[3]*255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv); tex.generateMipmaps = false; tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(profile.radius || 1.0008, 128, 96), new THREE.ShaderMaterial({
    uniforms: { uTex: { value: tex }, uOpacity: { value: 1 } }, transparent: true, depthWrite: false,
    vertexShader: `varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform sampler2D uTex; uniform float uOpacity; varying vec3 vPos; const float PI = 3.141592653589793;
      void main(){ vec3 n = normalize(vPos); float lat = asin(clamp(n.y,-1.0,1.0)), lon = atan(-n.z, n.x);
        vec4 c = texture2D(uTex, vec2((lon+PI)/(2.0*PI), (lat+PI*0.5)/PI)); gl_FragColor = vec4(c.rgb, c.a * uOpacity); }`,
  }));
  mesh.renderOrder = profile.order ?? 1; scene.add(mesh);
  /* 層の濃さのつまみ：のちに流星群やISSなど主役が出たとき、背景の層を一歩下げるための差込口 */
  return { id: field.id, mesh, field, profile, set visible(v) { mesh.visible = v; }, get visible() { return mesh.visible; },
    set opacity(v) { mesh.material.uniforms.uOpacity.value = v; }, get opacity() { return mesh.material.uniforms.uOpacity.value; } };
}
const SCALAR_LAYERS = [];   // 値の層は全部ここに並ぶ（重なり順も層が持つ）
/* 陸の氷（静的な地図）と海氷（GFS モデル計算）：地表の情報として、雲・雨・風の下に */
new THREE.TextureLoader().load("data/map/bathymetry.png", t => { t.minFilter = THREE.LinearFilter; globe.material.uniforms.uBathy.value = t; globe.material.uniforms.uBathyOn.value = 1; });
const LAND_ICE = { title: "氷河・氷床地図（静的）", kind: "地図", credit: "Natural Earth（氷河・氷床、南極の棚氷。パブリックドメイン）", note: "いまの氷の正確な輪郭ではなく、動かない地図です" };
if (ON) new THREE.TextureLoader().load("data/map/land_ice.png", t => { globe.material.uniforms.uIce.value = t; globe.material.uniforms.uIceOn.value = 1; });
const SEAICE_PROFILE = {
  label: "海氷の割合（%）",
  stops: [[15,[0.52,0.60,0.70,0.20]],[40,[0.55,0.63,0.73,0.34]],[80,[0.58,0.66,0.76,0.46]],[100,[0.60,0.68,0.78,0.52]]],
  ticks: [15, 40, 80, 100],
  radius: 1.0003, order: 0.5, ground: true,     // 地表の情報：どの見せ方でも出す
  present: { name: "海氷", units: "%", digits: 0, below: [15, "ほぼなし（15%未満）"], missing: "" },
  presentFn(layer, v) { if (v === null || v < 1) return ""; const m = layer.field.meta; return `海氷 <span class="num">${v < 15 ? "15%未満" : v.toFixed(0) + "%"}</span> <span style="color:var(--ink-faint)">（${m.kind}）</span>`; },
};
if (ON && Catalog.has("sea-ice")) SCALAR_LAYERS.push(createScalarLayer(createGridScalarField("sea-ice"), SEAICE_PROFILE));

/* 海面水温の平年差：いつもより温かい（赤）／冷たい（青）。主役の面なので、既定では出さない（ボタンで出す） */
const SSTA_PROFILE = {
  label: "海面水温の平年差（℃）",
  linear: true, optIn: true,
  stops: [[-3,[0.25,0.45,0.95,0.70]],[-1.5,[0.40,0.62,1.00,0.45]],[-0.5,[0.60,0.75,1.00,0.00]],[0.5,[1.00,0.70,0.55,0.00]],[1.5,[1.00,0.50,0.35,0.50]],[3,[0.95,0.22,0.22,0.75]]],
  ticks: ["−3", "", "", "", "", "+3"],
  radius: 1.0004, order: 0.7,
  present: { name: "海面水温の平年差", units: "℃", digits: 1, below: [-Infinity, ""], missing: "" },
  presentFn(layer, v) { if (v === null) return ""; const m = layer.field.meta;
    return `海面水温 <span class="num">平年${v >= 0 ? "より +" : "より "}${v.toFixed(1)}℃</span> <span style="color:var(--ink-faint)">（${m.kind}・${m.validFrom.slice(0,10)}）</span>`; },
};
if (Catalog.has("sst-anom")) SCALAR_LAYERS.push(createScalarLayer(createGridScalarField("sst-anom"), SSTA_PROFILE));

/* 衛星赤外（雲）：値は 0〜254 の明るさ段階。大きいほど冷たい＝高い・厚い雲。温度への換算はしていない */
const CLOUD_PROFILE = {
  label: "雲の白さ＝赤外で見た冷たさ（白いほど高い・厚い雲）",
  stops: [[118,[0.80,0.85,0.95,0.00]],[140,[0.84,0.88,0.96,0.28]],[165,[0.90,0.93,0.99,0.55]],[195,[0.96,0.98,1.00,0.78]],[235,[1.00,1.00,1.00,0.90]]],
  ticks: ["低い・薄い", "", "", "", "高い・厚い"],
  radius: 1.0006, order: 0.9,          // 雨（モデル）より下、地面より上
  noDataHatch: true,                   // 観測範囲外（極の近く）はごく薄い斜線：氷が見えても「晴れ」とは言わない
  present: { name: "衛星赤外", units: "", digits: 0, below: [-Infinity, ""], missing: "データなし" },
  presentFn(layer, v) {
    const m = layer.field.meta, age = Math.round((Clock.now() - new Date(m.validTime)) / 60000);
 const txt = v === null ? "データなし（静止衛星の観測範囲外）" : v >= 195 ? "高い・厚い雲" : v >= 150 ? "雲" : v >= 125 ? "薄い雲か低い雲" : "雲は少ない（低い雲・霧は見えにくい）";
    return `衛星 <span class="num">${txt}</span> <span style="color:var(--ink-faint)">（衛星・${age}分前の画像）</span>`;
  },
};
if (ON && Catalog.has("cloud-ir")) SCALAR_LAYERS.push(createScalarLayer(createGridScalarField("cloud-ir"), CLOUD_PROFILE));
if (Catalog.has("rain")) SCALAR_LAYERS.push(createScalarLayer(createGridScalarField("rain"), RAIN_PROFILE));

/* ===== 値の場を「線」で見せる係（等値線）。同じ Scalar Field から、雨は面、気圧は線 ===== */
const PRESSURE_PROFILE = {
  label: "気圧配置（等圧線・4 hPa ごと）", step: 4, bold: 20,     // 1000・1020 hPa…を少し濃く
  color: [0.86, 0.88, 1.00], opacity: 0.30, boldOpacity: 0.48,
  modes: ["both"],                                              // 既定では「重ねる」のときだけ
  present: { name: "気圧", units: "hPa", digits: 0, below: [-Infinity, ""], missing: "データなし" },
};
function createContourLayer(field, profile, id) {
  const g = Catalog.gridInfo(id), vals = Catalog.scalarValues(id), nx = g.nx, ny = g.ny;
  const at = (i, j) => vals[j * nx + ((i % nx) + nx) % nx];
  const thin = [], bold = [], tmp = [0, 0, 0];
  const put = (arr, lon, lat) => { toXYZ(lat, lon, 1.0021, tmp, 0); arr.push(tmp[0], tmp[1], tmp[2]); };
  // マーチング・スクエア：升目の四隅の値から、等値線が横切る辺を見つけて線分をつなぐ
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx; i++) {
    const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
    if ([a, b, c, d].some(Number.isNaN)) continue;
    const lo = Math.min(a, b, c, d), hi = Math.max(a, b, c, d);
    for (let L = Math.ceil(lo / profile.step) * profile.step; L <= hi; L += profile.step) {
      const pts = [];
      const edge = (v1, v2, i1, j1, i2, j2) => { if ((v1 < L) !== (v2 < L)) { const t = (L - v1) / (v2 - v1); pts.push([g.lon0 + (i1 + (i2 - i1) * t) * g.dx, g.lat0 - (j1 + (j2 - j1) * t) * g.dy]); } };
      edge(a, b, i, j, i + 1, j); edge(b, c, i + 1, j, i + 1, j + 1); edge(c, d, i + 1, j + 1, i, j + 1); edge(d, a, i, j + 1, i, j);
      const arr = L % profile.bold === 0 ? bold : thin;
      for (let k = 0; k + 1 < pts.length; k += 2) { put(arr, pts[k][0], pts[k][1]); put(arr, pts[k+1][0], pts[k+1][1]); }
    }
  }
  const group = new THREE.Group(); group.renderOrder = 1.8; scene.add(group);
  const mats = [];
  for (const [arr, op] of [[thin, profile.opacity], [bold, profile.boldOpacity]]) {
    const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(arr), 3));
    const m = new THREE.LineBasicMaterial({ color: new THREE.Color(...profile.color), transparent: true, opacity: op, depthWrite: false });
    m.userData.base = op; mats.push(m); group.add(new THREE.LineSegments(geo, m));
  }
  let op = 1;
  return { id, field, profile, set visible(v) { group.visible = v; }, get visible() { return group.visible; },
    set opacity(v) { op = v; for (const m of mats) m.opacity = m.userData.base * v; }, get opacity() { return op; } };
}
if (ON && Catalog.has("pressure")) SCALAR_LAYERS.push(createContourLayer(createGridScalarField("pressure"), PRESSURE_PROFILE, "pressure"));

/* ===== 物の問い合わせ口（Feature Interface） =====
   features(time) → [{ lon, lat, time, props }]
   どれを返すかは、目録に書かれた「時間の選び方（selection policy）」で決める。
   latestBefore：時計より前で一番新しいもの（未来側は拾わない）、ただし maxAge より古いものは出さない */
const SELECTION = {
  latestBefore(rows, F, time, pol) {
    const tmin = Math.floor(time.getTime() / 60000), best = new Map();
    for (const r of rows) {
      const t = r[F.tmin]; if (t > tmin || t < tmin - pol.maxAgeMin) continue;
      const b = best.get(r[F.id]); if (!b || b[F.tmin] < t) best.set(r[F.id], r);
    }
    return [...best.values()];
  },
  /** 出来事（地震など）：時計以前で、一定の時間の窓の中に起きたものすべて。未来は出さない */
  windowBefore(rows, F, time, pol) {
    const tmin = Math.floor(time.getTime() / 60000);
    return rows.filter(r => r[F.tmin] <= tmin && r[F.tmin] >= tmin - pol.windowMin);
  },
};
function createFeatureSource(id) {
  const meta = Catalog.meta(id), { fields, rows } = Catalog.rows(id);
  const F = Object.fromEntries(fields.map((f, i) => [f, i]));
  const pol = meta.selection || { policy: "latestBefore", maxAgeMin: 90 };
  return {
    id, meta,
    features(time) {
      return SELECTION[pol.policy](rows, F, time, pol).map(r => ({
        lon: r[F.lon], lat: r[F.lat], time: new Date(r[F.tmin] * 60000),
        props: Object.fromEntries(fields.map((f, i) => [f, r[i]])),
      }));
    },
  };
}

/* ===== 観測の点を描く係。点＝観測、という形の約束。拡大したときだけ静かに出る ===== */
const OBS_PROFILE = {
  color: [1.00, 0.91, 0.76], size: 5.0,
  showFrom: 2.5, fullAt: 1.9,        // カメラの距離（地球の半径=1）。これより近づくと出てくる
  maxAgeMin: 90,
};
function createPointLayer(source, profile) {
  const feats = source.features(Clock.now());
  const pos = new Float32Array(feats.length * 3), age = new Float32Array(feats.length), size = new Float32Array(feats.length), colr = new Float32Array(feats.length * 3);
  feats.forEach((f, i) => { toXYZ(f.lat, f.lon, 1.0045, pos, i * 3); age[i] = (Clock.now() - f.time) / 60000 / profile.maxAgeMin; size[i] = profile.sizeOf ? profile.sizeOf(f) : 1;
    const c = profile.colorOf ? profile.colorOf(f) : profile.color; colr[i*3] = c[0]; colr[i*3+1] = c[1]; colr[i*3+2] = c[2]; });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3)); geo.setAttribute("aAge", new THREE.BufferAttribute(age, 1)); geo.setAttribute("aSize", new THREE.BufferAttribute(size, 1)); geo.setAttribute("aCol", new THREE.BufferAttribute(colr, 3));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uSize: { value: profile.size * renderer.getPixelRatio() }, uShow: { value: 0 }, uOpacity: { value: 1 }, uColor: { value: new THREE.Vector3(...profile.color) } },
    transparent: true, depthWrite: false,
    vertexShader: `attribute float aAge; attribute float aSize; attribute vec3 aCol; uniform float uSize; varying float vAge; varying vec3 vCol;
      void main(){ vAge = aAge; vCol = aCol; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_PointSize = uSize * aSize; }`,
    fragmentShader: `uniform float uShow; uniform float uOpacity; uniform vec3 uColor; varying float vAge; varying vec3 vCol;
      void main(){ vec2 d = gl_PointCoord - 0.5; float r = length(d); if (r > 0.5) discard;
        float ring = smoothstep(0.5, 0.36, r) * (0.55 + 0.45 * smoothstep(0.30, 0.18, r));
        float a = ring * uShow * uOpacity * mix(1.0, 0.45, clamp(vAge, 0.0, 1.0));
        if (a < 0.01) discard; gl_FragColor = vec4(vCol, a); }`,
  });
  const pts = new THREE.Points(geo, mat); pts.renderOrder = 3; scene.add(pts);
  let on = true;
  return {
    id: source.id, source, profile, feats, mat,
    set visible(v) { on = v; pts.visible = v; }, get visible() { return on; },
    /** 拡大の度合いで出し入れ（毎フレーム） */
    tick(dist) { const t = Math.min(1, Math.max(0, (profile.showFrom - dist) / (profile.showFrom - profile.fullAt))); mat.uniforms.uShow.value = t; },
    get shown() { return on && mat.uniforms.uShow.value > 0.05; },
    /** 地点の近くの観測を一つ返す（度） */
    nearest(lon, lat, maxDeg) {
      let best = null, bd = maxDeg;
      for (const f of feats) { const d = Math.hypot((((f.lon - lon + 540) % 360) - 180) * Math.cos(lat * D2R), f.lat - lat); if (d < bd) { bd = d; best = f; } }
      return best;
    },
  };
}
const FEATURE_LAYERS = [];

/* ===== ふつうの地球儀：国境・国名・緯線経線（Natural Earth、パブリックドメイン） =====
   国境は「見方（POV）」を持つ。jp＝日本から見た境界／fact＝実際の管理の線（主張が食い違う所は点線） */
const MAP_VIEWS = { jp: "日本から見た境界", fact: "実際の管理の線（係争地は点線）" };
async function createMapLayer() {
  const [bd, lb] = await Promise.all([getJSON("data/map/boundaries.json"), getJSON("data/map/labels.json")]);
  const group = new THREE.Group(); group.renderOrder = 1.5; scene.add(group);
  const R = 1.0016;
  // 緯線経線（30°ごと。赤道だけ少し濃い）
  const grat = [], eq = [];
  for (let lat = -60; lat <= 60; lat += 30) for (let lo = -180; lo < 180; lo += 2) (lat === 0 ? eq : grat).push([lo, lat], [lo + 2, lat]);
  for (let lo = -180; lo < 180; lo += 30) for (let la = -80; la < 80; la += 2) grat.push([lo, la], [lo, la + 2]);
  const segs = (pairs, r) => { const p = new Float32Array(pairs.length * 3); pairs.forEach(([lo, la], k) => toXYZ(la, lo, r, p, k * 3)); const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(p, 3)); return g; };
  group.add(new THREE.LineSegments(segs(grat, 1.0010), new THREE.LineBasicMaterial({ color: 0x9fb4dd, transparent: true, opacity: 0.10, depthWrite: false })));
  group.add(new THREE.LineSegments(segs(eq, 1.0010), new THREE.LineBasicMaterial({ color: 0xb8c8ea, transparent: true, opacity: 0.22, depthWrite: false })));
  // 国境：見方ごとに「実線」「点線」を作っておき、見方を切り替えたら表示だけ入れ替える
  const views = {};
  for (const v of Object.keys(MAP_VIEWS)) {
    const solid = [], dashed = [];
    for (const l of bd.lines) { const st = l[v]; if (!st) continue; const c = l.c; for (let i = 2; i < c.length; i += 2) (st === "solid" ? solid : dashed).push([c[i-2], c[i-1]], [c[i], c[i+1]]); }
    const a = new THREE.LineSegments(segs(solid, R), new THREE.LineBasicMaterial({ color: 0xe8d9b8, transparent: true, opacity: 0.55, depthWrite: false }));
    const bg = segs(dashed, R), b = new THREE.LineSegments(bg, new THREE.LineDashedMaterial({ color: 0xffc98a, transparent: true, opacity: 0.75, dashSize: 0.004, gapSize: 0.004, depthWrite: false }));
    b.computeLineDistances();
    const g = new THREE.Group(); g.add(a, b); g.visible = false; group.add(g); views[v] = g;
  }
  // 国名：画面上で一定の大きさの文字。拡大するほど小さい国まで出る
  const labels = [...lb.labels, ...(lb.seas || [])].sort((a, b) => a.rank - b.rank).map(L => {   // 国名と海の名前
    const cv = document.createElement("canvas"), ctx = cv.getContext("2d"), fs = 44;
    ctx.font = `${L.sea ? 400 : 500} ${fs}px "Zen Kaku Gothic New","Hiragino Sans","Noto Sans JP",sans-serif`;
    const w = Math.ceil(ctx.measureText(L.ja).width) + 16; cv.width = w; cv.height = fs + 16;
    ctx.font = `${L.sea ? 400 : 500} ${fs}px "Zen Kaku Gothic New","Hiragino Sans","Noto Sans JP",sans-serif`; ctx.textBaseline = "middle"; ctx.textAlign = "center";
    ctx.lineWidth = 8; ctx.strokeStyle = "rgba(3,6,14,0.85)"; ctx.strokeText(L.ja, w / 2, cv.height / 2);
    ctx.fillStyle = L.sea ? "rgba(150,196,240,0.85)" : "rgba(236,228,210,0.95)"; ctx.fillText(L.ja, w / 2, cv.height / 2);   // 海の名前は青みの文字
    const tex = new THREE.CanvasTexture(cv); tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.anisotropy = 4;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, sizeAttenuation: false, transparent: true, depthWrite: false, depthTest: false }));
    const p = [0, 0, 0]; toXYZ(L.lat, L.lon, 1.012, p, 0); sp.position.set(p[0], p[1], p[2]); sp.renderOrder = 4;
    sp.userData = { L, aspect: w / cv.height, n: new THREE.Vector3(p[0], p[1], p[2]).normalize() }; group.add(sp);
    return sp;
  });
  let view = "jp", on = false;
  const cam = new THREE.Vector3(), sp2 = new THREE.Vector3(), placed = [];
  return {
    views: MAP_VIEWS,
    get view() { return view; }, set view(v) { view = v; for (const k in views) views[k].visible = k === v; },
    set visible(v) { on = v; group.visible = v; }, get visible() { return on; },
    tick() {
      if (!on) return;
      const d = camera.position.length(), px = 12.5, h = stage.clientHeight || 800;
      const s = px / h * 2 * Math.tan(camera.fov / 2 * D2R);
      const maxRank = d > 4.5 ? 2 : d > 3.2 ? 3 : d > 2.2 ? 4 : d > 1.7 ? 5 : 6;
      cam.copy(camera.position).normalize();
      placed.length = 0;
      const W = stage.clientWidth || 400;
      for (const sp of labels) {             // 大きい国から順に置き、重なる小さい国名は出さない
        const u = sp.userData; let show = u.L.rank <= maxRank && (view !== "jp" || u.L.jp !== false) && u.n.dot(cam) > 0.25;
        if (show) {
          sp2.copy(sp.position).project(camera);
          const x = (sp2.x + 1) / 2 * W, y = (1 - sp2.y) / 2 * h, hw = px * u.aspect / 2 + 3, hh = px / 2 + 2;
          if (placed.some(b => Math.abs(b[0] - x) < b[2] + hw && Math.abs(b[1] - y) < b[3] + hh)) show = false;
          else placed.push([x, y, hw, hh]);
        }
        sp.visible = show; if (show) sp.scale.set(s * u.aspect, s, 1);
      }
    },
  };
}
/* 夜の街の灯り（NASA の夜の地球の合成画像。今夜の灯りそのものではない） */
const NIGHT_LIGHTS = { title: "夜の街の灯り", kind: "衛星（過去の合成画像）", credit: "NASA（Earth's City Lights。three.js の例に収録の画像）", note: "何年か前の衛星画像を合成したもので、今夜の灯りそのものではありません" };
new THREE.TextureLoader().load("data/map/night_lights.png", t => { globe.material.uniforms.uLights.value = t; globe.material.uniforms.uLightsOn.value = 1; });
/* ===== 夜空（天体観測）：星・星座・天の川・流星群の放射点を「その天体が真上に来る地点」に描く =====
   地理的位置：緯度＝赤緯、経度＝赤経 − グリニッジ恒星時。星空全体を地軸まわりに回すだけで今の空になる。
   画面の真ん中の地点から見える空＝こちらを向いている半球（真ん中＝天頂、縁＝地平線）。
   昼の側にも星はある（空にはある）が、見えないので薄く描く。 */
const SKY_INFO = {
  title: "夜空（天体観測）", kind: "計算（星表・星座）",
  note: "星や星座は「その天体が真上に来る地点」に描いています。地球儀を回して真ん中に来た場所から見える空が、こちらを向いた半球です（真ん中が真上、縁が地平線）。昼の側の星は空にあっても見えないので薄くしています。天の川は銀河の位置から計算したおおまかな帯です",
  credit: "星：XHIP（Hipparcos 拡張星表）、星座線・星座名：IAU の星座をもとにした d3-celestial のデータ（BSD-3-Clause, Olaf Frohn）",
};
/* 主な流星群（日付は毎年の目安。放射点は極大のころの位置の目安） */
const METEOR_SHOWERS = [
  { name: "しぶんぎ座流星群", from: "01-01", to: "01-06", peak: "1/4ごろ", ra: 230, dec: 49 },
  { name: "こと座流星群", from: "04-16", to: "04-25", peak: "4/22ごろ", ra: 271, dec: 34 },
  { name: "みずがめ座η流星群", from: "04-19", to: "05-28", peak: "5/6ごろ", ra: 338, dec: -1 },
  { name: "ペルセウス座流星群", from: "07-17", to: "08-24", peak: "8/12〜13ごろ", ra: 48, dec: 58 },
  { name: "りゅう座流星群", from: "10-06", to: "10-10", peak: "10/8〜9ごろ", ra: 262, dec: 54 },
  { name: "オリオン座流星群", from: "10-02", to: "11-07", peak: "10/21ごろ", ra: 95, dec: 16 },
  { name: "おうし座流星群（南群）", from: "09-10", to: "11-20", peak: "10/10ごろ", ra: 52, dec: 15 },
  { name: "しし座流星群", from: "11-06", to: "11-30", peak: "11/17〜18ごろ", ra: 152, dec: 22 },
  { name: "ふたご座流星群", from: "12-04", to: "12-20", peak: "12/14ごろ", ra: 112, dec: 33 },
];
function gmstDeg(date) { const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0; return ((280.46061837 + 360.98564736629 * n) % 360 + 360) % 360; }
function makeTextSprite(text, color, weight = 500, px = 12) {
  const cv = document.createElement("canvas"), ctx = cv.getContext("2d"), fs = 44, font = `${weight} ${fs}px "Zen Kaku Gothic New","Hiragino Sans","Noto Sans JP",sans-serif`;
  ctx.font = font; const w = Math.ceil(ctx.measureText(text).width) + 16; cv.width = w; cv.height = fs + 16;
  ctx.font = font; ctx.textBaseline = "middle"; ctx.textAlign = "center";
  ctx.lineWidth = 8; ctx.strokeStyle = "rgba(3,6,14,0.85)"; ctx.strokeText(text, w / 2, cv.height / 2);
  ctx.fillStyle = color; ctx.fillText(text, w / 2, cv.height / 2);
  const tex = new THREE.CanvasTexture(cv); tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, sizeAttenuation: false, transparent: true, depthWrite: false, depthTest: false }));
  sp.userData.aspect = w / cv.height; sp.userData.px = px; sp.renderOrder = 5; return sp;
}
async function createSkyLayer() {
  const d = await getJSON("data/sky/sky.json");
  const R = 1.016, frame = new THREE.Group(); frame.visible = false; scene.add(frame);   // 天の座標（経度＝赤経）で作り、恒星時で回す
  // 昼夜で薄くする共通のシェーダー片（世界座標の法線と太陽の向き）
  const dayFade = `uniform vec3 uSun; varying float vDay;
    float dayOf(vec3 wp){ return smoothstep(-0.12, 0.10, dot(normalize(wp), normalize(uSun))); }`;
  // 星：明るさで大きさ、色は B-V で少し
  const pos = [], size = [], col = [], tmp = [0, 0, 0];
  for (const [ra, dec, mag, bv] of d.stars) {
    toXYZ(dec, ra, R, tmp, 0); pos.push(...tmp);
    size.push(Math.max(1.2, 5.2 - mag * 0.85));
    const t = Math.max(-0.3, Math.min(1.8, bv)); col.push(t < 0.4 ? 0.80 : 1.0, t < 0.4 ? 0.88 : 0.95 - (t - 0.4) * 0.12, t < 0.4 ? 1.0 : 0.92 - (t - 0.4) * 0.35);
  }
  const sg = new THREE.BufferGeometry();
  sg.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); sg.setAttribute("aSize", new THREE.Float32BufferAttribute(size, 1)); sg.setAttribute("aCol", new THREE.Float32BufferAttribute(col, 3));
  const starMat = new THREE.ShaderMaterial({
    uniforms: { uSun: { value: sunDir }, uPR: { value: renderer.getPixelRatio() } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `attribute float aSize; attribute vec3 aCol; uniform float uPR; varying vec3 vCol; ${dayFade}
      void main(){ vec4 wp = modelMatrix * vec4(position,1.0); vDay = dayOf(wp.xyz); vCol = aCol; gl_Position = projectionMatrix * viewMatrix * wp; gl_PointSize = aSize * uPR; }`,
    fragmentShader: `varying vec3 vCol; varying float vDay;
      void main(){ float r = length(gl_PointCoord - 0.5); if (r > 0.5) discard; float a = smoothstep(0.5, 0.0, r) * mix(1.0, 0.18, vDay); gl_FragColor = vec4(vCol * a, 1.0); }`,
  });
  const stars = new THREE.Points(sg, starMat); stars.renderOrder = 6; frame.add(stars);
  // 星座線
  const lp = [];
  for (const ln of d.lines) for (let i = 2; i < ln.length; i += 2) { toXYZ(ln[i-1], ln[i-2], R, tmp, 0); lp.push(...tmp); toXYZ(ln[i+1], ln[i], R, tmp, 0); lp.push(...tmp); }
  const lg = new THREE.BufferGeometry(); lg.setAttribute("position", new THREE.Float32BufferAttribute(lp, 3));
  const lineMat = new THREE.ShaderMaterial({ uniforms: { uSun: { value: sunDir } }, transparent: true, depthWrite: false,
    vertexShader: `${dayFade} void main(){ vec4 wp = modelMatrix * vec4(position,1.0); vDay = dayOf(wp.xyz); gl_Position = projectionMatrix * viewMatrix * wp; }`,
    fragmentShader: `varying float vDay; void main(){ gl_FragColor = vec4(0.62, 0.74, 1.0, mix(0.55, 0.12, vDay)); }` });
  const lines = new THREE.LineSegments(lg, lineMat); lines.renderOrder = 6; frame.add(lines);
  // 天の川：銀河座標の銀緯から計算したおおまかな帯（中心方向ほど明るい）
  const W = 720, H = 360, cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const cx = cv.getContext("2d"), img = cx.createImageData(W, H);
  const ra0 = 192.85948 * D2R, de0 = 27.12825 * D2R, l0 = 122.93192 * D2R;          // 銀河北極（J2000）
  for (let y = 0; y < H; y++) { const de = (90 - (y + 0.5) / H * 180) * D2R;
    for (let x = 0; x < W; x++) { const ra = (-180 + (x + 0.5) / W * 360) * D2R;
      const sb = Math.sin(de) * Math.sin(de0) + Math.cos(de) * Math.cos(de0) * Math.cos(ra - ra0), b = Math.asin(sb) / D2R;
      const l = l0 - Math.atan2(Math.cos(de) * Math.sin(ra - ra0), Math.sin(de) * Math.cos(de0) - Math.cos(de) * Math.sin(de0) * Math.cos(ra - ra0));
      const core = 0.55 + 0.45 * Math.max(0, Math.cos(l)), a = Math.exp(-(b * b) / (2 * (7 + 4 * core) ** 2)) * core;
      const p = (y * W + x) * 4; img.data[p] = 200; img.data[p+1] = 214; img.data[p+2] = 255; img.data[p+3] = Math.round(a * 115); } }
  cx.putImageData(img, 0, 0);
  const mwTex = new THREE.CanvasTexture(cv); mwTex.minFilter = THREE.LinearFilter;
  const mw = new THREE.Mesh(new THREE.SphereGeometry(R - 0.001, 96, 64), new THREE.ShaderMaterial({
    uniforms: { uTex: { value: mwTex }, uSun: { value: sunDir } }, transparent: true, depthWrite: false,
    vertexShader: `varying vec3 vPos; ${dayFade} void main(){ vPos = position; vec4 wp = modelMatrix * vec4(position,1.0); vDay = dayOf(wp.xyz); gl_Position = projectionMatrix * viewMatrix * wp; }`,
    fragmentShader: `uniform sampler2D uTex; varying vec3 vPos; varying float vDay; const float PI = 3.141592653589793;
      void main(){ vec3 n = normalize(vPos); float lat = asin(clamp(n.y,-1.0,1.0)), lon = atan(-n.z, n.x);
        vec4 c = texture2D(uTex, vec2((lon+PI)/(2.0*PI), (lat+PI*0.5)/PI)); gl_FragColor = vec4(c.rgb, c.a * mix(1.0, 0.1, vDay)); }` }));
  mw.renderOrder = 5.5; frame.add(mw); const milky = [mw];   /* 天の川は星座と別に出し入れできる */
  // 天の川の粒：帯の真ん中ほど密に、細かい光の粒を散らす（星表の星ではなく、見た目のための粒）
  { const gp = [], gs = []; let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd());
    const lNcp = 122.93192 * D2R;
    for (let i = 0; i < 9000; i++) {
      const l = rnd() * 2 * Math.PI, core = 0.55 + 0.45 * Math.max(0, Math.cos(l));
      if (rnd() > 0.35 + 0.65 * core) continue;                              // 中心方向ほど多く
      const clump = 0.6 + 0.4 * Math.sin(l * 7 + 1.3) * Math.sin(l * 3.1);   // ところどころ濃淡
      const b = gauss() * (4 + 5 * core) * clump * D2R;
      const sd = Math.sin(b) * Math.sin(de0) + Math.cos(b) * Math.cos(de0) * Math.cos(lNcp - l), dec = Math.asin(sd);
      const ra = ra0 + Math.atan2(Math.cos(b) * Math.sin(lNcp - l), Math.sin(b) * Math.cos(de0) - Math.cos(b) * Math.sin(de0) * Math.cos(lNcp - l));
      toXYZ(dec / D2R, ra / D2R, R - 0.0005, tmp, 0); gp.push(...tmp); gs.push(0.6 + rnd() * 1.1);
    }
    const gg = new THREE.BufferGeometry(); gg.setAttribute("position", new THREE.Float32BufferAttribute(gp, 3)); gg.setAttribute("aSize", new THREE.Float32BufferAttribute(gs, 1));
    const grains = new THREE.Points(gg, new THREE.ShaderMaterial({ uniforms: { uSun: { value: sunDir }, uPR: { value: renderer.getPixelRatio() } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `attribute float aSize; uniform float uPR; ${dayFade} void main(){ vec4 wp = modelMatrix * vec4(position,1.0); vDay = dayOf(wp.xyz); gl_Position = projectionMatrix * viewMatrix * wp; gl_PointSize = aSize * uPR; }`,
      fragmentShader: `varying float vDay; void main(){ float r = length(gl_PointCoord - 0.5); if (r > 0.5) discard; float a = smoothstep(0.5, 0.0, r) * mix(0.55, 0.06, vDay); gl_FragColor = vec4(vec3(0.82, 0.87, 1.0) * a, 1.0); }` }));
    grains.renderOrder = 5.6; frame.add(grains); milky.push(grains); }
  // 星座名（大きい星座から）と、いまの時期の流星群の放射点
  const labels = [];
  for (const [ja, ra, dec, rank] of d.names) { if (rank > 2) continue; const sp = makeTextSprite(ja, "rgba(170,196,255,0.9)", 400, 11.5); toXYZ(dec, ra, R + 0.004, tmp, 0); sp.position.set(...tmp); sp.userData.rank = rank; frame.add(sp); labels.push(sp); }
  const md = (Clock.now().getUTCMonth() + 1) * 100 + Clock.now().getUTCDate(), inWin = s => { const f = +s.from.replace("-", ""), t = +s.to.replace("-", ""); return f <= t ? md >= f && md <= t : md >= f || md <= t; };
  const active = METEOR_SHOWERS.filter(inWin), radiants = [];
  for (const s of active) {
    const sp = makeTextSprite(`✦ ${s.name}（放射点・極大 ${s.peak}）`, "rgba(255,214,150,0.95)", 500, 12.5); toXYZ(s.dec, s.ra, R + 0.006, tmp, 0); sp.position.set(...tmp); sp.userData.rank = 0; frame.add(sp); labels.push(sp); radiants.push(s);
  }
  let skyOn = false, milkyOn = false;
  const sync = () => { frame.visible = skyOn || milkyOn; stars.visible = lines.visible = skyOn; for (const o of milky) o.visible = milkyOn; if (!skyOn) for (const sp of labels) sp.visible = false; };
  const cam = new THREE.Vector3(), wp = new THREE.Vector3();
  return {
    info: SKY_INFO, radiants,
    /* 星座（星・線・名前・流星群）と天の川を分けて出し入れする。どちらかが出ていれば天の枠を回す */
    set visible(v) { skyOn = v; sync(); }, get visible() { return skyOn; },
    set milky(v) { milkyOn = v; sync(); }, get milky() { return milkyOn; },
    tick() {
      if (!frame.visible) return;
      frame.rotation.y = -gmstDeg(Clock.now()) * D2R;               // 経度＝赤経−恒星時
      const dist = camera.position.length(), h = stage.clientHeight || 800, maxRank = dist > 3.2 ? 1 : 2;
      cam.copy(camera.position).normalize();
      for (const sp of labels) {
        wp.copy(sp.position).applyMatrix4(frame.matrixWorld).normalize();
        const show = skyOn && sp.userData.rank <= maxRank && wp.dot(cam) > 0.3;
        sp.visible = show; if (show) { const s = sp.userData.px / h * 2 * Math.tan(camera.fov / 2 * D2R); sp.scale.set(s * sp.userData.aspect, s, 1); }
      }
    },
  };
}
let SkyLayer = null;
try { SkyLayer = await createSkyLayer(); } catch (e) { console.warn("夜空を読めませんでした", e); }
let MapLayer = null;
if (ON) { try { MapLayer = await createMapLayer(); MapLayer.view = "jp"; MapLayer.visible = false; } catch (e) { console.warn("地図を読めませんでした", e); } }

/* ===== 首都（Natural Earth、パブリックドメイン）：★と名前。国境と同じ「見方」に合わせる。見方が分かれる首都は白抜きの☆ ===== */
async function createCapitalLayer() {
  const d = await getJSON("data/map/capitals.json"), F = Object.fromEntries(d.fields.map((n, i) => [n, i]));
  const rows = d.rows.map(r => ({ ja: r[F.ja], lat: r[F.lat], lon: r[F.lon], country: r[F.country], fact: !!r[F.fact], jp: !!r[F.jp], disputed: !!r[F.disputed], rank: Math.min(r[F.rank], r[F.pop] >= 4e6 ? 1 : r[F.pop] >= 1.5e6 ? 2 : r[F.pop] >= 4e5 ? 3 : 5) }));   /* 名前を出す順番：Natural Earth の順位と人口の、早いほう（ロンドンやキエフが遅れて出ないように） */
  const group = new THREE.Group(); group.visible = false; group.renderOrder = 4; scene.add(group);
  const pos = new Float32Array(rows.length * 3), hol = new Float32Array(rows.length), show = new Float32Array(rows.length);
  rows.forEach((c, i) => { toXYZ(c.lat, c.lon, 1.004, pos, i * 3); hol[i] = c.disputed ? 1 : 0; });
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(pos, 3)); g.setAttribute("aHol", new THREE.BufferAttribute(hol, 1)); g.setAttribute("aShow", new THREE.BufferAttribute(show, 1));
  const stars = new THREE.Points(g, new THREE.ShaderMaterial({ uniforms: { uSize: { value: 11 * renderer.getPixelRatio() } }, transparent: true, depthWrite: false,
    vertexShader: `attribute float aHol; attribute float aShow; uniform float uSize; varying float vHol; void main(){ vHol = aHol; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_PointSize = uSize * aShow; }`,
    fragmentShader: `varying float vHol; void main(){ vec2 p = gl_PointCoord - 0.5; p.y = -p.y; float a = atan(p.x, p.y), r = length(p);
      float lim = mix(0.20, 0.47, pow(0.5 + 0.5 * cos(5.0 * a), 2.0));                                   /* 五つの角の星 */
      float fill = 1.0 - smoothstep(lim - 0.05, lim, r), inner = 1.0 - smoothstep(lim - 0.16, lim - 0.11, r);
      float a1 = vHol > 0.5 ? fill * (1.0 - inner) : fill; if (a1 < 0.05) discard;
      gl_FragColor = vec4(vHol > 0.5 ? vec3(0.85, 0.85, 0.80) : vec3(1.0, 0.86, 0.45), a1); }` }));
  stars.frustumCulled = false; group.add(stars);
  const labels = rows.map(c => { const sp = makeTextSprite(c.ja, "rgba(255,236,196,0.95)", 500, 11); const q = [0, 0, 0]; toXYZ(c.lat, c.lon, 1.009, q, 0); sp.position.set(...q); sp.visible = false; group.add(sp); return sp; });
  const cam = new THREE.Vector3(), wp = new THREE.Vector3();
  let on = false;
  return {
    info: { title: "首都", kind: "地図（点）", credit: "Natural Earth 1:50m populated places（パブリックドメイン）",
      note: "★＝首都。国境と同じ「見方」（日本から見た見方／実際の管理）に合わせています。☆（白抜き）＝首都とするかどうか、国によって見方が分かれるところ。名前は拡大すると出ます" },
    set visible(v) { on = v; group.visible = v; }, get visible() { return on; },
    tick() {
      if (!on) return;
      const view = MapLayer?.view || "jp", dist = camera.position.length(), h = stage.clientHeight || 800, k = 2 * Math.tan(camera.fov / 2 * D2R) / h;
      const maxRank = dist < 2.6 ? 99 : dist < 3.6 ? 4 : dist < 5.2 ? 2 : -1;
      cam.copy(camera.position).normalize();
      rows.forEach((c, i) => { const vis = view === "fact" ? c.fact : c.jp; show[i] = vis ? 1 : 0;
        const sp = labels[i]; wp.copy(sp.position).normalize(); const ok = vis && c.rank <= maxRank && wp.dot(cam) > 0.3; sp.visible = ok;
        if (ok) { const sc = sp.userData.px * k; sp.scale.set(sc * sp.userData.aspect, sc, 1); sp.center.set(0.5, -0.35); } });
      g.attributes.aShow.needsUpdate = true;
    },
  };
}

/* ===== 県・州（Natural Earth admin-1）：「地名」モードで拡大したときだけ読み込んで出す =====
   見方が分かれる地域を含む国（ロシア・ウクライナ・中国・インドなど）は入れていない（保留） */
const STATE_COUNTRIES_JA = { JPN: "日本", AUS: "オーストラリア", USA: "アメリカ", CAN: "カナダ", BRA: "ブラジル", MEX: "メキシコ", DEU: "ドイツ", NZL: "ニュージーランド", ZAF: "南アフリカ" };
let NamesMode = false;
function createStateLayer() {
  const group = new THREE.Group(); group.visible = false; group.renderOrder = 1.6; scene.add(group);
  let loaded = null, loading = false, labels = [];
  const load = async () => { loading = true;
    const d = await getJSON("data/map/states.json"), pos = [], q = [0, 0, 0];
    for (const l of d.lines) for (let i = 2; i < l.length; i += 2) { toXYZ(l[i - 1], l[i - 2], 1.0018, q, 0); pos.push(...q); toXYZ(l[i + 1], l[i], 1.0018, q, 0); pos.push(...q); }
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    group.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xd8c9a8, transparent: true, opacity: 0.38, depthWrite: false })));
    labels = d.labels.sort((a, b) => a[3] - b[3]).map(([ja, la, lo, rank]) => { const sp = makeTextSprite(ja, "rgba(222,212,190,0.9)", 400, 10.5); toXYZ(la, lo, 1.007, q, 0); sp.position.set(...q); sp.userData.rank = rank; sp.visible = false; group.add(sp); return sp; });
    loaded = d; };
  const cam = new THREE.Vector3(), wp = new THREE.Vector3(), placed = [];
  return {
    info: { title: "県・州", kind: "地図（線と名前）", credit: "Natural Earth 1:10m admin-1（パブリックドメイン）",
      note: `「地名」モードで拡大すると出ます。いま入っている国：${Object.values(STATE_COUNTRIES_JA).join("・")}。見方が分かれる地域を含む国（ロシア・ウクライナ・中国・インドなど）は、いまは入れていません` },
    tick() {
      const dist = camera.position.length(), want = NamesMode && dist < 3.8;
      if (want && !loaded && !loading) load().catch(e => console.warn("県・州を読めませんでした", e));
      group.visible = want && !!loaded; if (!group.visible) return;
      const h = stage.clientHeight || 800, w = stage.clientWidth || 400, k = 2 * Math.tan(camera.fov / 2 * D2R) / h;
      const maxRank = dist < 1.9 ? 99 : dist < 2.4 ? 5 : dist < 3.0 ? 3 : -1;
      cam.copy(camera.position).normalize(); placed.length = 0;
      for (const sp of labels) {
        wp.copy(sp.position).normalize(); let ok = sp.userData.rank <= maxRank && wp.dot(cam) > 0.35;
        if (ok) { wp.copy(sp.position).project(camera); const x = (wp.x + 1) / 2 * w, y = (1 - wp.y) / 2 * h, hw = sp.userData.px * sp.userData.aspect / 2 + 4, hh = sp.userData.px / 2 + 3;
          ok = !placed.some(b => Math.abs(b[0] - x) < b[2] + hw && Math.abs(b[1] - y) < b[3] + hh); if (ok) placed.push([x, y, hw, hh]); }   /* 重なる名前は出さない（大きい州から順に） */
        sp.visible = ok; if (ok) { const sc = sp.userData.px * k; sp.scale.set(sc * sp.userData.aspect, sc, 1); }
      }
    },
  };
}
let StateLayer = null;
if (ON && MapLayer) { try { StateLayer = createStateLayer(); } catch (e) { console.warn("県・州を出せませんでした", e); } }
let CapitalLayer = null;
if (ON && MapLayer) { try { CapitalLayer = await createCapitalLayer(); } catch (e) { console.warn("首都を読めませんでした", e); } }

/* ===== 赤道と日付変更線（Natural Earth、パブリックドメイン） =====
   日付変更線は 180° の直線ではなく、島国の都合で曲がっている。線の両側に「いまの日付」を出す（西側が1日先） */
async function createGuideLayer() {
  const d = await getJSON("data/map/lines.json");
  const group = new THREE.Group(); group.renderOrder = 1.9; group.visible = false; scene.add(group);
  const R = 1.0022, geoOf = pairs => { const p = new Float32Array(pairs.length * 3); pairs.forEach(([lo, la], k) => toXYZ(la, lo, R, p, k * 3)); const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(p, 3)); return g; };
  const eq = []; for (let lo = -180; lo < 180; lo += 1) eq.push([lo, 0], [lo + 1, 0]);
  group.add(new THREE.LineSegments(geoOf(eq), new THREE.LineBasicMaterial({ color: 0xffd08a, transparent: true, opacity: 0.7, depthWrite: false })));
  const dl = []; for (const line of d.dateline) for (let k = 1; k < line.length; k++) dl.push(line[k - 1], line[k]);
  const dls = new THREE.LineSegments(geoOf(dl), new THREE.LineDashedMaterial({ color: 0xff9fc0, transparent: true, opacity: 0.85, dashSize: 0.012, gapSize: 0.008, depthWrite: false }));
  dls.computeLineDistances(); group.add(dls);
  const labels = [], put = (text, color, lat, lon, px = 12) => { const sp = makeTextSprite(text, color, 600, px), q = [0, 0, 0]; toXYZ(lat, lon, 1.006, q, 0); sp.position.set(...q); group.add(sp); labels.push(sp); return sp; };
  for (const lo of [-150, -60, 30, 120]) put("赤道", "rgba(255,214,150,0.95)", 1.6, lo);
  put("日付変更線", "rgba(255,175,205,0.95)", 22, 180);
  put("日付変更線", "rgba(255,175,205,0.95)", -30, 180);
  /* 両側の日付：日付変更線のすぐ西はおよそ UTC+12、すぐ東はおよそ UTC−12。いつでも1日ちがう */
  const md = off => { const t = new Date(Date.now() + off * 3600000); return `${t.getUTCMonth() + 1}月${t.getUTCDate()}日`; };
  let west = null, east = null, shown = "";
  const cam = new THREE.Vector3(), wp = new THREE.Vector3();
  const refreshDates = () => { const k = md(12) + md(-12); if (k === shown) return; shown = k;
    for (const sp of [west, east]) if (sp) { group.remove(sp); labels.splice(labels.indexOf(sp), 1); sp.material.map.dispose(); sp.material.dispose(); }
    west = put(`← ${md(12)}`, "rgba(255,235,210,0.95)", 38, 170, 11.5); east = put(`${md(-12)} →`, "rgba(255,235,210,0.95)", 38, -170, 11.5); };
  refreshDates();
  return {
    info: { title: "赤道と日付変更線", kind: "地図（線）", credit: "Natural Earth 1:50m geographic lines（パブリックドメイン）",
      note: "赤道＝北と南のちょうど真ん中（緯度0°）。日付変更線＝ここを西へ越えると日付が1日進み、東へ越えると1日戻る線。180°の経線に沿っているが、同じ国の中で日付が分かれないように島のまわりで曲がっている。線の両側の日付は、そのあたりの「いま」の日付（西側がいつも1日先）" },
    userOn: false,
    set visible(v) { group.visible = v; }, get visible() { return group.visible; },
    tick() {
      if (!group.visible) return;
      refreshDates();
      const h = stage.clientHeight || 800;
      cam.copy(camera.position).normalize();
      for (const sp of labels) { wp.copy(sp.position).normalize(); const ok = wp.dot(cam) > 0.25; sp.visible = ok;
        if (ok) { const s = sp.userData.px / h * 2 * Math.tan(camera.fov / 2 * D2R); sp.scale.set(s * sp.userData.aspect, s, 1); } }
    },
  };
}
let GuideLayer = null;
if (ON) { try { GuideLayer = await createGuideLayer(); } catch (e) { console.warn("赤道・日付変更線を読めませんでした", e); } }

/* ===== オーロラ帯（目安）：データではなく計算。磁気の極（双極子の近似）のまわりの輪を、夜側だけに光らせる =====
   ・輪の位置：昼側は磁気緯度 約76°、真夜中側は 約66°（夜側ほど低い緯度まで下りてくる、よく知られた形）
   ・揺らぎ（カーテンのような流れ）は演出。明るさや広がりは実際の宇宙天気を反映していない（のちに NOAA の予測へ差し替える候補） */
const GEOMAG_POLE = { lat: 80.8, lon: -72.7 };      // 北の磁気の極（地磁気の双極子近似・2025年ごろ。IGRF）
function createAuroraLayer() {
  const P = new THREE.Vector3(), q = [0, 0, 0]; toXYZ(GEOMAG_POLE.lat, GEOMAG_POLE.lon, 1, q, 0); P.set(...q).normalize();
  const E1 = new THREE.Vector3(0, 1, 0).cross(P).normalize(), E2 = P.clone().cross(E1).normalize();
  const mat = new THREE.ShaderMaterial({
    uniforms: { uSun: { value: sunDir }, uT: { value: 0 }, uE1: { value: E1 }, uE2: { value: E2 }, uE3: { value: P }, uGain: { value: 1 } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `varying vec3 vN; void main(){ vN = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 uSun; uniform float uT; uniform vec3 uE1; uniform vec3 uE2; uniform vec3 uE3; uniform float uGain; varying vec3 vN;
      float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
        return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
      float oval(vec3 m, vec3 s, float hemi){
        float colat = degrees(acos(clamp(hemi * m.z, -1.0, 1.0)));
        if (colat > 40.0) return 0.0;
        float lam = atan(m.y, m.x), phi = lam - atan(s.y, s.x), c = cos(phi);          /* c=1 昼（正午）側、c=-1 真夜中側 */
        float fold = 1.6 * sin(lam * 5.0 + uT * 0.11 + hemi) + 1.1 * (vn(vec2(lam * 9.0, uT * 0.07 + hemi * 7.0)) - 0.5) * 2.0;   /* カーテンのうねり（演出） */
        float center = 19.0 - 5.0 * c + fold, width = 2.6 + 1.6 * (0.5 - 0.5 * c);
        float d = (colat - center) / width, band = exp(-d * d);
        float rays = 0.55 + 0.45 * vn(vec2(lam * 70.0 + uT * 0.35, uT * 0.9 + hemi * 3.0));        /* 細い光の筋のまたたき（演出） */
        float strength = 0.35 + 0.65 * (0.5 - 0.5 * c);                                           /* 真夜中側ほど明るい */
        return band * rays * strength;
      }
      void main(){
        vec3 n = normalize(vN), m = vec3(dot(n, uE1), dot(n, uE2), dot(n, uE3)), su = normalize(uSun), s = vec3(dot(su, uE1), dot(su, uE2), dot(su, uE3));
        float dark = smoothstep(0.02, -0.16, dot(n, su));                                          /* 空が暗い所だけ */
        float a = (oval(m, s, 1.0) + oval(m, s, -1.0)) * dark * uGain;
        if (a < 0.004) discard;
        vec3 green = vec3(0.30, 1.00, 0.55), top = vec3(0.95, 0.35, 0.60);
        gl_FragColor = vec4(mix(green, top, smoothstep(0.55, 1.0, a) * 0.25) * a, a * 0.9);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1 + 110 / 6371, 160, 120), mat);     // 地上 約110km（緑の光の高さ）
  mesh.renderOrder = 2.5; mesh.visible = false; scene.add(mesh);
  return {
    info: { title: "オーロラ帯（目安）", kind: "計算（磁気の極からの目安）・揺らぎは演出",
      credit: "形：地磁気の双極子の近似（北の磁気の極 約80.8°N・72.7°W、IGRF による）から計算。外部のデータは取りに行きません",
      note: `オーロラがよく現れる帯を、北と南の磁気の極のまわりに描いています。夜側では低い緯度まで下りてくるので、輪は真夜中側に広がります。空が暗い所だけ光らせています。<b>いま実際に出ているオーロラではありません</b>。揺らぎ（カーテンのようなうねりと光の筋）は見せ方の演出です。宇宙天気が荒れると、帯はもっと明るく、ずっと低い緯度まで広がります<br><a href="https://www.swpc.noaa.gov/products/aurora-30-minute-forecast" target="_blank" rel="noopener" style="color:var(--accent)">いまのオーロラの予測を見たい人はこちら（NOAA 宇宙天気予報センター）</a>` },
    userOn: false,
    set visible(v) { mesh.visible = v; }, get visible() { return mesh.visible; },
    tick(now) { if (mesh.visible) mat.uniforms.uT.value = now / 1000; },
  };
}
/* ===== プレートの境目（Bird 2003 PB2002、ODC-By 1.0） =====
   色は紫の系統（ほかの層で使っていない色）。線の形で種類を分ける：実線＝近づく（沈み込む・ぶつかる）／破線＝広がる／点線＝ずれる */
const PLATE_JA = { PA: "太平洋", NA: "北アメリカ", EU: "ユーラシア", AF: "アフリカ", AN: "南極", IN: "インド", AU: "オーストラリア", SA: "南アメリカ", NZ: "ナスカ", CO: "ココス",
  PS: "フィリピン海", AR: "アラビア", OK: "オホーツク", AM: "アムール", CA: "カリブ", JF: "ファンデフカ", SO: "ソマリア", SU: "スンダ", YA: "揚子", SC: "スコシア", RI: "リベラ", MA: "マリアナ", ON: "沖縄", TO: "トンガ", KE: "ケルマデック", NH: "ニューヘブリディーズ", BS: "バンダ海", AS: "エーゲ海", AT: "アナトリア", PM: "パナマ", NB: "北ビスマルク", SB: "南ビスマルク", SS: "ソロモン海", TI: "ティモール", BH: "バーズヘッド", CL: "キャロライン", BU: "ビルマ", MS: "モルッカ海", ND: "北アンデス", AP: "アルティプラノ", EA: "イースター", JZ: "ファンフェルナンデス", GP: "ガラパゴス", MN: "マヌス", WL: "ウッドラーク", FT: "フツナ", NI: "ニウアフォウ", BR: "バルモラル礁", CR: "コンウェイ礁", MO: "モーンズ礁", SW: "サンドウィッチ", SL: "シェトランド" };
const PLATE_LABELS = [["太平洋プレート", 2, -150], ["北アメリカプレート", 48, -100], ["ユーラシアプレート", 55, 70], ["アフリカプレート", 5, 18], ["南極プレート", -75, 40],
  ["インドプレート", 12, 78], ["オーストラリアプレート", -25, 132], ["南アメリカプレート", -15, -48], ["ナスカプレート", -20, -92], ["フィリピン海プレート", 18, 134],
  ["アラビアプレート", 23, 47], ["オホーツクプレート", 55, 150], ["アムールプレート", 45, 125], ["ココスプレート", 9, -96], ["カリブプレート", 15, -75], ["スンダプレート", 5, 108]];
const PLATE_KIND = [{ ja: "広がる", verb: "離れる", line: "dashed", color: 0xd2b4ff }, { ja: "ずれる", verb: "ずれる", line: "dotted", color: 0xa98ae0 }, { ja: "ぶつかる", verb: "近づく", line: "solid", color: 0xc07cff }, { ja: "沈み込む", verb: "近づく", line: "solid", color: 0xc07cff }];
async function createPlateLayer() {
  const d = await getJSON("data/map/plates.json"), R = 1.0026;
  const group = new THREE.Group(); group.renderOrder = 1.95; group.visible = false; scene.add(group);
  for (const [k, look] of [[[2, 3], { dash: 0, gap: 0, op: 0.95 }], [[0], { dash: 0.010, gap: 0.006, op: 0.9 }], [[1], { dash: 0.003, gap: 0.004, op: 0.75 }]]) {
    const sel = d.steps.filter(r => k.includes(r[4])), p = new Float32Array(sel.length * 6);
    sel.forEach((r, j) => { toXYZ(r[1], r[0], R, p, j * 6); toXYZ(r[3], r[2], R, p, j * 6 + 3); });
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(p, 3));
    const color = PLATE_KIND[k[0]].color;
    const mat = look.dash ? new THREE.LineDashedMaterial({ color, transparent: true, opacity: look.op, depthWrite: false, dashSize: look.dash, gapSize: look.gap }) : new THREE.LineBasicMaterial({ color, transparent: true, opacity: look.op, depthWrite: false });
    const ls = new THREE.LineSegments(g, mat); if (look.dash) ls.computeLineDistances(); group.add(ls);
  }
  /* 線は1pxなので、下にぼかした太い光の帯を敷いて見やすくする（キャンバスに描いて球に貼る） */
  { const W = 2048, H = 1024, cv = document.createElement("canvas"); cv.width = W; cv.height = H; const ctx = cv.getContext("2d");
    const X = lo => (lo + 180) / 360 * W, Y = la => (90 - la) / 180 * H;
    ctx.lineCap = "round"; ctx.shadowColor = "rgba(190,120,255,0.9)"; ctx.shadowBlur = 6;
    for (const [k, w, a] of [[[2, 3], 4, 0.55], [[0], 3, 0.35], [[1], 2.4, 0.28]]) {
      ctx.strokeStyle = `rgba(192,124,255,${a})`; ctx.lineWidth = w; ctx.beginPath();
      for (const r of d.steps) { if (!k.includes(r[4]) || Math.abs(r[2] - r[0]) > 180) continue; ctx.moveTo(X(r[0]), Y(r[1])); ctx.lineTo(X(r[2]), Y(r[3])); }
      ctx.stroke(); }
    const tex = new THREE.CanvasTexture(cv); tex.anisotropy = 4;
    const glowMesh = new THREE.Mesh(new THREE.SphereGeometry(1.0022, 192, 96), new THREE.ShaderMaterial({ uniforms: { uTex: { value: tex } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform sampler2D uTex; varying vec3 vPos; const float PI = 3.141592653589793;
        void main(){ vec3 n = normalize(vPos); float lat = asin(clamp(n.y,-1.0,1.0)), lon = atan(-n.z, n.x);
          vec4 c = texture2D(uTex, vec2((lon+PI)/(2.0*PI), (lat+PI*0.5)/PI)); gl_FragColor = vec4(c.rgb * c.a, c.a); }` }));
    group.add(glowMesh); }
  const labels = PLATE_LABELS.map(([t, la, lo]) => { const sp = makeTextSprite(t, "rgba(214,184,255,0.92)", 600, 11), q = [0, 0, 0]; toXYZ(la, lo, 1.008, q, 0); sp.position.set(...q); group.add(sp); return sp; });
  const mids = d.steps.map(r => [(r[0] + (((r[2] - r[0] + 540) % 360) - 180) / 2), (r[1] + r[3]) / 2]);
  const cam = new THREE.Vector3(), wp = new THREE.Vector3();
  const name = c => PLATE_JA[c] ? PLATE_JA[c] + "プレート" : c;
  return {
    id: "plates", source: { id: "plates", meta: { title: "プレートの境目", kind: "研究モデル（地図）" } }, feats: [],
    userOn: false,
    profile: {
      describe() {
        const sw = (k, style) => `<span style="display:inline-block;width:22px;border-top:2px ${style} #${PLATE_KIND[k].color.toString(16)};vertical-align:middle;margin-right:4px"></span>`;
        return `地球の表面は、十数枚の大きな岩の板（プレート）に分かれていて、1年に数cmずつ動いています。境目では地震が起き、火山ができます<br>${sw(3, "solid")}近づく（沈み込む・ぶつかる）　${sw(0, "dashed")}広がる（海嶺など）　${sw(1, "dotted")}ずれる<br>線をタップで、どのプレートの境目か・1年に何cm動くか。「地震」と一緒に出すと、点が線の上に並ぶのが見えます<br>日本のまわりは、このモデルではオホーツク・アムールプレートに分かれています（日本の教科書では北アメリカ・ユーラシアプレートとして扱うことが多い）<br>出典：Bird (2003) "An updated digital model of plate boundaries"（PB2002）、変換 Hugo Ahlenius / Nordpil（ODC-By 1.0）`;
      },
      present(r) { const k = PLATE_KIND[r[4]], [a, b] = r[6].split(/[-\/\\]/);
        return `プレートの境目：${name(a)} と ${name(b)}（<span class="num">${k.ja}</span>）　1年に約<span class="num">${(r[5] / 10).toFixed(1)} cm</span> ${k.verb} <span style="color:var(--ink-faint)">（研究モデルの値）</span>`; },
    },
    set visible(v) { group.visible = v; }, get visible() { return group.visible; },
    get shown() { return group.visible; },
    nearest(lon, lat, maxDeg) { let best = null, bd = Math.max(maxDeg, 1.2);
      mids.forEach(([mlo, mla], i) => { const dd = Math.hypot((((mlo - lon + 540) % 360) - 180) * Math.cos(lat * D2R), mla - lat); if (dd < bd) { bd = dd; best = d.steps[i]; } });
      return best; },
    tick() {
      if (!group.visible) return;
      const h = stage.clientHeight || 800, far = camera.position.length() > 8;
      cam.copy(camera.position).normalize();
      for (const sp of labels) { wp.copy(sp.position).normalize(); const ok = !far && wp.dot(cam) > 0.35; sp.visible = ok;
        if (ok) { const sc = sp.userData.px / h * 2 * Math.tan(camera.fov / 2 * D2R); sp.scale.set(sc * sp.userData.aspect, sc, 1); } }
    },
  };
}
let PlateLayer = null;
if (ON) { try { PlateLayer = await createPlateLayer(); FEATURE_LAYERS.push(PlateLayer); } catch (e) { console.warn("プレートの境目を読めませんでした", e); } }
let AuroraLayer = null;
if (ON) { try { AuroraLayer = createAuroraLayer(); } catch (e) { console.warn("オーロラ帯を出せませんでした", e); } }
if (DEV && Catalog.has("metar")) FEATURE_LAYERS.push(createPointLayer(createFeatureSource("metar"), OBS_PROFILE));

/* 最近の地震：点の大きさ＝マグニチュード（USGS）。古いほど少し薄い。警報・判定はしない */
const QUAKE_PROFILE = {
  color: [1.00, 0.62, 0.42], size: 4.0,
  showFrom: 99, fullAt: 98,            // 引いた地球でも出す（数が少ないので）
  maxAgeMin: 24 * 60,
  sizeOf: f => Math.max(1, Math.min(6, (f.props.mag - 1.5) * 0.9)),
  /* 色＝マグニチュード（USGS）。震度ではない */
  MAG_STOPS: [[2.5, [1.00, 0.86, 0.45]], [4, [1.00, 0.66, 0.30]], [5, [1.00, 0.42, 0.26]], [6, [0.95, 0.22, 0.32]], [7, [0.85, 0.20, 0.75]]],
  colorOf(f) { const S = this.MAG_STOPS, m = f.props.mag; if (m <= S[0][0]) return S[0][1];
    for (let k = 1; k < S.length; k++) if (m <= S[k][0]) { const t = (m - S[k-1][0]) / (S[k][0] - S[k-1][0]); return S[k-1][1].map((c, i) => c + (S[k][1][i] - c) * t); }
    return S[S.length - 1][1]; },
  describe(l) {
    const m = l.source.meta, big = l.feats.filter(f => f.props.mag >= 5).length;
    const bar = this.MAG_STOPS.map(([m, c], k) => `rgb(${c.map(x => Math.round(x * 255)).join(",")}) ${(k / (this.MAG_STOPS.length - 1) * 100).toFixed(0)}%`).join(", ");
    return (this.extra || "") + `時計の時刻までの24時間・M2.5以上 <span class="num">${l.feats.length}</span>件（M5以上 <span class="num">${big}</span>件）<br>点の大きさと色＝マグニチュード（USGS）・点をタップで詳細
      <div class="legend" style="margin:6px 0"><div class="bar" style="background:linear-gradient(90deg, ${bar})"></div><div class="ticks">${this.MAG_STOPS.map(([m]) => `<span>M${m}${m === 7 ? "+" : ""}</span>`).join("")}</div></div>${m.caution}<br><a href="https://www.jma.go.jp/bosai/map.html#contents=earthquake_map" target="_blank" rel="noopener" style="color:var(--accent)">気象庁の地震情報</a><br>出典：${m.credit}`;
  },
  present(f) {
    const p = f.props, h = (Clock.now() - f.time) / 3600000;
    const ago = h < 1 ? `${Math.round(h * 60)}分前` : `${h.toFixed(h < 10 ? 1 : 0)}時間前`;
    return `地震 <span class="num">M${p.mag.toFixed(1)}（USGS）</span>　深さ <span class="num">${p.depth ?? "–"} km</span>　${p.place ?? ""} <span style="color:var(--ink-faint)">（時計の${ago}・震度ではありません）</span>`;
  },
};
if (ON && Catalog.has("quakes")) FEATURE_LAYERS.push(createPointLayer(createFeatureSource("quakes"), QUAKE_PROFILE));

/* ===== 揺れが広がった範囲（USGS ShakeMap の境目の線）を、水面の波紋のように =====
   形は本物（地震計の記録からの推定）、動きは演出。揺れの強さの数字は出さない（マグニチュードで表記、震度は専門の情報へ） */
function createShakeRipples() {
  const all = Catalog.rows("quake-shake").events || [], cmin = Clock.now().getTime() / 60000;
  const evs = all.filter(e => e.tmin <= cmin && e.tmin >= cmin - 24 * 60);
  const pos = [], ord = [], seed = [], col = [];
  evs.forEach((e, k) => {
    const vals = [...new Set(e.lines.map(l => l.v))].sort((a, b) => b - a), n = Math.max(1, vals.length - 1);
    const c = QUAKE_PROFILE.colorOf({ props: { mag: e.mag } }), sd = (k * 0.6180339) % 1, q = [0, 0, 0];
    for (const l of e.lines) { const o = vals.indexOf(l.v) / n;
      for (let i = 2; i < l.c.length; i += 2) for (const j of [i - 2, i]) { toXYZ(l.c[j + 1], l.c[j], 1.0035, q, 0); pos.push(...q); ord.push(o); seed.push(sd); col.push(...c); } }
  });
  if (!pos.length) return { count: 0, tick() {} };
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("aOrd", new THREE.Float32BufferAttribute(ord, 1));
  g.setAttribute("aSeed", new THREE.Float32BufferAttribute(seed, 1)); g.setAttribute("aCol", new THREE.Float32BufferAttribute(col, 3));
  const mat = new THREE.ShaderMaterial({ uniforms: { uT: { value: 0 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `attribute float aOrd; attribute float aSeed; attribute vec3 aCol; varying float vOrd; varying float vSeed; varying vec3 vCol;
      void main(){ vOrd = aOrd; vSeed = aSeed; vCol = aCol; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform float uT; varying float vOrd; varying float vSeed; varying vec3 vCol;
      void main(){ float ph = fract(uT / 6.0 + vSeed);                         /* 6秒ごとに、震源から外へ広がる */
        float w = exp(-pow((ph * 1.3 - vOrd) / 0.11, 2.0));
        float a = 0.07 + w * (1.0 - 0.5 * vOrd);
        gl_FragColor = vec4(mix(vCol, vec3(1.0), 0.35) * a, a); }` });
  const lines = new THREE.LineSegments(g, mat); lines.frustumCulled = false; lines.renderOrder = 3.2; scene.add(lines);
  return { count: evs.length,
    tick(t, on) { lines.visible = on; if (on) mat.uniforms.uT.value = (t / 1000) % 6000; } };
}
let ShakeRipples = null;
if (ON && Catalog.has("quake-shake") && Catalog.has("quakes")) { try { ShakeRipples = createShakeRipples();
  if (ShakeRipples.count) QUAKE_PROFILE.extra = `<b>波紋</b>＝M5以上の地震で、揺れが届いた範囲（<span class="num">${ShakeRipples.count}</span>件）。形は地震計の記録からの推定（USGS ShakeMap）、広がる動きは演出です<br>`;
} catch (e) { console.warn("揺れの波紋を出せませんでした", e); } }

/* ===== 火山（スミソニアン GVP）：地震の「輪」と見分けるため「▲」。ふだんの火山は灰白で拡大すると出る、週報で活動中の火山は溶岩色でゆっくり呼吸する ===== */
const VOLC_TYPE = [["strato", "成層火山"], ["shield", "盾状火山"], ["caldera", "カルデラ"], ["lava dome", "溶岩ドーム"], ["volcanic field", "火山群"], ["submarine", "海底火山"],
  ["complex", "複合火山"], ["pyroclastic", "火砕丘"], ["fissure", "割れ目火口"], ["maar", "マール"], ["tuff", "凝灰岩丘"], ["cone", "火山丘"]];
const ERUPT = { D1: "1964年以降", D2: "1900〜1963年", D3: "1800年代", D4: "1700年代", D5: "1500〜1699年", D6: "西暦1〜1499年", D7: "紀元前", U: "不明（約1万2千年以内）", Q: "不明（約260万年以内）" };
const volcTypeJa = t => { if (!t) return ""; const l = String(t).toLowerCase(), hit = VOLC_TYPE.find(([k]) => l.includes(k)); return hit ? hit[1] : t; };
function createVolcanoLayer() {
  const d = Catalog.rows("volcanoes"), meta = Catalog.meta("volcanoes"), rows = d.rows || [], act = d.active || [];
  const mk = (list, r, size, colorFn, active) => {
    const n = list.length, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    list.forEach((v, i) => { toXYZ(v.lat, v.lon, r, pos, i * 3); col.set(colorFn(v), i * 3); });
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(pos, 3)); g.setAttribute("aCol", new THREE.BufferAttribute(col, 3));
    const mat = new THREE.ShaderMaterial({ uniforms: { uSize: { value: size * renderer.getPixelRatio() }, uShow: { value: 1 }, uT: { value: 0 } }, transparent: true, depthWrite: false,
      vertexShader: `attribute vec3 aCol; uniform float uSize; varying vec3 vCol; void main(){ vCol = aCol; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_PointSize = uSize; }`,
      fragmentShader: `uniform float uShow; uniform float uT; varying vec3 vCol;
        void main(){ vec2 p = gl_PointCoord; float y = p.y, hw = (y - 0.16) / 0.70 * 0.40;                    /* 上が尖った三角（▲） */
          float inside = step(0.16, y) * step(y, 0.86) * step(abs(p.x - 0.5), hw);
          float edge = inside * (1.0 - step(abs(p.x - 0.5), hw - 0.09) * step(y, 0.78));
          ${active ? `float breathe = 0.5 + 0.5 * sin(uT * 1.6); float halo = smoothstep(0.5, 0.0, length(p - vec2(0.5, 0.55))) * (0.25 + 0.35 * breathe);
          float a = max(inside * (0.85 + 0.15 * breathe), halo) * uShow; if (a < 0.02) discard;
          gl_FragColor = vec4(mix(vCol, vec3(1.0, 0.9, 0.6), edge * 0.6 + 0.25 * breathe * inside), a);` :
          `float a = (inside * 0.45 + edge * 0.5) * uShow; if (a < 0.02) discard; gl_FragColor = vec4(vCol, a);`} }` });
    const pts = new THREE.Points(g, mat); pts.renderOrder = 3.1; pts.frustumCulled = false; scene.add(pts); return pts;
  };
  const listAll = rows.map(r => ({ name: r[0], lat: r[1], lon: r[2], type: r[3], elev: r[4], country: r[5], num: r[6], last: r[7] }));
  const quiet = mk(listAll, 1.006, 9, () => [0.86, 0.86, 0.82], false);
  const hot = mk(act, 1.008, 16, () => [1.0, 0.42, 0.12], true);
  let on = false; quiet.visible = hot.visible = false;                  /* 最初は出さない（歯車の「火山」で出す） */
  const nw = act.filter(a => a.status === "new").length;
  return {
    id: "volcanoes", source: { id: "volcanoes", meta }, feats: [],
    profile: {
      describe() {
        return `${act.length ? `<span style="color:rgb(255,110,40)">▲</span> いま活動中 <span class="num">${act.length}</span>か所（週ごとの報告。うち新しい活動 <span class="num">${nw}</span>）　` : ""}<span style="color:#ddd">▲</span> 世界の火山 <span class="num">${rows.length}</span>か所（拡大すると出ます）<br>いま噴火している火山は、この地球儀では出していません。<a href="https://volcano.si.edu/reports_weekly.cfm" target="_blank" rel="noopener" style="color:var(--accent)">いま活動中の火山を見たい人はこちら（スミソニアンの週報）</a><br>地震の「輪」と見分けやすいよう、火山は「▲」で描いています。「プレート」と一緒に出すと、境目に並ぶのが見えます<br>${meta.caution}<br><a href="https://www.data.jma.go.jp/vois/data/tokyo/volcano.html" target="_blank" rel="noopener" style="color:var(--accent)">日本の火山の情報（気象庁）</a>・<a href="https://volcano.si.edu/" target="_blank" rel="noopener" style="color:var(--accent)">世界の火山（スミソニアン）</a><br>出典：${meta.credit}`;
      },
      present(v) {
        if (v.status) return `火山 <span class="num">${v.name}</span>　<span style="color:rgb(255,140,70)">いま活動中</span>（週ごとの報告・${v.status === "new" ? "新しい活動" : "続いている活動"}）<span style="color:var(--ink-faint)">（警報ではありません）</span>`;
        return `火山 <span class="num">${v.name}</span>　${volcTypeJa(v.type)}${v.elev != null ? `　標高 <span class="num">${Math.round(v.elev).toLocaleString()} m</span>` : ""}${v.country ? `　${v.country}` : ""}${ERUPT[v.last] ? `　最後の噴火 <span class="num">${ERUPT[v.last]}</span>` : ""}`;
      },
    },
    set visible(v) { on = v; quiet.visible = v; hot.visible = v; }, get visible() { return on; },
    get shown() { return on; },
    nearest(lon, lat, maxDeg) {
      const near = list => { let best = null, bd = maxDeg; for (const v of list) { const dd = Math.hypot((((v.lon - lon + 540) % 360) - 180) * Math.cos(lat * D2R), v.lat - lat); if (dd < bd) { bd = dd; best = v; } } return best; };
      return near(act) || (quiet.material.uniforms.uShow.value > 0.3 ? near(listAll) : null);
    },
    tick(dist) {
      if (!on) return;
      quiet.material.uniforms.uShow.value = Math.min(1, Math.max(0, (4.6 - dist) / 1.2));   /* 引いた地球では、ふだんの火山は隠す */
      hot.material.uniforms.uT.value = (performance.now() / 1000) % 3600;
    },
  };
}
let VolcanoLayer = null;
if (ON && Catalog.has("volcanoes")) { try { VolcanoLayer = createVolcanoLayer(); FEATURE_LAYERS.push(VolcanoLayer); } catch (e) { console.warn("火山を出せませんでした", e); } }

/* ===== 人工衛星（ISS・天宮・ハッブル・ひまわり・GPS・ガリレオ・みちびき）：時計の約束の例外。「いま」の位置で動く =====
   位置は Actions が軌道要素（CelesTrak）から SGP4 で計算済み。ブラウザは時刻で補間するだけ（見る人から外へは取りに行かない）
   高さは縮めて描く：半径 = 1 + 0.108 × ln(1 + 高度/500km)。ISS はほぼ本物の高さ、ひまわりは本物の約12分の1。どれが上かの順番は本物のまま */
const SAT_STYLE = {
  station:   { color: [1.00, 0.91, 0.66], size: 13, line: "arc",  name: "宇宙ステーション", real: "約400km" },
  telescope: { color: [0.82, 0.86, 1.00], size: 10, line: "arc",  name: "宇宙望遠鏡", real: "約530km" },
  weather:   { color: [0.62, 0.95, 1.00], size: 11,               name: "気象衛星（静止）", real: "約36,000km" },
  gps:       { color: [0.55, 0.70, 1.00], size: 6,                name: "GPS", real: "約20,200km" },
  galileo:   { color: [0.55, 1.00, 0.82], size: 6,                name: "ガリレオ", real: "約23,200km" },
  qzss:      { color: [1.00, 0.70, 0.40], size: 9,  line: "loop", name: "みちびき", real: "約32,000〜39,000km", label: "みちびき" },
};
const satR = alt => 1 + 0.108 * Math.log(1 + Math.max(0, alt) / 500);
function createSatLayer() {
  const id = Catalog.has("sats") ? "sats" : "iss", meta = Catalog.meta(id), raw = Catalog.rows(id);
  const list = id === "sats" ? raw.sats : [{ id: "iss", kind: "station", name: "ISS (ZARYA)", ja: "ISS（国際宇宙ステーション）", label: "ISS NOW", t0: raw.t0, step: raw.step, pts: raw.pts }];
  const sats = list.filter(t => SAT_STYLE[t.kind] && t.pts.length > 1).map(t => { const xyz = new Float32Array(t.pts.length * 3); t.pts.forEach(([la, lo, al], i) => toXYZ(la, lo, satR(al), xyz, i * 3)); return { ...t, st: SAT_STYLE[t.kind], xyz, cur: null }; });
  const at = (s, ms) => { const n = s.pts.length, f = (ms / 1000 - s.t0) / s.step; if (f < 0 || f > n - 1) return null;
    const i = Math.min(n - 2, Math.floor(f)), t = f - i, o = [0, 0, 0];
    for (let k = 0; k < 3; k++) o[k] = s.xyz[i*3+k] + (s.xyz[i*3+3+k] - s.xyz[i*3+k]) * t;
    const r = Math.hypot(...o), a0 = s.pts[i][2], a1 = s.pts[i + 1][2];
    return { p: o, lat: Math.asin(o[1] / r) / D2R, lon: Math.atan2(-o[2], o[0]) / D2R, alt: a0 + (a1 - a0) * t }; };
  const group = new THREE.Group(); group.renderOrder = 4; scene.add(group);
  /* 点：全部の衛星を一つの点群で。色と大きさは種類ごと */
  const N = sats.length, pos = new Float32Array(N * 3), col = new Float32Array(N * 3), siz = new Float32Array(N);
  sats.forEach((s, i) => { col.set(s.st.color, i * 3); siz[i] = s.st.size; });
  const dotGeo = new THREE.BufferGeometry();
  dotGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3)); dotGeo.setAttribute("aCol", new THREE.BufferAttribute(col, 3)); dotGeo.setAttribute("aSize", new THREE.BufferAttribute(siz, 1));
  const dots = new THREE.Points(dotGeo, new THREE.ShaderMaterial({ uniforms: { uPR: { value: renderer.getPixelRatio() }, uT: { value: 0 } }, transparent: true, depthWrite: false,
    vertexShader: `attribute vec3 aCol; attribute float aSize; uniform float uPR; varying vec3 vCol; void main(){ vCol = aCol; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_PointSize = aSize * uPR; }`,
    fragmentShader: `uniform float uT; varying vec3 vCol; void main(){ float r = length(gl_PointCoord - 0.5); if (r > 0.5) discard;
      float core = smoothstep(0.20, 0.10, r), halo = smoothstep(0.5, 0.2, r) * (0.35 + 0.2 * sin(uT * 3.0));
      gl_FragColor = vec4(mix(vCol, vec3(1.0), core * 0.8), max(core, halo)); }` }));
  dots.frustumCulled = false; group.add(dots);
  /* 線：低い衛星は前後46分の通り道（実線＝通った道／点線＝これから）。みちびきは24時間分の「8の字」 */
  const SPAN = 46 * 60000, SEG = 92, arcs = [];
  const mkLine = (n, mat) => { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3)); const l = new THREE.Line(g, mat); l.frustumCulled = false; group.add(l); return l; };
  for (const s of sats) {
    const hex = new THREE.Color(...s.st.color).getHex();
    if (s.st.line === "arc") arcs.push({ s,
      past: mkLine(SEG + 1, new THREE.LineBasicMaterial({ color: hex, transparent: true, opacity: 0.5, depthWrite: false })),
      next: mkLine(SEG + 1, new THREE.LineDashedMaterial({ color: hex, transparent: true, opacity: 0.32, depthWrite: false, dashSize: 0.012, gapSize: 0.01 })) });
    if (s.st.line === "loop") { const l = mkLine(s.pts.length, new THREE.LineBasicMaterial({ color: hex, transparent: true, opacity: 0.28, depthWrite: false })); l.geometry.attributes.position.array.set(s.xyz); l.geometry.attributes.position.needsUpdate = true; }
  }
  const fill = (line, s, from, to) => { const a = line.geometry.attributes.position; let last = null;
    for (let k = 0; k <= SEG; k++) { const q = at(s, from + (to - from) * k / SEG); if (q) last = q.p; if (last) a.setXYZ(k, ...last); }
    a.needsUpdate = true; line.computeLineDistances(); };
  /* 名札：名前のある衛星と、みちびき */
  const labels = sats.map(s => { const text = s.label || s.st.label; if (!text) return null; const sp = makeTextSprite(text, `rgba(${s.st.color.map(c => Math.round(255 * (0.55 + 0.45 * c))).join(",")},0.98)`, 700, s.kind === "station" ? 12.5 : 11); group.add(sp); return sp; });
  const cam = new THREE.Vector3(), wp = new THREE.Vector3(), v3 = new THREE.Vector3();
  /* 地球の陰に隠れているか（カメラから衛星までの線が地球を通るか） */
  const hidden = p => { const c = camera.position, dx = p[0] - c.x, dy = p[1] - c.y, dz = p[2] - c.z, L2 = dx*dx + dy*dy + dz*dz;
    const t = Math.min(1, Math.max(0, -(c.x*dx + c.y*dy + c.z*dz) / L2)); return Math.hypot(c.x + t*dx, c.y + t*dy, c.z + t*dz) < 0.995; };
  let on = true, lastBuild = 0;
  const counts = {}; for (const s of sats) counts[s.kind] = (counts[s.kind] || 0) + 1;
  const fmtKm = a => a >= 10000 ? `${(a / 10000).toFixed(1)}万` : Math.round(a).toLocaleString();
  const layer = {
    id: "sats", source: { id, meta: { ...meta, title: "人工衛星", kind: "計算（軌道要素から）" } }, feats: [],
    profile: {
      describe() {
        const rows = Object.entries(SAT_STYLE).filter(([k]) => counts[k]).map(([k, st]) => `<span style="color:rgb(${st.color.map(c => Math.round(c * 255)).join(",")})">●</span> ${st.name} <span class="num">${counts[k]}</span>機（本当の高さ ${st.real}）`).join("<br>");
        return `ここに出しているのは名前の知られた衛星だけです。宇宙全体で動いている人工衛星は約1万6,600機（2026年9月ごろ。うち約3分の2が Starlink）<br>${rows}<br>上から順に：ひまわり・みちびき ＞ ガリレオ ＞ GPS ＞ ハッブル ＞ 宇宙ステーション。<b>高さは縮めて描いています</b>（順番は本物のまま。ISS はほぼ本物の高さ）<br>ISS・天宮・ハッブル：実線＝さっき通った道、点線＝これから（前後約46分）。みちびき：日本とオーストラリアの上を行き来する「8の字」（1日で一周）。ひまわり：地球と同じ速さで回るので、いつも同じ場所に止まって見える<br>${meta.caution || ""}<br>点をタップで名前と本当の高さ<br><a href="https://spotthestation.nasa.gov/" target="_blank" rel="noopener" style="color:var(--accent)">ISS が肉眼で見える時刻（NASA）</a>・<a href="https://qzss.go.jp/" target="_blank" rel="noopener" style="color:var(--accent)">みちびき（内閣府）</a><br>出典：${meta.credit}`; },
      present(s) { const q = s.cur; return `${s.ja}　<span class="num">${s.name}</span>　本当の高さ 約<span class="num">${fmtKm(q.alt)} km</span>　<span class="num">${Math.abs(q.lat).toFixed(1)}°${q.lat >= 0 ? "N" : "S"} ${Math.abs(q.lon).toFixed(1)}°${q.lon >= 0 ? "E" : "W"}</span> の上空 <span style="color:var(--ink-faint)">（いまの位置・計算値）</span>`; },
    },
    set visible(v) { on = v; group.visible = v; }, get visible() { return on; },
    get shown() { return false; },                                 // 地面のタップ一覧には入れない（衛星は画面上の点でタップ）
    nearest() { return null; },
    tick() {
      if (!on) return;
      const now = Date.now(), h = stage.clientHeight || 800, k = 2 * Math.tan(camera.fov / 2 * D2R) / h;
      let any = false;
      sats.forEach((s, i) => { s.cur = at(s, now); const p = s.cur ? s.cur.p : [0, 0, 0]; pos[i*3] = p[0]; pos[i*3+1] = p[1]; pos[i*3+2] = p[2]; siz[i] = s.cur ? s.st.size : 0; if (s.cur) any = true; });
      dotGeo.attributes.position.needsUpdate = true; dotGeo.attributes.aSize.needsUpdate = true;
      group.visible = any; if (!any) return;
      dots.material.uniforms.uT.value = (now / 1000) % 2094.395;   /* 大きすぎる数を渡すと、スマホの GPU では点が消える（sin が壊れる）。2π/3 の倍数で折り返す */
      if (now - lastBuild > 5000) { lastBuild = now; for (const a of arcs) { fill(a.past, a.s, now - SPAN, now); fill(a.next, a.s, now, now + SPAN); } }
      for (const a of arcs) if (a.s.cur) { a.past.geometry.attributes.position.setXYZ(SEG, ...a.s.cur.p); a.past.geometry.attributes.position.needsUpdate = true;
        a.next.geometry.attributes.position.setXYZ(0, ...a.s.cur.p); a.next.geometry.attributes.position.needsUpdate = true; a.next.computeLineDistances(); }
      labels.forEach((sp, i) => { if (!sp) return; const s = sats[i]; if (!s.cur || hidden(s.cur.p)) { sp.visible = false; return; }
        wp.set(...s.cur.p); const r = wp.length(); wp.multiplyScalar((r + 0.03) / r); sp.position.copy(wp); sp.visible = true;
        const sc = sp.userData.px * k; sp.scale.set(sc * sp.userData.aspect, sc, 1); });
    },
    /** 画面上で一番近い衛星（タップ用）。地球の陰にあるものは選ばない */
    pickScreen(ndcPt) { let best = null, bd = 0.05;
      for (const s of sats) { if (!s.cur || hidden(s.cur.p)) continue; v3.set(...s.cur.p).project(camera);
        const d = Math.hypot(v3.x - ndcPt.x, (v3.y - ndcPt.y) * (stage.clientHeight / stage.clientWidth || 1)); if (d < bd) { bd = d; best = s; } }
      return best; },
  };
  return layer;
}
let SatLayer = null;
if (ON && (Catalog.has("sats") || Catalog.has("iss"))) { try { SatLayer = createSatLayer(); FEATURE_LAYERS.push(SatLayer); } catch (e) { console.warn("人工衛星を出せませんでした", e); } }

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
      const [u, v] = field.sample(lon[i], lat[i], Clock.now()), ws = windScale;
      const sp = Math.hypot(u, v);
      toXYZ(lat[i], lon[i], R, tmpA, 0);
      const c = Math.max(0.15, Math.cos(lat[i] * D2R));
      lat[i] += v * STEP / ws * dtScale; lon[i] += u * STEP / ws * dtScale / c;
      if (lon[i] > 180) lon[i] -= 360; else if (lon[i] < -180) lon[i] += 360;
      age[i] += dtScale;
      const vi = v0 + i * 2, p = vi * 3;
      if (age[i] > life[i] || lat[i] > 85 || lat[i] < -85 || sp < 0.2) {
        spawn(i); birth[vi] = birth[vi+1] = -1e6; continue;
      }
      toXYZ(lat[i], lon[i], R, tmpB, 0);
      pos[p] = tmpA[0]; pos[p+1] = tmpA[1]; pos[p+2] = tmpA[2]; pos[p+3] = tmpB[0]; pos[p+4] = tmpB[1]; pos[p+5] = tmpB[2];
      birth[vi] = birth[vi+1] = frame; spd[vi] = spd[vi+1] = sp / ws;   // 色は高さごとの幅で
    }
    aPos.updateRange.offset = v0 * 3; aPos.updateRange.count = N * 6; aPos.needsUpdate = true;
    aBirth.updateRange.offset = v0; aBirth.updateRange.count = N * 2; aBirth.needsUpdate = true;
    aSpd.updateRange.offset = v0; aSpd.updateRange.count = N * 2; aSpd.needsUpdate = true;
    mat.uniforms.uTime.value = frame;
  }
  return { step, count: N, lines, set visible(v) { lines.visible = v; }, get visible() { return lines.visible; } };
})();

/* ===== カメラと操作 ===== */
const controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.enablePan = false; controls.enableDamping = true; controls.dampingFactor = 0.08;
controls.rotateSpeed = 0.45; controls.zoomSpeed = 0.6; controls.minDistance = 1.3; controls.maxDistance = 10;   /* 人工衛星の外側（ひまわり）まで入るよう遠くまで引ける */
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
const drawWindTicks = () => { document.getElementById("d-ticks").innerHTML = [0, 10, 20, 30].map(v => `<span>${Math.round(v * windScale)}${v === 30 ? " m/s" : ""}</span>`).join(""); };
drawWindTicks();
/** 風の高さを切り替える（上空の風は、このとき初めて読み込む） */
async function setWindLevel(k) {
  const L = WIND_LEVELS[k]; if (!Catalog.has(L.id)) return;
  if (!flowCache[L.id]) { await Catalog.load(L.id); flowCache[L.id] = createGridFlowField(L.id); }
  field = flowCache[L.id]; windScale = L.scale;
  const m = Catalog.meta(L.id); document.getElementById("d-level").textContent = `${m.level}・${m.kind}`;
  drawWindTicks();
}

/* 層ごとの説明：どのデータも同じ書式で、目録のメタデータから作る */
const fmtSpan = m => m.validFrom ? `${m.validFrom.slice(0,16).replace("T"," ")}〜${m.validTo.slice(11,16)} UTC` : `${m.validTime.slice(0,16).replace("T"," ")} UTC`;
function layerBlock(id, opts) {
  const m = Catalog.meta(id), ok = Catalog.validAt(id, Clock.now());
  const legend = opts.profile && opts.profile.stops ? `<div class="legend"><div class="cap">${opts.profile.label}</div><div class="bar" style="background:linear-gradient(90deg, ${opts.profile.stops.map(([s, c], k) => `rgba(${c.slice(0,3).map(x => Math.round(x*255)).join(",")},${Math.max(c[3], .5)}) ${(k / (opts.profile.stops.length - 1) * 100).toFixed(0)}%`).join(", ")})"></div><div class="ticks">${opts.profile.ticks.map(v => `<span>${v}</span>`).join("")}</div></div>` : "";
  return `<div class="layer">
    <label><input type="checkbox" id="t-${id}" ${opts.visible ? "checked" : ""}> ${m.title}<span style="font-weight:400;color:var(--ink-faint);font-size:11.5px">　${m.kind}</span></label>
    <div class="sub">${fmtSpan(m)}${m.selection ? (() => { const mn = Math.round((Clock.now() - new Date(m.validTime)) / 60000); return `（時計の <span class="num">${mn >= 1440 ? (mn / 1440).toFixed(1) + "日" : mn + "分"}</span>前のデータ）`; })() : ""}・${m.resolution || ""}${m.coverage ? "・" + m.coverage : ""}${m.caution ? "<br>" + m.caution : ""}<br>出典：${m.credit}${m.sampleCredit ? "（" + m.sampleCredit + "）" : ""}</div>
    ${ok ? "" : `<div class="sub warn">地球儀の時計（${fmtUTC(Clock.now())}）とは別の時刻のデータです</div>`}
    ${legend}</div>`;
}
/* 物の層の説明：データ時刻は一つではないので、時計との差の幅で見せる */
function featureBlock(l) {
  if (l.profile.describe) return `<div class="layer">
    <label><input type="checkbox" id="t-${l.id}" ${l.visible ? "checked" : ""}> ${l.source.meta.title}<span style="font-weight:400;color:var(--ink-faint);font-size:11.5px">　${l.source.meta.kind}</span></label>
    <div class="sub">${l.profile.describe(l)}</div></div>`;
  const m = l.source.meta, ages = l.feats.map(f => (Clock.now() - f.time) / 60000).sort((a, b) => a - b);
  const med = ages.length ? Math.round(ages[ages.length >> 1]) : null;
  return `<div class="layer">
    <label><input type="checkbox" id="t-${l.id}" ${l.visible ? "checked" : ""}> ${m.title}<span style="font-weight:400;color:var(--ink-faint);font-size:11.5px">　${m.kind}</span></label>
    <div class="sub">時計の前 ${m.selection.maxAgeMin}分以内で一番新しい観測・<span class="num">${ages.length}</span>地点${med !== null ? `（まん中は <span class="num">${med}</span>分前）` : ""}<br>${m.coverage}<br>拡大すると点が出ます・点をタップで観測値<br>出典：${m.credit}</div>
    ${ages.length ? "" : `<div class="sub warn">時計の時刻に合う観測がありません</div>`}</div>`;
}
document.getElementById("d-layers").innerHTML = SCALAR_LAYERS.map(l => layerBlock(l.id, { visible: l.visible, profile: l.profile })).join("")
  + FEATURE_LAYERS.map(featureBlock).join("")
  + (true ? `<div class="layer"><label>${NIGHT_LIGHTS.title}<span style="font-weight:400;color:var(--ink-faint);font-size:11.5px">　${NIGHT_LIGHTS.kind}</span></label>
      <div class="sub">${NIGHT_LIGHTS.note}<br>出典：${NIGHT_LIGHTS.credit}</div></div>` : "")
  + (ON ? `<div class="layer"><label>${LAND_ICE.title}<span style="font-weight:400;color:var(--ink-faint);font-size:11.5px">　${LAND_ICE.kind}</span></label>
      <div class="sub">${LAND_ICE.note}<br>出典：${LAND_ICE.credit}</div></div>` : "")
  + (StateLayer ? `<div class="layer"><label>${StateLayer.info.title}<span style="font-weight:400;color:var(--ink-faint);font-size:11.5px">　${StateLayer.info.kind}</span></label>
      <div class="sub">${StateLayer.info.note}<br>出典：${StateLayer.info.credit}</div></div>` : "")
  + (CapitalLayer ? `<div class="layer"><label>${CapitalLayer.info.title}<span style="font-weight:400;color:var(--ink-faint);font-size:11.5px">　${CapitalLayer.info.kind}</span></label>
      <div class="sub">${CapitalLayer.info.note}<br>出典：${CapitalLayer.info.credit}</div></div>` : "")
  + (GuideLayer ? `<div class="layer"><label>${GuideLayer.info.title}<span style="font-weight:400;color:var(--ink-faint);font-size:11.5px">　${GuideLayer.info.kind}</span></label>
      <div class="sub">${GuideLayer.info.note}<br>出典：${GuideLayer.info.credit}</div></div>` : "")
  + (AuroraLayer ? `<div class="layer"><label>${AuroraLayer.info.title}<span style="font-weight:400;color:var(--ink-faint);font-size:11.5px">　${AuroraLayer.info.kind}</span></label>
      <div class="sub">${AuroraLayer.info.note}<br>出典：${AuroraLayer.info.credit}</div></div>` : "")
  + (SkyLayer ? `<div class="layer"><label>${SKY_INFO.title}<span style="font-weight:400;color:var(--ink-faint);font-size:11.5px">　${SKY_INFO.kind}</span></label>
      <div class="sub">${SKY_INFO.note}${SkyLayer.radiants.length ? "<br>いまの時期の流星群：" + SkyLayer.radiants.map(r => `${r.name}（極大 ${r.peak}）`).join("、") + "。見える数は年や月明かり・雲で大きく変わります" : ""}<br>出典：${SKY_INFO.credit}</div></div>` : "");
for (const l of FEATURE_LAYERS) document.getElementById("t-" + l.id).addEventListener("change", e => { l.visible = e.target.checked; if (typeof syncChips === "function") syncChips(); });

/* 見せ方の切り替え（試作）：流れる地球／ふつうの地球儀／重ねる */
if (MapLayer) {
  const MODES = {
    flow:  { label: "流れる地球",     wind: true,  scalar: true,  map: false, night: 1 },
    globe: { label: "ふつうの地球儀", wind: false, scalar: false, map: true,  night: 0 },
    both:  { label: "重ねる",         wind: true,  scalar: true,  map: true,  night: 1 },
    names: { label: "地名",           wind: false, scalar: false, map: true,  night: 0, names: true },
  };
  const box = document.createElement("div"); box.className = "modes";
  box.innerHTML = `<div class="seg" role="group" aria-label="見せ方">${Object.entries(MODES).map(([k, m]) => `<button type="button" data-mode="${k}">${m.label}</button>`).join("")}</div>
    <div class="presets" role="group" aria-label="見方のプリセット"><span class="cap">見方のセット</span></div>
    <div class="chips" role="group" aria-label="層を出す・消す"></div>
    <p class="note names-note" hidden>地名の地球儀：文字が見やすいよう、出せる層をしぼっています（国境・地名、首都、赤道・日付変更線、プレート、地震、火山）。拡大すると県・州も出ます（一部の国）。ほかのモードに戻ると、前の状態に戻ります</p>
    ${WIND_LEVELS.slice(1).some(L => Catalog.has(L.id)) ? `<div class="windh"><div class="seg small" role="group" aria-label="風の高さ">${WIND_LEVELS.filter(L => Catalog.has(L.id)).map(L => `<button type="button" data-wlev="${WIND_LEVELS.indexOf(L)}" aria-pressed="${L.id === "wind-10m"}">${L.label}</button>`).join("")}</div>
      <p class="note">風の高さ：上に行くほど地球規模の流れ（偏西風・ジェット気流）が見えます。上空の線は速さに合わせて色の幅を変えています</p></div>` : ""}
    <div class="viewbox"><div class="seg small" role="group" aria-label="国境の見方">${Object.entries(MapLayer.views).map(([k, t]) => `<button type="button" data-view="${k}">${t}</button>`).join("")}</div>
    <p class="note">国境の見方は二つから選べます。どちらも Natural Earth（パブリックドメイン）の見方別データです。</p></div>`;
  const detailEl = document.getElementById("detail"); detailEl.insertBefore(box, detailEl.firstChild);   // 切り替えは一番上に（スクロールなしで届く）
  /* 層の出し入れを、小さなボタンの列で。下の説明のチェックとも同じ状態を共有する */
  const layerById = id => SCALAR_LAYERS.find(l => l.id === id) || FEATURE_LAYERS.find(l => l.id === id);
  const setLayer = (id, v) => { const l = layerById(id); if (!l) return; l.visible = v; l.userOn = v; const cb = document.getElementById("t-" + id); if (cb) cb.checked = v; };
  var CHIPS = [
    { key: "wind", label: "風", get: () => VisualParticles.visible, set: v => { VisualParticles.visible = v; } },
    { key: "rain", label: "雨", get: () => layerById("rain")?.visible, set: v => setLayer("rain", v) },
    { key: "cloud-ir", label: "雲", get: () => layerById("cloud-ir")?.visible, set: v => setLayer("cloud-ir", v) },
    { key: "pressure", label: "気圧", get: () => layerById("pressure")?.visible, set: v => setLayer("pressure", v) },
    { key: "sst-anom", label: "海水温（平年差）", get: () => layerById("sst-anom")?.visible, set: v => setLayer("sst-anom", v) },
    { key: "sea-ice", label: "海氷", get: () => layerById("sea-ice")?.visible, set: v => setLayer("sea-ice", v) },
    { key: "quakes", label: "地震", get: () => layerById("quakes")?.visible, set: v => setLayer("quakes", v) },
    { key: "volcanoes", label: "火山", get: () => layerById("volcanoes")?.visible, set: v => setLayer("volcanoes", v) },
    { key: "sats", label: "人工衛星", get: () => layerById("sats")?.visible, set: v => setLayer("sats", v) },
    { key: "aurora", label: "オーロラ帯", get: () => AuroraLayer?.visible, set: v => { if (AuroraLayer) { AuroraLayer.visible = v; AuroraLayer.userOn = v; } } },
    { key: "milky", label: "天の川", get: () => SkyLayer?.milky, set: v => { if (SkyLayer) SkyLayer.milky = v; } },
    { key: "plates", label: "プレート", get: () => PlateLayer?.visible, set: v => { if (PlateLayer) { PlateLayer.visible = v; PlateLayer.userOn = v; const cb = document.getElementById("t-plates"); if (cb) cb.checked = v; } } },
    { key: "guide", label: "赤道・日付変更線", get: () => GuideLayer?.visible, set: v => { if (GuideLayer) { GuideLayer.visible = v; GuideLayer.userOn = v; } } },
    { key: "capitals", label: "★ 首都", get: () => CapitalLayer?.visible, set: v => { if (CapitalLayer) CapitalLayer.visible = v; } },
    { key: "map", label: "国境・地名", get: () => MapLayer.visible, set: v => { MapLayer.visible = v; box.querySelector(".viewbox").hidden = !v; } },
    { key: "sky", label: "✦ 星座", get: () => SkyLayer?.visible, set: v => { if (SkyLayer) SkyLayer.visible = v; } },
  ].filter(c => c.key === "wind" || c.key === "map" || ((c.key === "sky" || c.key === "milky") ? !!SkyLayer : c.key === "guide" ? !!GuideLayer : c.key === "aurora" ? !!AuroraLayer : c.key === "plates" ? !!PlateLayer : c.key === "capitals" ? !!CapitalLayer : !!layerById(c.key)));
  /* 見方のセット（プリセット）：物語ごとに、関係が見える組み合わせをまとめて出す。そこから1つずつ足し引きもできる。
     国境・地名、赤道・日付変更線は「下敷き」なので、セットでは変えない */
  const PRESETS = [
    { key: "earth", label: "動く大地", on: ["plates", "quakes", "volcanoes"] },
    { key: "fluid", label: "動く空と海", on: ["wind", "cloud-ir", "rain", "pressure", "sst-anom", "sea-ice"] },
    { key: "night", label: "夜空", on: ["sky", "milky", "aurora"] },
    { key: "space", label: "宇宙", on: ["sats", "aurora", "milky"], far: 8 },
  ];
  const KEEP = ["map", "guide"];
  const applyPreset = P => {
    for (const c of CHIPS) { if (KEEP.includes(c.key)) continue; const want = P.on.includes(c.key); if (!!c.get() !== want) c.set(want); }
    if (P.far && camera.position.length() < P.far) camera.position.setLength(P.far);   /* 宇宙は、衛星が入るところまで引く */
    syncChips(); updateChip();
  };
  box.querySelector(".chips").innerHTML = CHIPS.map(c => `<button type="button" data-chip="${c.key}">${c.label}</button>`).join("");
  box.querySelector(".presets").insertAdjacentHTML("beforeend", PRESETS.filter(P => P.on.some(k => CHIPS.find(c => c.key === k))).map(P => `<button type="button" data-preset="${P.key}">${P.label}</button>`).join(""));
  var syncChips = () => box.querySelectorAll("[data-chip]").forEach(b => b.setAttribute("aria-pressed", String(!!CHIPS.find(c => c.key === b.dataset.chip).get())));
  /* 地名の地球儀：文字が見やすいよう、選べる層をしぼった固定モード。入る前の状態を覚えておき、出るときに戻す */
  const NAMES_OK = ["map", "capitals", "guide", "plates", "quakes", "volcanoes"], NAMES_OFF_AT_START = ["quakes", "volcanoes", "plates"];
  const OVERLAYS = ["quakes", "volcanoes", "plates", "sats", "aurora", "milky", "sky", "capitals"];
  let curMode = null, saved = null;
  const setMode = k => {
    const m = MODES[k];
    if (k === "names" && curMode !== "names") saved = Object.fromEntries(CHIPS.map(c => [c.key, !!c.get()]));
    VisualParticles.visible = m.wind; MapLayer.visible = m.map; globe.material.uniforms.uNight.value = m.night;
    if (GuideLayer) GuideLayer.visible = Boolean(m.map || GuideLayer.userOn);   /* ふつうの地球儀では最初から出す。流れる地球では自分で出したときだけ */
    for (const l of SCALAR_LAYERS) { const v = Boolean(!m.names && (m.scalar || l.profile.ground) && (!l.profile.modes || l.profile.modes.includes(k)) && (!l.profile.optIn || l.userOn)) /* undefined だと three.js は「見える」と扱うので必ず真偽値に */; l.visible = v; const cb = document.getElementById("t-" + l.id); if (cb) cb.checked = v; }
    box.querySelectorAll("[data-mode]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.mode === k)));
    box.querySelector(".viewbox").hidden = !m.map;
    document.getElementById("d-mode").textContent = m.names ? "地名" : m.wind ? "風" : "地球儀";
    if (m.names) {
      for (const c of CHIPS) if ((!NAMES_OK.includes(c.key) || NAMES_OFF_AT_START.includes(c.key)) && c.get()) c.set(false);
      if (CapitalLayer && !CapitalLayer.visible) CapitalLayer.visible = true;
    } else if (curMode === "names" && saved) {
      for (const c of CHIPS) if (OVERLAYS.includes(c.key) && saved[c.key] !== undefined && !!c.get() !== saved[c.key]) c.set(saved[c.key]);
      saved = null;
    }
    box.querySelectorAll("[data-chip]").forEach(b => { b.disabled = !!m.names && !NAMES_OK.includes(b.dataset.chip); });
    box.querySelectorAll("[data-preset]").forEach(b => { b.disabled = !!m.names; });
    const wh = box.querySelector(".windh"); if (wh) wh.hidden = !!m.names;
    box.querySelector(".names-note").hidden = !m.names;
    curMode = k; NamesMode = !!m.names;
    syncChips();
    updateChip();
  };
  const setView = v => { MapLayer.view = v; box.querySelectorAll("[data-view]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.view === v))); };
  box.addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.wlev) { const k = +b.dataset.wlev; setWindLevel(k).then(() => box.querySelectorAll("[data-wlev]").forEach(x => x.setAttribute("aria-pressed", String(x === b)))); return; }
    if (b.dataset.preset) { applyPreset(PRESETS.find(P => P.key === b.dataset.preset)); return; }
    if (b.dataset.chip) { const c = CHIPS.find(c => c.key === b.dataset.chip); c.set(!c.get()); syncChips(); return; }   /* 一つだけ出す・消す。他の層は勝手に消さない */
    if (b.dataset.mode) setMode(b.dataset.mode); if (b.dataset.view) setView(b.dataset.view); });
  setView("jp"); setMode("flow");
}
for (const l of SCALAR_LAYERS) document.getElementById("t-" + l.id).addEventListener("change", e => { l.visible = e.target.checked; updateChip(); if (typeof syncChips === "function") syncChips(); });
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
/* 地点の値：項目が増えたので、行に分けて、量に応じて長めに出す（8〜20秒）。次のタップで入れ替わる */
function showPick(html) {
  peekPick.innerHTML = html; peekPick.hidden = false; clearTimeout(pickTimer);
  const ms = Math.min(20000, Math.max(8000, 3000 + peekPick.textContent.length * 90));
  pickTimer = setTimeout(() => (peekPick.hidden = true), ms);
}


/* 地点タップ：問い合わせ口から、その地点の風を聞く */
const raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2();
const DIRS = ["北","北北東","北東","東北東","東","東南東","南東","南南東","南","南南西","南西","西南西","西","西北西","北西","北北西"];
/** 観測の見せ方：何分前の、どこの、実際に測った値か */
function presentObs(f) {
  const p = f.props, age = Math.round((Clock.now() - f.time) / 60000), bits = [];
  if (p.temp !== null) bits.push(`気温 <span class="num">${p.temp.toFixed(0)}°C</span>`);
  if (p.wspd !== null) bits.push(`風 ${p.wdir === "VRB" ? "向き不定" : p.wdir !== null && p.wspd > 0 ? DIRS[Math.round(p.wdir / 22.5) % 16] : ""} <span class="num">${p.wspd.toFixed(1)} m/s</span>${p.wgst ? `（最大 <span class="num">${p.wgst.toFixed(0)}</span>）` : ""}`);
  if (p.wx) bits.push(`天気 <span class="num">${p.wx}</span>`);
  return `<span class="num">${p.id}</span> ${bits.join("　")} <span style="color:var(--ink-faint)">（観測・${age}分前）</span>`;
}
let down = null;
renderer.domElement.addEventListener("pointerdown", e => { down = [e.clientX, e.clientY]; hideHint(); });
renderer.domElement.addEventListener("pointerup", e => {
  if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6) return;
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const sat = SatLayer?.visible && SatLayer.pickScreen(ndc); if (sat) { showPick(SatLayer.profile.present(sat)); return; }   /* 衛星は画面上の点でタップ */
  const hit = raycaster.intersectObject(globe)[0]; if (!hit) return;
  const n = hit.point.clone().normalize(), la = Math.asin(n.y) / D2R, lo = Math.atan2(-n.z, n.x) / D2R;
  const [u, v] = field.sample(lo, la, Clock.now()), sp = Math.hypot(u, v), from = (Math.atan2(-u, -v) / D2R + 360) % 360;
  const ll = `${Math.abs(la).toFixed(1)}°${la >= 0 ? "N" : "S"} ${Math.abs(lo).toFixed(1)}°${lo >= 0 ? "E" : "W"}`;
  document.getElementById("d-pick").innerHTML = `<span class="num">${ll}</span>　風速${field.meta.level && field.meta.level !== "地上10m" ? "（" + field.meta.level.replace(/（.*）/, "") + "）" : ""} <span class="num">${sp.toFixed(1)} m/s</span>　${DIRS[Math.round(from / 22.5) % 16]}の風 <span style="color:var(--ink-faint)">（${wm.kind}・格子から補間）</span>`
    + SCALAR_LAYERS.filter(l => l.visible).map(l => presentValue(l, l.field.sample(lo, la, Clock.now()))).filter(Boolean).map(t => "<br>" + t).join("")
    + FEATURE_LAYERS.filter(l => l.shown).map(l => { const f = l.nearest(lo, la, 0.5 + 1.2 * (camera.position.length() - 1)); return f ? "<br>" + (l.profile.present ? l.profile.present(f) : presentObs(f)) : ""; }).join("");
  showPick(document.getElementById("d-pick").innerHTML.replace(/<span style="color:var\(--ink-faint\)">[^<]*<\/span>/g, ""));   // 項目ごとに改行したまま
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
  if (VisualParticles.visible) VisualParticles.step(Math.min(dt / 16.667, 3));
  MapLayer?.tick(); CapitalLayer?.tick(); StateLayer?.tick(); SkyLayer?.tick(); GuideLayer?.tick(); AuroraLayer?.tick(now); ShakeRipples?.tick(now, !!FEATURE_LAYERS.find(l => l.id === "quakes")?.visible);
  Spin.tick(); controls.update();
  for (const l of FEATURE_LAYERS) l.tick(camera.position.length());
  renderer.render(scene, camera);
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
