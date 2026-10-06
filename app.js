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
    bytes(id) { return new Uint8Array(bufs[id]); },
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
let spinAngle = 0;   /* 自転の演出で回した角度（ラジアン。西回りなので負）。星の枠もこの分だけ回す */
const globe = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 96), new THREE.ShaderMaterial({
  uniforms: { uLand: { value: buildLandMask() }, uSun: { value: sunDir }, uNight: { value: 1 }, uLights: { value: null }, uLightsOn: { value: 0 }, uIce: { value: null }, uIceOn: { value: 0 }, uBathy: { value: null }, uBathyOn: { value: 0 }, uCut: { value: 0 }, uN1: { value: new THREE.Vector3() }, uN2: { value: new THREE.Vector3() } },
  vertexShader: `varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D uLand; uniform sampler2D uLights; uniform sampler2D uIce; uniform float uIceOn; uniform sampler2D uBathy; uniform float uBathyOn; uniform vec3 uSun; uniform float uNight; uniform float uLightsOn; varying vec3 vPos;
    uniform float uCut; uniform vec3 uN1; uniform vec3 uN2;
    const float PI = 3.141592653589793;
    void main(){
      if (uCut > 0.5 && dot(vPos, uN1) > 0.0 && dot(vPos, uN2) > 0.0) discard;   /* 地球の中（断面）：切り取った部分 */
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
  extrema: { radius: 6, minDrop: 4 },                            // 低・高の中心に気圧の数字を出す（まわり±6°で一番低い／高い所、まわりより4hPa以上の差）
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
  /* 低気圧・高気圧の中心：まわりで一番低い（高い）所に「低 984」「高 1028」と数字を出す。台風かどうかの判定はしない */
  const marks = [];
  if (profile.extrema) {
    const R = profile.extrema.radius, drop = profile.extrema.minDrop;
    for (let j = R; j < ny - R; j++) { const lat = g.lat0 - j * g.dy; if (Math.abs(lat) > 78) continue;
      for (let i = 0; i < nx; i++) { const v = at(i, j); if (Number.isNaN(v)) continue;
        let isMin = true, isMax = true, mx = -Infinity, mn = Infinity;
        for (let dj = -R; dj <= R && (isMin || isMax); dj++) for (let di = -R; di <= R; di++) { if (!di && !dj) continue; const w = at(i + di, j + dj); if (Number.isNaN(w)) continue;
          if (w < v || (w === v && (dj < 0 || (dj === 0 && di < 0)))) isMin = false; if (w > v || (w === v && (dj < 0 || (dj === 0 && di < 0)))) isMax = false; if (w > mx) mx = w; if (w < mn) mn = w; }
        if (isMin && mx - v >= drop) marks.push({ low: true, v, lat, lon: g.lon0 + i * g.dx });
        if (isMax && v - mn >= drop) marks.push({ low: false, v, lat, lon: g.lon0 + i * g.dx }); } }
    for (const m of marks) { const sp = makeTextSprite(`${m.low ? "低" : "高"} ${Math.round(m.v)}`, m.low ? "rgba(150,190,255,0.98)" : "rgba(255,190,150,0.95)", 700, 12);
      toXYZ(m.lat, m.lon, 1.006, tmp, 0); sp.position.set(...tmp); group.add(sp); m.sp = sp; }
  }
  const cam = new THREE.Vector3(), wp = new THREE.Vector3();
  let op = 1;
  return { id, field, profile, marks, set visible(v) { group.visible = v; }, get visible() { return group.visible; },
    tick() { if (!group.visible || !marks.length) return; const h = stage.clientHeight || 800, k = 2 * Math.tan(camera.fov / 2 * D2R) / h; cam.copy(camera.position).normalize();
      for (const m of marks) { wp.copy(m.sp.position).normalize(); const ok = wp.dot(cam) > 0.25; m.sp.visible = ok; if (ok) { const sc = m.sp.userData.px * k; m.sp.scale.set(sc * m.sp.userData.aspect, sc, 1); } } },
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
      frame.rotation.y = -gmstDeg(Clock.now()) * D2R + spinAngle;   // 経度＝赤経−恒星時（自転の演出中は回した分を足す）
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
    group,
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
  const list = id === "sats" ? raw.sats.map(t => t.label === "ISS NOW" ? { ...t, label: "ISS" } : t) /* 名前だけの表記にそろえる（取得済みのデータにも効くよう、ここでも直す） */ : [{ id: "iss", kind: "station", name: "ISS (ZARYA)", ja: "ISS（国際宇宙ステーション）", label: "ISS", t0: raw.t0, step: raw.step, pts: raw.pts }];
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
  const coast = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xa9b8d6, transparent: true, opacity: 0.28 }));
  scene.add(coast); window.__coast = coast;   /* 地球の中（断面）で切り口の上の海岸線を消すために参照を残す */
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
  const pos = new Float32Array(V * 3), birth = new Float32Array(V).fill(-1e6), spd = new Float32Array(V), dirA = new Float32Array(V), latA = new Float32Array(V);
  const geo = new THREE.BufferGeometry();
  const aPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const aBirth = new THREE.BufferAttribute(birth, 1).setUsage(THREE.DynamicDrawUsage);
  const aSpd = new THREE.BufferAttribute(spd, 1).setUsage(THREE.DynamicDrawUsage);
  const aDir = new THREE.BufferAttribute(dirA, 1).setUsage(THREE.DynamicDrawUsage), aLat = new THREE.BufferAttribute(latA, 1).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("position", aPos); geo.setAttribute("aBirth", aBirth); geo.setAttribute("aSpeed", aSpd); geo.setAttribute("aDir", aDir); geo.setAttribute("aLat", aLat);
  const stopsGLSL = LINE_STOPS.map(([s, c], i) => `if (s <= ${s.toFixed(1)}) { ${i ? `float t=(s-${LINE_STOPS[i-1][0].toFixed(1)})/${(s - LINE_STOPS[i-1][0]).toFixed(1)}; return mix(vec3(${LINE_STOPS[i-1][1].join(",")}),vec3(${c.join(",")}),t);` : `return vec3(${c.join(",")});`} }`).join("\n");
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uTrail: { value: SLOTS }, uDirMode: { value: 0 }, uBandOn: { value: 0 }, uBand: { value: new THREE.Vector2(0, 90) }, uJet: { value: 0 } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `
      attribute float aBirth; attribute float aSpeed; attribute float aDir; attribute float aLat; uniform float uTime; uniform float uTrail;
      varying float vA; varying float vS; varying float vDir; varying float vLat;
      void main(){
        float a = (uTime - aBirth) / uTrail;
        vA = a; vS = aSpeed; vDir = aDir; vLat = aLat;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
      }`,
    fragmentShader: `
      uniform float uDirMode; uniform float uBandOn; uniform vec2 uBand; uniform float uJet;
      varying float vA; varying float vS; varying float vDir; varying float vLat;
      vec3 ramp(float s){ ${stopsGLSL}
        return vec3(${LINE_STOPS[LINE_STOPS.length-1][1].join(",")}); }
      void main(){
        if (vA < 0.0 || vA > 1.0) discard;
        float fade = pow(1.0 - vA, 1.6);
        float strength = mix(0.22, 1.0, smoothstep(1.0, 15.0, vS));
        vec3 col = ramp(vS);
        if (uDirMode > 0.5) col = mix(vec3(0.30, 0.72, 1.00), vec3(1.00, 0.60, 0.28), smoothstep(-0.25, 0.25, vDir));   /* 西へ吹く＝青、東へ吹く＝橙 */
        float k = 1.0;
        if (uBandOn > 0.5) { float al = abs(vLat); k = mix(0.12, 1.0, smoothstep(uBand.x - 4.0, uBand.x + 2.0, al) * (1.0 - smoothstep(uBand.y - 2.0, uBand.y + 4.0, al))); }   /* 目安の緯度帯の外は薄く */
        if (uJet > 0.0) k *= mix(0.2, 1.0, smoothstep(uJet * 0.7, uJet, vS));   /* ジェット気流：速い線だけ明るく */
        gl_FragColor = vec4(col * fade * strength * k, 1.0);
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
      dirA[vi] = dirA[vi+1] = sp > 0 ? u / sp : 0; latA[vi] = latA[vi+1] = lat[i];
    }
    aPos.updateRange.offset = v0 * 3; aPos.updateRange.count = N * 6; aPos.needsUpdate = true;
    aBirth.updateRange.offset = v0; aBirth.updateRange.count = N * 2; aBirth.needsUpdate = true;
    aSpd.updateRange.offset = v0; aSpd.updateRange.count = N * 2; aSpd.needsUpdate = true;
    for (const A of [aDir, aLat]) { A.updateRange.offset = v0; A.updateRange.count = N * 2; A.needsUpdate = true; }
    mat.uniforms.uTime.value = frame;
  }
  const U = mat.uniforms;
  return { step, count: N, lines, set visible(v) { lines.visible = v; }, get visible() { return lines.visible; },
    /** 見せ方：東西の色分け・目安の緯度帯・ジェット気流の強調（データは変えない） */
    set dirMode(v) { U.uDirMode.value = v ? 1 : 0; }, get dirMode() { return U.uDirMode.value > 0.5; },
    setBand(b, jet = 0) { U.uBandOn.value = b ? 1 : 0; if (b) U.uBand.value.set(b[0], b[1]); U.uJet.value = jet; } };
})();

/* ===== 海流（いつもの流れ）：NOAA AOML 漂流ブイの月平均。風の線とは別の見せ方 =====
   ・線の色＝水温（同じブイの記録の平年値）。暖流は赤〜橙、寒流は青で、海が熱を運ぶのが見える
   ・線は風より少しだけ太い（画面の上で太さを持たせた帯で描く。WebGL の線は1画素より太くできないため）
   ・選ばれたときだけ読む（lazy）。出している間、風の線はお休み（重ねるとごちゃつくため。やめると元に戻す） */
const CurrentLayer = (() => {
  if (!Catalog.has("currents")) return null;
  const meta = Catalog.meta("currents"), g = Catalog.gridInfo("currents");
  const N = window.innerWidth < 700 ? 2400 : 4500, SLOTS = 32, STEP = 0.1, R = 1.0045;
  let U = null, V = null, T = null, cells = null, ready = false, on = false, built = false, onChange = null;
  let lines = null, mat = null, attr = null, frame = 0;
  const lat = new Float32Array(N), lon = new Float32Array(N), age = new Float32Array(N), life = new Float32Array(N);
  async function load() {
    if (ready) return;
    await Catalog.load("currents");
    const raw = Catalog.grid("currents").raw, n = g.nx * g.ny, M = g.missing;
    U = new Float32Array(n); V = new Float32Array(n); T = new Float32Array(n); const list = [];
    for (let i = 0; i < n; i++) {
      const u = raw[3*i], v = raw[3*i+1], t = raw[3*i+2];
      U[i] = u === M ? NaN : u / g.scale; V[i] = v === M ? NaN : v / g.scale; T[i] = t === M ? NaN : t / g.scaleT;
      if (u !== M && v !== M) list.push(i);
    }
    cells = Uint32Array.from(list); ready = true;
  }
  /** その地点の [u, v, 水温]。陸やデータのない所は null */
  function sample(lonDeg, latDeg) {
    if (!ready) return null;
    const x = (((lonDeg - g.lo1) % 360) + 360) % 360 / g.dx, y = (g.la1 - latDeg) / g.dy;
    if (y < 0 || y > g.ny - 1) return null;
    const i0 = Math.floor(x) % g.nx, i1 = (i0 + 1) % g.nx, fx = x - Math.floor(x), j0 = Math.floor(y), j1 = Math.min(j0 + 1, g.ny - 1), fy = y - j0;
    const a = j0*g.nx+i0, b = j0*g.nx+i1, c = j1*g.nx+i0, d = j1*g.nx+i1;
    if (Number.isNaN(U[a] + U[b] + U[c] + U[d])) {                       /* 海岸ぎわ：一番近い升目の値 */
      const k = (fy < 0.5 ? j0 : j1) * g.nx + (fx < 0.5 ? i0 : i1); return Number.isNaN(U[k]) ? null : [U[k], V[k], T[k]];
    }
    const bl = A => (A[a]*(1-fx)+A[b]*fx)*(1-fy) + (A[c]*(1-fx)+A[d]*fx)*fy;
    const t = bl(T);
    return [bl(U), bl(V), Number.isNaN(t) ? T[a] : t];
  }
  /* 海流の名札：だいたいこの辺を流れるという目安の位置（手で置いたもの）。1＝全体を見ているときから、2＝拡大したとき。
     文字の色は 暖流＝橙・寒流＝水色（線の水温の色とそろえる） */
  const NAMES = [
    ["黒潮", 31.0, 136.5, 1, 1], ["メキシコ湾流", 35.5, -71, 1, 1], ["北大西洋海流", 51, -28, 1, 1],
    ["北赤道海流", 13, 172, 1, 1], ["南赤道海流", -6, -125, 1, 1], ["南極環流", -56, -100, 1, 0], ["南極環流", -50, 85, 1, 0],
    ["親潮", 41.5, 147, 2, 0], ["対馬海流", 37.5, 133.5, 2, 1], ["北太平洋海流", 42, -165, 2, 1], ["アラスカ海流", 56, -146, 2, 1],
    ["カリフォルニア海流", 32, -124, 2, 0], ["赤道反流", 7, -140, 2, 1], ["ペルー海流", -20, -78, 2, 0], ["ブラジル海流", -27, -43, 2, 1],
    ["ベンゲラ海流", -24, 11, 2, 0], ["アガラス海流", -34, 29, 2, 1], ["東オーストラリア海流", -31, 156, 2, 1], ["西オーストラリア海流", -27, 109, 2, 0],
    ["カナリア海流", 25, -20, 2, 0], ["ラブラドル海流", 52, -51, 2, 0],
  ];
  let labels = null; const cam = new THREE.Vector3(), wp = new THREE.Vector3();
  function buildLabels() {
    labels = new THREE.Group(); labels.visible = false; scene.add(labels);
    const p = [0, 0, 0];
    for (const [ja, la, lo, rank, warm] of NAMES) {
      const sp = makeTextSprite(ja, warm ? "rgba(255,176,110,0.95)" : "rgba(125,200,255,0.95)", 500, 11.5);
      toXYZ(la, lo, 1.012, p, 0); sp.position.set(p[0], p[1], p[2]); sp.userData.rank = rank; labels.add(sp);
    }
  }
  function tickLabels() {
    if (!labels || !labels.visible) return;
    const dist = camera.position.length(), h = stage.clientHeight || 800, maxRank = dist > 3.4 ? 1 : 2;
    cam.copy(camera.position).normalize();
    for (const sp of labels.children) {
      wp.copy(sp.position).normalize();
      const show = sp.userData.rank <= maxRank && wp.dot(cam) > 0.25;            /* 裏側の名札は出さない */
      sp.visible = show; if (show) { const k = sp.userData.px / h * 2 * Math.tan(camera.fov / 2 * D2R); sp.scale.set(k * sp.userData.aspect, k, 1); }
    }
  }
  function spawn(i) {
    for (let k = 0; k < 20; k++) {
      const c = cells[(Math.random() * cells.length) | 0], j = Math.floor(c / g.nx), la = g.la1 - (j + Math.random() - 0.5) * g.dy;
      if (Math.random() > Math.cos(la * D2R)) continue;                 /* 面積に合わせる（高緯度に偏らないよう） */
      lat[i] = la; lon[i] = g.lo1 + ((c % g.nx) + Math.random() - 0.5) * g.dx; break;
    }
    age[i] = 0; life[i] = 220 + Math.random() * 280;
  }
  /* 帯（四角）で描く：区間ごとに4頂点。始点・終点・左右・時刻・水温・速さ */
  function build() {
    const S = N * SLOTS, VN = S * 4;
    attr = {
      a: new THREE.BufferAttribute(new Float32Array(VN * 3), 3).setUsage(THREE.DynamicDrawUsage),
      b: new THREE.BufferAttribute(new Float32Array(VN * 3), 3).setUsage(THREE.DynamicDrawUsage),
      birth: new THREE.BufferAttribute(new Float32Array(VN).fill(-1e6), 1).setUsage(THREE.DynamicDrawUsage),
      temp: new THREE.BufferAttribute(new Float32Array(VN), 1).setUsage(THREE.DynamicDrawUsage),
      spd: new THREE.BufferAttribute(new Float32Array(VN), 1).setUsage(THREE.DynamicDrawUsage),
    };
    const side = new Float32Array(VN), end = new Float32Array(VN), idx = new Uint32Array(S * 6);
    for (let q = 0; q < S; q++) {
      const v = q * 4; side[v] = -1; side[v+1] = 1; side[v+2] = -1; side[v+3] = 1; end[v] = 0; end[v+1] = 0; end[v+2] = 1; end[v+3] = 1;
      idx.set([v, v+1, v+2, v+2, v+1, v+3], q * 6);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", attr.a); geo.setAttribute("aB", attr.b); geo.setAttribute("aBirth", attr.birth); geo.setAttribute("aTemp", attr.temp); geo.setAttribute("aSpd", attr.spd);
    geo.setAttribute("aSide", new THREE.BufferAttribute(side, 1)); geo.setAttribute("aEnd", new THREE.BufferAttribute(end, 1));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    const res = new THREE.Vector2(); renderer.getDrawingBufferSize(res);
    mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uTrail: { value: SLOTS }, uRes: { value: res }, uWidth: { value: Math.max(2.0, 1.1 * renderer.getPixelRatio()) } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,   /* 帯の向き（表裏）は流れの向きで変わるので両面 */
      vertexShader: `
        attribute vec3 aB; attribute float aSide; attribute float aEnd; attribute float aBirth; attribute float aTemp; attribute float aSpd;
        uniform float uTime; uniform float uTrail; uniform vec2 uRes; uniform float uWidth;
        varying float vA; varying float vT; varying float vS; varying float vEdge;
        void main(){
          vA = (uTime - aBirth) / uTrail; vT = aTemp; vS = aSpd; vEdge = aSide;
          vec4 pa = projectionMatrix * modelViewMatrix * vec4(position, 1.0), pb = projectionMatrix * modelViewMatrix * vec4(aB, 1.0);
          vec2 d = (pb.xy / pb.w - pa.xy / pa.w) * uRes; float L = length(d); d = L > 1e-4 ? d / L : vec2(1.0, 0.0);
          vec4 p = mix(pa, pb, aEnd);
          p.xy += vec2(-d.y, d.x) * aSide * uWidth / uRes * p.w;          /* 画面の上で、左右に太さを付ける */
          gl_Position = p;
        }`,
      fragmentShader: `
        varying float vA; varying float vT; varying float vS; varying float vEdge;
        vec3 ramp(float t){                                                /* 水温：冷たい青 → 温かい赤 */
          if (t < 6.0)  return mix(vec3(0.22,0.42,1.00), vec3(0.25,0.75,1.00), clamp((t + 2.0) / 8.0, 0.0, 1.0));
          if (t < 14.0) return mix(vec3(0.25,0.75,1.00), vec3(0.60,0.95,0.85), (t - 6.0) / 8.0);
          if (t < 20.0) return mix(vec3(0.60,0.95,0.85), vec3(1.00,0.90,0.45), (t - 14.0) / 6.0);
          if (t < 25.0) return mix(vec3(1.00,0.90,0.45), vec3(1.00,0.58,0.25), (t - 20.0) / 5.0);
          return mix(vec3(1.00,0.58,0.25), vec3(1.00,0.30,0.25), clamp((t - 25.0) / 4.0, 0.0, 1.0));
        }
        void main(){
          if (vA < 0.0 || vA > 1.0) discard;
          float fade = pow(1.0 - vA, 1.4), soft = 1.0 - 0.45 * abs(vEdge) * abs(vEdge);
          float strength = mix(0.4, 1.0, smoothstep(0.03, 0.5, vS));
          gl_FragColor = vec4(ramp(vT) * fade * strength * soft * 0.95, 1.0);
        }`,
    });
    lines = new THREE.Mesh(geo, mat); lines.frustumCulled = false; lines.renderOrder = 2; lines.visible = false; scene.add(lines);
    for (let i = 0; i < N; i++) { spawn(i); age[i] = Math.random() * life[i]; pLat[i] = lat[i]; pLon[i] = lon[i]; }
    buildLabels(); built = true;
  }
  /* 尻尾を長くつなげる：粒は毎コマ動かし、跡（区間）は KEEP コマに1回だけ書く（3：重なって色が飽和しない長さの上限の目安）。区間の数（重さ）は同じまま、尻尾の長さが KEEP 倍に */
  const KEEP = 3, pLat = new Float32Array(N), pLon = new Float32Array(N), dead = new Uint8Array(N);
  let sub = 0;
  const tA = [0,0,0], tB = [0,0,0];
  function step(dtScale) {
    for (let i = 0; i < N; i++) {
      if (dead[i]) continue;
      const s0 = sample(lon[i], lat[i]);
      if (!s0) { dead[i] = 1; continue; }
      const c = Math.max(0.15, Math.cos(lat[i] * D2R));
      lat[i] += s0[1] * STEP * dtScale; lon[i] += s0[0] * STEP * dtScale / c;
      if (lon[i] > 180) lon[i] -= 360; else if (lon[i] < -180) lon[i] += 360;
      age[i] += dtScale;
      if (age[i] > life[i] || Math.abs(lat[i]) > 84 || Math.hypot(s0[0], s0[1]) < 0.01) dead[i] = 1;
    }
    if (++sub < KEEP) return;
    sub = 0; frame++;
    const slot = frame % SLOTS, q0 = slot * N, A = attr.a.array, B = attr.b.array, Bi = attr.birth.array, Te = attr.temp.array, Sp = attr.spd.array;
    for (let i = 0; i < N; i++) {
      const v4 = (q0 + i) * 4, s1 = dead[i] ? null : sample(lon[i], lat[i]);
      if (!s1) { spawn(i); dead[i] = 0; pLat[i] = lat[i]; pLon[i] = lon[i]; for (let k = 0; k < 4; k++) Bi[v4 + k] = -1e6; continue; }
      toXYZ(pLat[i], pLon[i], R, tA, 0); toXYZ(lat[i], lon[i], R, tB, 0);
      const sp = Math.hypot(s1[0], s1[1]);
      for (let k = 0; k < 4; k++) { const p = (v4 + k) * 3; A[p] = tA[0]; A[p+1] = tA[1]; A[p+2] = tA[2]; B[p] = tB[0]; B[p+1] = tB[1]; B[p+2] = tB[2]; Bi[v4 + k] = frame; Te[v4 + k] = s1[2]; Sp[v4 + k] = sp; }
      pLat[i] = lat[i]; pLon[i] = lon[i];
    }
    const off = q0 * 4, cnt = N * 4;
    for (const [k, at] of Object.entries(attr)) { const w = k === "a" || k === "b" ? 3 : 1; at.updateRange.offset = off * w; at.updateRange.count = cnt * w; at.needsUpdate = true; }
    mat.uniforms.uTime.value = frame;
  }
  return {
    meta, sample: (lo, la) => sample(lo, la),
    get visible() { return on; },
    set onChange(f) { onChange = f; },
    async setOn(v) {
      v = !!v; if (v === on) return;
      if (v) { try { await load(); } catch (e) { console.warn("海流を読めませんでした", e); return; } if (!built) build(); }
      on = v; if (lines) lines.visible = v; if (labels) labels.visible = v; onChange?.(v);
    },
    tick(dt) { if (on && built) { step(Math.min(dt / 16.667, 3)); tickLabels(); } },
    resize() { if (mat) renderer.getDrawingBufferSize(mat.uniforms.uRes.value); },
  };
})();

/* ===== 過去の地震（深さ）：1990〜2025年の M5.0 以上を、地表の震央に深さの色で打つ =====
   世界中で見ると、ほとんどがプレートの境目に並ぶ。海溝から陸側へ「橙（浅い）→黄緑→青紫（深い）」と並ぶ所は、
   プレートがその向きへ沈み込んでいると考えられている所。断面と同じデータを使う（読み込みは一度だけ） */
const QuakeHistLayer = (() => {
  if (!Catalog.has("quake-history")) return null;
  let pts = null, on = false;
  async function build() {
    await Catalog.load("quake-history");
    const raw = Catalog.grid("quake-history").raw, n = raw.length / 4;
    const pos = new Float32Array(n * 3), dep = new Float32Array(n), mag = new Float32Array(n);
    for (let i = 0; i < n; i++) { toXYZ(raw[4*i] / 100, raw[4*i+1] / 100, 1.0016, pos, i * 3); dep[i] = raw[4*i+2]; mag[i] = raw[4*i+3] / 10; }
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(pos, 3)); g.setAttribute("aDep", new THREE.BufferAttribute(dep, 1)); g.setAttribute("aMag", new THREE.BufferAttribute(mag, 1));
    pts = new THREE.Points(g, new THREE.ShaderMaterial({
      uniforms: { uPR: { value: renderer.getPixelRatio() }, uZoom: { value: 1 } }, transparent: true, depthWrite: false,
      vertexShader: `attribute float aDep; attribute float aMag; uniform float uPR; uniform float uZoom; varying float vD;
        void main(){ vD = aDep; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_PointSize = (1.3 + 1.1 * max(aMag - 5.0, 0.0)) * uPR * uZoom; }`,
      fragmentShader: `varying float vD;
        void main(){ vec2 p = gl_PointCoord - 0.5; float r = length(p); if (r > 0.5) discard;
          vec3 c = vD < 70.0 ? vec3(1.0,0.62,0.25) : vD < 300.0 ? mix(vec3(0.95,0.92,0.35), vec3(0.45,0.95,0.55), (vD - 70.0) / 230.0) : mix(vec3(0.40,0.75,1.0), vec3(0.70,0.50,1.0), clamp((vD - 300.0) / 400.0, 0.0, 1.0));
          gl_FragColor = vec4(c, (1.0 - smoothstep(0.32, 0.5, r)) * (vD < 70.0 ? 0.55 : 0.9)); }`,
    }));
    pts.frustumCulled = false; pts.renderOrder = 3.05; pts.visible = on; scene.add(pts);
  }
  return {
    get visible() { return on; },
    get meta() { return Catalog.meta("quake-history"); },
    async setOn(v) { on = !!v; if (on && !pts) { try { await build(); } catch (e) { console.warn("過去の地震を読めませんでした", e); on = false; } } if (pts) pts.visible = on; },
    tick() { if (pts && on) pts.material.uniforms.uZoom.value = Math.min(1.8, Math.max(0.8, 3.2 / camera.position.length() + 0.5)); },   /* 近づくと少し大きく */
  };
})();

/* ===== 気温の境目（前線のできやすい所）：約1.5km（850 hPa）の気温と、その変わり方の急さ（GFS から計算） =====
   色＝その高さの気温（青 寒い → 橙 暖かい、うすく）。光る帯＝気温が急に変わる所（寒い空気と暖かい空気の境目）。
   天気図の前線そのものではない（前線は予報官が判断して引くもの）。高い山や氷床の上は、この高さが地面の下なので出さない */
const FrontLayer = (() => {
  if (!Catalog.has("front-850")) return null;
  const g = Catalog.gridInfo("front-850");
  let mesh = null, on = false, raw = null;
  const TS = [[-30, [0.22, 0.40, 1.00]], [-10, [0.35, 0.65, 1.00]], [0, [0.60, 0.85, 1.00]], [10, [0.90, 0.92, 0.82]], [20, [1.00, 0.68, 0.32]], [30, [1.00, 0.36, 0.26]]];
  const tcol = t => { if (t <= TS[0][0]) return TS[0][1]; for (let k = 1; k < TS.length; k++) if (t <= TS[k][0]) { const [a0, c0] = TS[k-1], [a1, c1] = TS[k], f = (t - a0) / (a1 - a0); return c0.map((c, i) => c + (c1[i] - c) * f); } return TS[TS.length - 1][1]; };
  async function build() {
    await Catalog.load("front-850"); raw = Catalog.bytes("front-850");
    const W = g.nx, H = g.ny, px = new Uint8Array(W * H * 4);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const k = (j * W + i) * 2, o = ((H - 1 - j) * W + i) * 4, tq = raw[k], gq = raw[k + 1];
      if (tq === g.none || gq === g.none) { px[o + 3] = 0; continue; }
      const c = tcol(tq - 80), gr = gq / 20, f = Math.min(1, Math.max(0, (gr - 2) / 3)), ff = f * f * (3 - 2 * f);   /* 2〜5 ℃/100km で光り始める */
      px[o] = (c[0] * (1 - ff) + 1.00 * ff) * 255; px[o + 1] = (c[1] * (1 - ff) + 0.95 * ff) * 255; px[o + 2] = (c[2] * (1 - ff) + 0.70 * ff) * 255; px[o + 3] = (0.20 + 0.65 * ff) * 255;
    }
    const tex = new THREE.DataTexture(px, W, H, THREE.RGBAFormat); tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter; tex.needsUpdate = true;
    const u0 = (g.lon0 + 180) / 360;                                    /* 格子の経度の始まりに合わせる */
    mesh = new THREE.Mesh(new THREE.SphereGeometry(1.0011, 192, 96), new THREE.ShaderMaterial({
      uniforms: { uTex: { value: tex }, uU0: { value: u0 } }, transparent: true, depthWrite: false,
      vertexShader: `varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform sampler2D uTex; uniform float uU0; varying vec3 vPos; const float PI = 3.141592653589793;
        void main(){ vec3 n = normalize(vPos); float lat = asin(clamp(n.y, -1.0, 1.0)), lon = atan(-n.z, n.x);
          vec4 c = texture2D(uTex, vec2(fract((lon + PI) / (2.0 * PI) - uU0 + 0.5 / ${g.nx.toFixed(1)}), (lat + PI * 0.5) / PI)); if (c.a < 0.02) discard;
          gl_FragColor = vec4(c.rgb, c.a); }`,
    }));
    mesh.renderOrder = 1.3; mesh.visible = on; scene.add(mesh);
  }
  return {
    get visible() { return on; }, get meta() { return Catalog.meta("front-850"); },
    async setOn(v) { on = !!v; if (on && !mesh) { try { await build(); } catch (e) { console.warn("気温の境目を読めませんでした", e); on = false; } } if (mesh) mesh.visible = on; },
    /** その地点の [気温 ℃, 変わり方 ℃/100km]。なしは null */
    at(lonDeg, latDeg) { if (!raw) return null; const j = Math.min(g.ny - 1, Math.max(0, Math.round((g.lat0 - latDeg) / g.dy))), i = ((Math.round((lonDeg - g.lon0) / g.dx) % g.nx) + g.nx) % g.nx, k = (j * g.nx + i) * 2;
      return raw[k] === g.none ? null : [raw[k] - 80, raw[k + 1] / 20]; },
  };
})();

/* ===== 海底の年齢：海の底の岩ができてから何百万年か（EarthByte、Seton et al. 2020） =====
   海嶺（生まれる所）が若く＝赤、離れるほど古く＝青。いちばん古い海底は日本の東の沖（約1億8千万年前後）、そこから海溝で沈む */
const SeaAgeLayer = (() => {
  if (!Catalog.has("seafloor-age")) return null;
  let mesh = null, on = false, ages = null;
  const g = Catalog.gridInfo("seafloor-age");
  const STOPS = [[0, [1.00, 0.22, 0.18]], [15, [1.00, 0.55, 0.18]], [40, [0.96, 0.88, 0.30]], [70, [0.45, 0.86, 0.45]], [110, [0.28, 0.72, 0.95]], [180, [0.42, 0.38, 0.92]]];
  const ramp = a => { for (let k = 1; k < STOPS.length; k++) if (a <= STOPS[k][0]) { const [a0, c0] = STOPS[k-1], [a1, c1] = STOPS[k], t = (a - a0) / (a1 - a0); return c0.map((c, i) => c + (c1[i] - c) * t); } return STOPS[STOPS.length - 1][1]; };
  async function build() {
    await Catalog.load("seafloor-age");
    ages = Catalog.bytes("seafloor-age");
    const W = g.nx, H = g.ny, px = new Uint8Array(W * H * 4);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const a = ages[j * W + i], o = ((H - 1 - j) * W + i) * 4;          /* 画像の1行目＝南（地球の殻と同じ向き） */
      if (a === g.none) { px[o + 3] = 0; continue; }
      const c = ramp(a); px[o] = c[0] * 255; px[o + 1] = c[1] * 255; px[o + 2] = c[2] * 255; px[o + 3] = 255;
    }
    const tex = new THREE.DataTexture(px, W, H, THREE.RGBAFormat); tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter; tex.needsUpdate = true;
    mesh = new THREE.Mesh(new THREE.SphereGeometry(1.0009, 192, 96), new THREE.ShaderMaterial({
      uniforms: { uTex: { value: tex } }, transparent: true, depthWrite: false,
      vertexShader: `varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform sampler2D uTex; varying vec3 vPos; const float PI = 3.141592653589793;
        void main(){ vec3 n = normalize(vPos); float lat = asin(clamp(n.y, -1.0, 1.0)), lon = atan(-n.z, n.x);
          vec4 c = texture2D(uTex, vec2((lon + PI) / (2.0 * PI), (lat + PI * 0.5) / PI)); if (c.a < 0.35) discard;
          gl_FragColor = vec4(c.rgb * 0.85, 0.62 * c.a); }`,
    }));
    mesh.renderOrder = 1.2; mesh.visible = on; scene.add(mesh);
  }
  return {
    get visible() { return on; }, get meta() { return Catalog.meta("seafloor-age"); },
    /** 年齢の数字だけ読む（色の殻は作らない）。プレートの動きの色分けに使う */
    async ensureAges() { if (!ages) { await Catalog.load("seafloor-age"); ages = Catalog.bytes("seafloor-age"); } return true; },
    async setOn(v) { on = !!v; if (on && !mesh) { try { await build(); } catch (e) { console.warn("海底の年齢を読めませんでした", e); on = false; } } if (mesh) mesh.visible = on; },
    /** その地点の年齢（百万年）。陸やデータなしは null */
    at(lonDeg, latDeg) { if (!ages) return null; const j = Math.min(g.ny - 1, Math.max(0, Math.floor(g.lat0 + 0.5 - latDeg))), i = ((Math.floor(lonDeg - g.lon0 + 0.5) % g.nx) + g.nx) % g.nx, a = ages[j * g.nx + i]; return a === g.none ? null : a; },
  };
})();

/* ===== プレートの動き（研究モデル）：PB2002 の回転（オイラー極）を「地球全体として回らない」基準にしたもの =====
   点がプレートごとにまとまって動く。境目でほかのプレートに入ったら消える（沈む・押し合う所）。
   新しい点の半分は「広がる」境目（海嶺）のすぐ脇から出す（生まれる所の演出）。速さは早送り：1秒でおよそ80万年ぶん */
const PlateMoveLayer = (() => {
  let on = false, ready = false, pts = null, plates = null, grid = null, G = null, ridges = [];
  const N = window.innerWidth < 700 ? 2600 : 4200, MYR_PER_SEC = 0.8, R = 1.0026;
  const X = new Float32Array(N * 3), pid = new Uint8Array(N), age = new Float32Array(N), life = new Float32Array(N);
  const v3 = new THREE.Vector3(), w3 = new THREE.Vector3(), t3 = new THREE.Vector3();
  const plateAt = (x, y, z) => { const la = Math.asin(Math.max(-1, Math.min(1, y))) / D2R, lo = Math.atan2(-z, x) / D2R;
    const j = Math.min(G.ny - 1, Math.max(0, Math.floor(G.lat0 + 0.5 - la))), i = ((Math.floor(lo - G.lon0 + 0.5) % G.nx) + G.nx) % G.nx; return grid[j * G.nx + i]; };
  const tmp = [0, 0, 0];
  function spawn(k) {
    for (let tries = 0; tries < 10; tries++) {
      let la, lo;
      if (ridges.length && Math.random() < 0.5) {                        /* 海嶺のすぐ脇（生まれる所） */
        const r = ridges[(Math.random() * ridges.length) | 0], t = Math.random();
        la = r[1] + (r[3] - r[1]) * t + (Math.random() - 0.5) * 0.8; lo = r[0] + (r[2] - r[0]) * t + (Math.random() - 0.5) * 0.8;
      } else { la = Math.asin(Math.random() * 2 - 1) / D2R; lo = Math.random() * 360 - 180; }
      toXYZ(la, lo, 1, tmp, 0); const p = plateAt(tmp[0], tmp[1], tmp[2]);
      if (p === G.none || !plates[p].w) continue;
      X[k*3] = tmp[0]; X[k*3+1] = tmp[1]; X[k*3+2] = tmp[2]; pid[k] = p; age[k] = 0; life[k] = 420 + Math.random() * 420; return;
    }
    life[k] = 0;
  }
  async function build() {
    const [meta, bin, pl] = await Promise.all([getJSON("data/map/platemotion.json"), getBin("data/map/platemotion.bin"), getJSON("data/map/plates.json")]);
    plates = meta.plates; G = meta.grid; grid = new Uint8Array(bin);
    if (SeaAgeLayer) { try { seaOK = await SeaAgeLayer.ensureAges(); } catch (e) { console.warn("海底の年齢なしで動かします", e); } }   /* 色分け用。なければ白一色 */
    ridges = pl.steps.filter(s => s[4] === 0).map(s => [s[0], s[1], s[2], s[3]]);   /* 「広がる」境目 */
    for (let k = 0; k < N; k++) { spawn(k); age[k] = Math.random() * life[k]; PX[k*3] = X[k*3]; PX[k*3+1] = X[k*3+1]; PX[k*3+2] = X[k*3+2]; }
    /* 線（尻尾）：粒の通った跡を短い帯で残す。帯は画面の上で太さを付けた四角（海流と同じ作り）。区間は KEEP コマに1回だけ書き、SLOTS 区間ぶん残して古い順に薄くする */
    const S = N * SLOTS, VN = S * 4;
    attr = { a: new THREE.BufferAttribute(new Float32Array(VN * 3), 3).setUsage(THREE.DynamicDrawUsage),
             b: new THREE.BufferAttribute(new Float32Array(VN * 3), 3).setUsage(THREE.DynamicDrawUsage),
             birth: new THREE.BufferAttribute(new Float32Array(VN).fill(-1e6), 1).setUsage(THREE.DynamicDrawUsage),
             sea: new THREE.BufferAttribute(new Float32Array(VN).fill(-1), 1).setUsage(THREE.DynamicDrawUsage) };
    const side = new Float32Array(VN), end = new Float32Array(VN), idx = new Uint32Array(S * 6);
    for (let q = 0; q < S; q++) {
      const v = q * 4; side[v] = -1; side[v+1] = 1; side[v+2] = -1; side[v+3] = 1; end[v+2] = 1; end[v+3] = 1;
      idx.set([v, v+1, v+2, v+2, v+1, v+3], q * 6);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", attr.a); geo.setAttribute("aB", attr.b); geo.setAttribute("aBirth", attr.birth); geo.setAttribute("aSea", attr.sea);
    geo.setAttribute("aSide", new THREE.BufferAttribute(side, 1)); geo.setAttribute("aEnd", new THREE.BufferAttribute(end, 1));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    const res = new THREE.Vector2(); renderer.getDrawingBufferSize(res);
    mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uTrail: { value: SLOTS }, uRes: { value: res }, uWidth: { value: Math.max(2.2, 1.4 * renderer.getPixelRatio()) } },
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      vertexShader: `
        attribute vec3 aB; attribute float aSide; attribute float aEnd; attribute float aBirth; attribute float aSea;
        uniform float uTime; uniform float uTrail; uniform vec2 uRes; uniform float uWidth;
        varying float vA; varying float vEdge; varying float vSea;
        void main(){
          vA = (uTime - aBirth) / uTrail; vEdge = aSide; vSea = aSea;
          vec4 pa = projectionMatrix * modelViewMatrix * vec4(position, 1.0), pb = projectionMatrix * modelViewMatrix * vec4(aB, 1.0);
          vec2 d = (pb.xy / pb.w - pa.xy / pa.w) * uRes; float L = length(d); d = L > 1e-4 ? d / L : vec2(1.0, 0.0);
          vec4 p = mix(pa, pb, aEnd);
          p.xy += vec2(-d.y, d.x) * aSide * uWidth / uRes * p.w;
          gl_Position = p;
        }`,
      fragmentShader: `
        varying float vA; varying float vEdge; varying float vSea;
        vec3 heat(float a){                                                /* 海底の年齢 → 温かさの目安：生まれたて＝赤く熱い → 冷えて青 */
          if (a < 0.0)   return vec3(0.86, 0.84, 0.92);                    /* 陸（海底の年齢なし）＝灰色がかった白 */
          if (a < 8.0)   return mix(vec3(1.00, 0.25, 0.12), vec3(1.00, 0.55, 0.15), a / 8.0);
          if (a < 30.0)  return mix(vec3(1.00, 0.55, 0.15), vec3(1.00, 0.88, 0.55), (a - 8.0) / 22.0);
          if (a < 70.0)  return mix(vec3(1.00, 0.88, 0.55), vec3(0.80, 0.90, 1.00), (a - 30.0) / 40.0);
          if (a < 120.0) return mix(vec3(0.80, 0.90, 1.00), vec3(0.35, 0.60, 1.00), (a - 70.0) / 50.0);
          return mix(vec3(0.35, 0.60, 1.00), vec3(0.30, 0.38, 0.95), clamp((a - 120.0) / 60.0, 0.0, 1.0));
        }
        void main(){
          if (vA < 0.0 || vA > 1.0) discard;
          float fade = pow(1.0 - vA, 1.2), soft = 1.0 - 0.5 * vEdge * vEdge;
          float rim = smoothstep(0.45, 0.95, abs(vEdge));                  /* 縁を暗くして、どんな地図の上でも線が浮くように */
          gl_FragColor = vec4(mix(heat(vSea), vec3(0.03, 0.03, 0.08), rim * 0.85), fade * mix(0.95, 0.75, rim));
        }`,
    });
    pts = new THREE.Mesh(geo, mat); pts.frustumCulled = false; pts.renderOrder = 3.3; pts.visible = on; scene.add(pts); ready = true;
  }
  const SLOTS = 40, KEEP = 8, PX = new Float32Array(N * 3), fresh = new Uint8Array(N);
  let attr = null, mat = null, frame = 0, sub = 0, seaOK = false;
  function step(dtScale) {
    const dMyr = MYR_PER_SEC / 60 * dtScale;
    for (let k = 0; k < N; k++) {
      if (life[k] <= 0 || age[k] > life[k]) { spawn(k); fresh[k] = 1; }
      const w = plates[pid[k]].w; if (!w) { life[k] = 0; continue; }
      v3.set(X[k*3], X[k*3+1], X[k*3+2]); w3.set(w[0], w[1], w[2]);
      t3.crossVectors(w3, v3).multiplyScalar(dMyr); v3.add(t3).normalize();   /* v = ω × r（rad/100万年） */
      X[k*3] = v3.x; X[k*3+1] = v3.y; X[k*3+2] = v3.z; age[k] += dtScale;
      if (plateAt(v3.x, v3.y, v3.z) !== pid[k]) life[k] = 0;              /* ほかのプレートに入った＝沈む・押し合う所で消える（尻尾は残って薄れる） */
    }
    if (++sub < KEEP) return;
    sub = 0; frame++; mat.uniforms.uTime.value = frame;
    const q0 = (frame % SLOTS) * N, A = attr.a.array, B = attr.b.array, Bi = attr.birth.array, Se = attr.sea.array;
    for (let k = 0; k < N; k++) {
      const v4 = (q0 + k) * 4;
      if (fresh[k] || life[k] <= 0) { for (let m = 0; m < 4; m++) Bi[v4 + m] = -1e6; fresh[k] = 0; PX[k*3] = X[k*3]; PX[k*3+1] = X[k*3+1]; PX[k*3+2] = X[k*3+2]; continue; }
      let sa = -1;
      if (seaOK) { const la = Math.asin(Math.max(-1, Math.min(1, X[k*3+1]))) / D2R, lo = Math.atan2(-X[k*3+2], X[k*3]) / D2R, a = SeaAgeLayer.at(lo, la); if (a != null) sa = a; }
      for (let m = 0; m < 4; m++) { const p = (v4 + m) * 3; Se[v4 + m] = sa;
        A[p] = PX[k*3] * R; A[p+1] = PX[k*3+1] * R; A[p+2] = PX[k*3+2] * R; B[p] = X[k*3] * R; B[p+1] = X[k*3+1] * R; B[p+2] = X[k*3+2] * R; Bi[v4 + m] = frame; }
      PX[k*3] = X[k*3]; PX[k*3+1] = X[k*3+1]; PX[k*3+2] = X[k*3+2];
    }
    attr.a.needsUpdate = true; attr.b.needsUpdate = true; attr.birth.needsUpdate = true; attr.sea.needsUpdate = true;
  }
  return {
    get visible() { return on; },
    async setOn(v) { on = !!v; if (on && !ready) { try { await build(); } catch (e) { console.warn("プレートの動きを読めませんでした", e); on = false; } } if (pts) pts.visible = on; },
    tick(dt) { if (on && ready) step(Math.min(dt / 16.667, 3)); },
    /** その地点の動き：[速さ mm/年, 向き（北から時計回りの度）, プレート記号] */
    at(lonDeg, latDeg) { if (!ready) return null; toXYZ(latDeg, lonDeg, 1, tmp, 0); const p = plateAt(tmp[0], tmp[1], tmp[2]); if (p === G.none || !plates[p].w) return null;
      const w = plates[p].w; v3.set(tmp[0], tmp[1], tmp[2]); t3.set(w[0], w[1], w[2]).cross(v3).multiplyScalar(6371);   /* mm/年 */
      const lo = lonDeg * D2R, la = latDeg * D2R, e = new THREE.Vector3(-Math.sin(lo), 0, -Math.cos(lo)), n = new THREE.Vector3(-Math.sin(la) * Math.cos(lo), Math.cos(la), Math.sin(la) * Math.sin(lo));
      return [t3.length(), (Math.atan2(t3.dot(e), t3.dot(n)) / D2R + 360) % 360, plates[p].code]; },
  };
})();

/* ===== 地球の中（断面）：地球を4分の1切り取り、切り口に中のつくりを描く =====
   ・層の深さ：地震波から作られた標準モデル PREM（Dziewonski & Anderson 1981）。地殻〜24km・410km・660km・核とマントルの境 2,891km・内核の境 5,150km
   ・切り口の色：深さごとの温度の推定（文献の代表的な値。幅がある）。「こう考えられている」の位置づけ
   ・切り取った中に、過去の地震（M5以上）を本当の深さで置く。沈み込んだ海のプレートの形が浮かぶ
   ・切る場所：日本を東西に通る断面（北緯38°・東経142°を通る大円）と、東経70°の子午線。日本の下へ沈み込むプレートが見える向き */
renderer.localClippingEnabled = true;
const InteriorLayer = (() => {
  const P = new THREE.Vector3(), tmp = [0, 0, 0];
  toXYZ(38, 142, 1, tmp, 0); P.set(...tmp);
  const la = 38 * D2R, lo = 142 * D2R, lo2 = 70 * D2R;
  const n1 = new THREE.Vector3(-Math.sin(la) * Math.cos(lo), Math.cos(la), Math.sin(la) * Math.sin(lo)).normalize();   /* 断面1の法線＝その地点の北向き */
  const n2 = new THREE.Vector3(-Math.sin(lo2), 0, -Math.cos(lo2)).normalize();                                       /* 断面2の法線＝東経70°の東向き（切り口を広めに開ける） */
  const clip = [new THREE.Plane(n1.clone().negate(), 0), new THREE.Plane(n2.clone().negate(), 0)];
  /* 深さ（km）と温度（℃）の目安。地表 15 → 地殻の底 約500 → プレートの底(100km) 約1,300 → 410km 約1,500 → 660km 約1,600
     → 核の上(2,700km) 約2,500 → 核とマントルの境 約3,700 → 内核の境 約5,000 → 中心 約5,400（推定に数百℃の幅） */
  const R0 = 6371, GEO = [[0, 15], [24, 500], [100, 1300], [410, 1500], [660, 1600], [2700, 2500], [2891, 3700], [5150, 5000], [6371, 5400]];
  const faceMat = other => new THREE.ShaderMaterial({
    uniforms: { uOther: { value: other }, uSun: { value: sunDir } }, side: THREE.DoubleSide,
    vertexShader: `varying vec3 vW; void main(){ vW = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0); }`,
    fragmentShader: `uniform vec3 uOther; varying vec3 vW;
      float temp(float d){ ${GEO.slice(1).map(([d, t], i) => `if (d < ${d.toFixed(1)}) return mix(${GEO[i][1].toFixed(1)}, ${t.toFixed(1)}, (d - ${GEO[i][0].toFixed(1)}) / ${(d - GEO[i][0]).toFixed(1)});`).join(" ")} return 5400.0; }
      vec3 heat(float t){                                                /* 温度の色：暗い赤 → 赤 → 橙 → 黄 → 白っぽい黄 */
        if (t < 1300.0) return mix(vec3(0.16,0.06,0.05), vec3(0.50,0.11,0.06), t / 1300.0);
        if (t < 2500.0) return mix(vec3(0.50,0.11,0.06), vec3(0.74,0.25,0.08), (t - 1300.0) / 1200.0);
        if (t < 3699.0) return mix(vec3(0.74,0.25,0.08), vec3(0.88,0.42,0.12), (t - 2500.0) / 1200.0);
        return mix(vec3(1.00,0.70,0.28), vec3(1.00,0.95,0.78), clamp((t - 3700.0) / 1700.0, 0.0, 1.0));   /* 核は一段明るく（境目で温度が跳ぶ） */
      }
      void main(){
        if (dot(vW, uOther) < 0.0) discard;                              /* 切り口の半円だけ */
        float r = length(vW); if (r > 1.0) discard;
        float d = (1.0 - r) * ${R0.toFixed(1)};
        vec3 col = heat(temp(d));
        float line = 0.0;                                                /* 層の境目に細い線 */
        for (int i = 0; i < 5; i++) { float b = i == 0 ? 24.0 : i == 1 ? 410.0 : i == 2 ? 660.0 : i == 3 ? 2891.0 : 5150.0;
          line = max(line, 1.0 - smoothstep(0.0, 9.0 + float(i) * 3.0, abs(d - b))); }
        col = mix(col, d > 2800.0 ? vec3(0.55, 0.22, 0.06) : vec3(1.0, 0.95, 0.85), line * 0.6);   /* 核の中は暗い線で */
        col *= 0.92 + 0.08 * r;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const face = (normal, other) => {
    const m = new THREE.Mesh(new THREE.CircleGeometry(1, 160), faceMat(other));
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal); m.visible = false; m.renderOrder = 0.5; scene.add(m); return m;
  };
  const f1 = face(n1, n2), f2 = face(n2, n1);
  /* 名札：断面1の上に、層の名前と境目の深さ・温度の目安 */
  const labels = new THREE.Group(); labels.visible = false; scene.add(labels);
  const along = (deg, r) => { const q = new THREE.Quaternion().setFromAxisAngle(n1, deg * D2R);   /* 正の角度＝東へ（切り口の上） */ return P.clone().applyQuaternion(q).multiplyScalar(r); };
  const addLabel = (text, color, v, px = 11.5) => { const sp = makeTextSprite(text, color, 500, px); sp.position.copy(v); labels.add(sp); };
  addLabel("上部マントル", "rgba(255,226,200,0.95)", along(20, 0.95));
  addLabel("下部マントル", "rgba(255,226,200,0.95)", along(20, 0.72));
  addLabel("外核（液体の鉄）", "rgba(255,250,240,0.98)", along(20, 0.40));
  addLabel("内核（固体の鉄）約5,400℃", "rgba(255,250,240,0.98)", along(20, 0.06));
  addLabel("660km　約1,600℃", "rgba(230,230,240,0.85)", along(118, 1 - 660 / R0), 10.5);
  addLabel("2,900km　約3,700℃", "rgba(230,230,240,0.85)", along(118, 1 - 2891 / R0), 10.5);
  addLabel("5,150km　約5,000℃", "rgba(245,245,250,0.9)", along(118, 1 - 5150 / R0), 10.5);
  addLabel("日本（北緯38°）", "rgba(170,200,255,0.95)", P.clone().multiplyScalar(1.06), 11);
  /* 過去の地震（M5以上）を本当の深さで。色＝深さ（浅い 橙 → 中くらい 黄緑 → 深い 青紫）、大きさ＝マグニチュード */
  let quakes = null;
  async function loadQuakes() {
    if (quakes || !Catalog.has("quake-history")) return;
    await Catalog.load("quake-history");
    const raw = Catalog.grid("quake-history").raw, n = raw.length / 4;
    const pos = new Float32Array(n * 3), dep = new Float32Array(n), mag = new Float32Array(n);
    for (let i = 0; i < n; i++) { const d = raw[4*i+2]; toXYZ(raw[4*i] / 100, raw[4*i+1] / 100, 1 - d / R0, pos, i * 3); dep[i] = d; mag[i] = raw[4*i+3] / 10; }
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(pos, 3)); g.setAttribute("aDep", new THREE.BufferAttribute(dep, 1)); g.setAttribute("aMag", new THREE.BufferAttribute(mag, 1));
    quakes = new THREE.Points(g, new THREE.ShaderMaterial({
      uniforms: { uPR: { value: renderer.getPixelRatio() }, uN1: { value: n1 }, uN2: { value: n2 } }, transparent: true, depthWrite: false,
      vertexShader: `attribute float aDep; attribute float aMag; uniform float uPR; uniform vec3 uN1; uniform vec3 uN2; varying float vD; varying float vIn;
        void main(){ vD = aDep; vIn = (dot(position, uN1) > 0.0 && dot(position, uN2) > 0.0) ? 1.0 : 0.0;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_PointSize = (1.6 + 1.5 * max(aMag - 5.0, 0.0)) * uPR * vIn * (aDep < 70.0 ? 0.7 : 1.0); }`,
      fragmentShader: `varying float vD; varying float vIn;
        void main(){ if (vIn < 0.5) discard; vec2 p = gl_PointCoord - 0.5; float r = length(p); if (r > 0.5) discard;
          vec3 c = vD < 70.0 ? vec3(1.0,0.62,0.25) : vD < 300.0 ? mix(vec3(0.95,0.92,0.35), vec3(0.45,0.95,0.55), (vD - 70.0) / 230.0) : mix(vec3(0.40,0.75,1.0), vec3(0.70,0.50,1.0), clamp((vD - 300.0) / 400.0, 0.0, 1.0));
          gl_FragColor = vec4(c, (1.0 - smoothstep(0.3, 0.5, r)) * (vD < 70.0 ? 0.35 : 0.95)); }`,   /* 浅い地震は控えめに（深い列を見やすく） */
    }));
    quakes.frustumCulled = false; quakes.renderOrder = 3; quakes.visible = on; scene.add(quakes);
  }
  let on = false, onChange = null, camWas = null;
  const cam = new THREE.Vector3(), CAM = [0.12, 0.42, 4.8];   /* 目線の向き（断面1・断面2・日本の混ぜ具合）と距離 */
  return {
    get visible() { return on; }, set onChange(f) { onChange = f; },
    get info() { return Catalog.has("quake-history") ? Catalog.meta("quake-history") : null; },
    async setOn(v) {
      v = !!v; if (v === on) return; on = v;
      globe.material.uniforms.uCut.value = on ? 1 : 0; globe.material.uniforms.uN1.value.copy(n1); globe.material.uniforms.uN2.value.copy(n2);
      f1.visible = f2.visible = labels.visible = on;
      const coast = window.__coast; if (coast) { coast.material.clippingPlanes = on ? clip : null; coast.material.clipIntersection = true; coast.material.needsUpdate = true; }
      /* プレートの境目：切り取った所の上は消す（線と名札は切り抜き、光の帯は断面の間だけお休み） */
      if (PlateLayer?.group) PlateLayer.group.traverse(o => { if (!o.material) return;
        if (o.material.isShaderMaterial) { o.visible = !on; return; }
        o.material.clippingPlanes = on ? clip : null; o.material.clipIntersection = true; o.material.needsUpdate = true; });
      if (on) {                                                          /* 切り口の正面へ回り込む（やめると元の場所へ） */
        camWas = camera.position.clone();
        camera.position.copy(n1.clone().add(n2.clone().multiplyScalar(CAM[0])).add(P.clone().multiplyScalar(CAM[1])).normalize().multiplyScalar(CAM[2]));   /* 断面を斜め前から、日本の下が画面に大きく入る距離で */
        camera.lookAt(0, 0, 0);
      } else if (camWas) { camera.position.copy(camWas); camera.lookAt(0, 0, 0); camWas = null; }
      onChange?.(on);
      if (on) { try { await loadQuakes(); } catch (e) { console.warn("過去の地震を読めませんでした", e); } }
      if (quakes) quakes.visible = on;
    },
    tick() {
      if (!on) return;
      const h = stage.clientHeight || 800; cam.copy(camera.position);
      const front = cam.dot(n1) > 0.05;                                  /* 断面1が見える側にいるときだけ名札を出す */
      for (const sp of labels.children) { sp.visible = front; if (front) { const k = sp.userData.px / h * 2 * Math.tan(camera.fov / 2 * D2R); sp.scale.set(k * sp.userData.aspect, k, 1); } }
    },
  };
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
/* ===== 自転の演出：太陽と星は宇宙に止めたまま、地球だけが西から東へ回って見えるようにする =====
   中身は「カメラ・太陽の向き・星の枠」を地軸まわりに西へ回すこと（地球に貼りついたデータは動かさないので、データは嘘にならない）。
   実際の速さ（1時間に15°）ではない。回しているあいだの昼夜の位置は本当の時刻からずれるので、止めたら本当の太陽の位置に戻す。
   指で触ったら止まり、離して少したつとまた回る */
const realSun = () => { const s = subsolarPoint(Clock.now()), p = [0,0,0]; toXYZ(s.lat, s.lon, 1, p, 0); sunDir.set(p[0], p[1], p[2]); };
/* ===== 月（自転の演出のときだけ）：外からデータをもらわず、式で計算する =====
   位置は簡単な月の式（主な揺らぎの項だけ。誤差はおよそ1°以内）。向き・満ち欠け・地球に同じ面を向けることは本物どおり。
   距離だけ縮めて描く（本物は地球の半径の約60倍。ここでは約3.6倍。近い日・遠い日の差は比率のまま残す）。大きさの比（地球の約0.27倍）は本物 */
const MoonLayer = (() => {
  const R_DRAW = 3.6, KM_MEAN = 384400, SIZE = 0.2727;
  const mat = new THREE.ShaderMaterial({
    uniforms: { uSun: { value: sunDir } },
    vertexShader: `varying vec3 vN; varying vec3 vP; void main(){ vP = normal; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 uSun; varying vec3 vN; varying vec3 vP;
      float h(vec3 p){ return fract(sin(dot(p, vec3(127.1,311.7,74.7))) * 43758.5453); }
      float n3(vec3 p){ vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
        return mix(mix(mix(h(i),h(i+vec3(1,0,0)),f.x),mix(h(i+vec3(0,1,0)),h(i+vec3(1,1,0)),f.x),f.y),
                   mix(mix(h(i+vec3(0,0,1)),h(i+vec3(1,0,1)),f.x),mix(h(i+vec3(0,1,1)),h(i+vec3(1,1,1)),f.x),f.y),f.z); }
      void main(){
        float m = n3(vP*2.2)*0.6 + n3(vP*5.0)*0.3 + n3(vP*11.0)*0.1;           /* 海（暗い所）と高地の濃淡。模様は作り物 */
        float near = smoothstep(-0.2, 0.9, vP.z);                                 /* 地球を向く面（+Z）に海を多めに */
        vec3 base = mix(vec3(0.78,0.77,0.74), vec3(0.42,0.42,0.43), smoothstep(0.48, 0.62, m) * (0.45 + 0.55*near));
        float d = max(dot(normalize(vN), normalize(uSun)), 0.0);
        gl_FragColor = vec4(base * (0.035 + 1.05 * pow(d, 0.85)), 1.0);          /* 0.035 は地球照（地球の照り返し）のつもりのわずかな明るさ */
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(SIZE, 48, 32), mat);
  mesh.visible = false; scene.add(mesh);
  const tag = document.createElement("div"); tag.id = "moontag"; tag.hidden = true; document.body.appendChild(tag);
  const v = new THREE.Vector3(), fw = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0);
  const S = x => Math.sin(x * D2R);
  /** 月の位置（地心・黄道）と月齢。d は 2000年1月1日12時からの日数 */
  function moon(ms) {
    const d = ms / 86400000 + 2440587.5 - 2451545.0;
    const L = 218.316 + 13.176396 * d, M = 134.963 + 13.064993 * d, F = 93.272 + 13.229350 * d, D = 297.850 + 12.190749 * d, Ms = 357.529 + 0.98560028 * d;
    const lam = L + 6.289 * S(M) + 1.274 * S(2 * D - M) + 0.658 * S(2 * D) + 0.214 * S(2 * M) - 0.186 * S(Ms) - 0.114 * S(2 * F);
    const bet = 5.128 * S(F) + 0.281 * S(M + F) + 0.278 * S(M - F) + 0.173 * S(2 * D - F);
    const km = 385001 - 20905 * Math.cos(M * D2R) - 3699 * Math.cos((2 * D - M) * D2R) - 2956 * Math.cos(2 * D * D2R);
    const Ls = 280.460 + 0.9856474 * d, lamSun = Ls + 1.915 * S(Ms) + 0.020 * S(2 * Ms);
    const e = EARTH.axialTiltDeg * D2R, lr = lam * D2R, br = bet * D2R;
    const x = Math.cos(br) * Math.cos(lr), y = Math.cos(br) * Math.sin(lr), z = Math.sin(br);
    const ye = y * Math.cos(e) - z * Math.sin(e), ze = y * Math.sin(e) + z * Math.cos(e);
    const age = (((lam - lamSun) % 360 + 360) % 360) / 360 * 29.530589;
    return { ra: Math.atan2(ye, x) / D2R, dec: Math.asin(ze) / D2R, km, age };
  }
  let last = null;
  return {
    get info() { return last; },
    /** k：出し具合（0〜1）。spin：回した角度。演出の時間は、回した角度から「地球が何日ぶん回ったか」で進める */
    tick(k, spin) {
      const show = k > 0.5; mesh.visible = show; if (!show) { tag.hidden = true; return; }
      const t = Clock.now().getTime() + (-spin / (2 * Math.PI)) * 86164000;   /* 恒星日（約23時間56分）で1回転 */
      const m = moon(t); last = m;
      const p = [0, 0, 0]; toXYZ(m.dec, m.ra, R_DRAW * m.km / KM_MEAN, p, 0);
      mesh.position.set(p[0], p[1], p[2]).applyAxisAngle(Y, -gmstDeg(Clock.now()) * D2R + spin);
      mesh.lookAt(0, 0, 0);                                                     /* いつも同じ面を地球に向ける（本物どおり） */
      const cd = mesh.position.distanceTo(camera.position); mesh.visible = cd > 0.7;   /* カメラにぶつかるほど近いときは出さない */
      /* 画面の外にいるときは、端に「月」の矢印を出す */
      camera.getWorldDirection(fw);
      const front = fw.dot(v.copy(mesh.position).sub(camera.position)) > 0;
      v.copy(mesh.position).project(camera);
      let x = v.x, y = v.y, inside = front && Math.abs(x) < 0.92 && Math.abs(y) < 0.92;
      if (inside) { tag.hidden = true; return; }
      if (!front) { x = -x; y = -y; }
      const mx = Math.max(Math.abs(x), Math.abs(y), 1e-6), f = 0.86 / mx; x *= f; y *= f;
      const w = stage.clientWidth, hh = stage.clientHeight, ang = Math.atan2(-y, x) / D2R;
      tag.style.left = `${(x + 1) / 2 * w}px`; tag.style.top = `${(1 - y) / 2 * hh}px`;
      tag.innerHTML = `<i style="transform:rotate(${ang.toFixed(0)}deg)">➤</i><span>月</span>`;
      tag.hidden = false;
    },
  };
})();
/* ===== 目線をある場所へなめらかに運ぶ（小さな旅で使う）。触ったらそこで止まる ===== */
const Fly = (() => {
  let job = null; const q = new THREE.Quaternion(), qi = new THREE.Quaternion(), tmp = [0, 0, 0];
  renderer.domElement.addEventListener("pointerdown", () => { job = null; });
  return {
    to(lat, lon, dist, ms = 1400) {
      toXYZ(lat, lon, 1, tmp, 0);
      const from = camera.position.clone(), dir = from.clone().normalize(), target = new THREE.Vector3(...tmp);
      job = { t0: performance.now(), ms, q: new THREE.Quaternion().setFromUnitVectors(dir, target), from, d0: from.length(), d1: dist };
    },
    tick(now) {
      if (!job) return;
      const f = Math.min(1, (now - job.t0) / job.ms), e = f < .5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2;
      q.copy(qi).slerp(job.q, e);
      camera.position.copy(job.from).normalize().applyQuaternion(q).multiplyScalar(job.d0 + (job.d1 - job.d0) * e); camera.lookAt(0, 0, 0);
      if (f >= 1) job = null;
    },
  };
})();
const Rotate = (() => {
  const Y = new THREE.Vector3(0, 1, 0), SPEEDS = { slow: 10, mid: 30, fast: 60 };   /* 画面の1秒で、地球の何分ぶん回すか */
  let on = false, speed = "mid", pauseUntil = 0, satWas = false, onChange = null;
  let tiltK = 0, badgeAt = 0; const EP = new THREE.Vector3(), UP = new THREE.Vector3(), D = new THREE.Vector3(), YP = new THREE.Vector3();
  const el = renderer.domElement;
  el.addEventListener("pointerdown", () => { pauseUntil = Infinity; });
  const resume = () => { if (pauseUntil === Infinity) pauseUntil = performance.now() + 2500; };
  el.addEventListener("pointerup", resume); el.addEventListener("pointercancel", resume);
  el.addEventListener("wheel", () => { pauseUntil = Math.max(pauseUntil, performance.now() + 1500); }, { passive: true });
  return {
    SPEEDS,
    get on() { return on; }, get speed() { return speed; }, set speed(v) { if (SPEEDS[v]) speed = v; },
    set onChange(f) { onChange = f; },
    set on(v) {
      v = !!v; if (v === on) return; on = v;
      if (on) { satWas = !!SatLayer?.visible; if (satWas) SatLayer.visible = false; }   /* 衛星は「いま」の位置で飛ぶので、早回しの間はお休み（止めたら元に戻す） */
      else { spinAngle = 0; realSun(); if (SatLayer && satWas) SatLayer.visible = true; satWas = false; }
      const fab = document.getElementById("spinfab"); if (fab) { fab.setAttribute("aria-pressed", String(on)); fab.setAttribute("aria-label", on ? "地球を回すのをやめる" : "地球を回す（自転の演出）"); }
      const bd = document.getElementById("spinbadge");
      if (bd) {
        if (on) { const ss = subsolarPoint(Clock.now()), la = Math.abs(ss.lat).toFixed(1);
          bd.innerHTML = `<b>↻ 自転（オブジェ表示）</b><br>地軸の傾き ${EARTH.axialTiltDeg.toFixed(1)}°・向きは今日の本物<br>太陽の真下 ${ss.lat >= 0 ? "北緯" : "南緯"}${la}°（${ss.lat >= 0 ? "北" : "南"}半球が夏の側）<br><span id="moonline">月</span><br><span>速さと昼夜の位置は演出。月は距離だけ縮めています（本物は地球の約60倍の遠さ）</span>`; }
        bd.hidden = !on;
      }
      document.body.classList.toggle("objet", on);   /* オブジェ表示：下の帯と操作の案内を隠す（歯車・回すボタン・左上の注意書きは残す） */
      onChange?.(on);
    },
    tick(now, dt) {
      /* 地軸の傾き：画面の「上」を地球の軸ではなく、地球が太陽を回る面（黄道）の北に向ける。
         すると地軸が本物どおり約23.4°傾いて見える。向きは今日の星空と太陽に合わせて計算（黄道の北極＝赤経18h・赤緯+66.56°）。
         オン／オフは少しずつ傾ける・戻す */
      tiltK += ((on ? 1 : 0) - tiltK) * Math.min(1, dt / 450);
      if (!on && tiltK < 0.002) { tiltK = 0; if (camera.up.y !== 1) camera.up.set(0, 1, 0); }
      else {
        const p = [0, 0, 0]; toXYZ(90 - EARTH.axialTiltDeg, 270, 1, p, 0);
        EP.set(p[0], p[1], p[2]).applyAxisAngle(Y, -gmstDeg(Clock.now()) * D2R + spinAngle);
        UP.copy(Y).lerp(EP, tiltK).normalize();
        D.copy(camera.position).normalize();
        UP.addScaledVector(D, -UP.dot(D)); const len = UP.length();          /* 見る向きと重なると上が決まらないので、そのときは地軸の上へ寄せる */
        if (len < 0.3) { YP.copy(Y).addScaledVector(D, -Y.dot(D)).normalize(); UP.normalize().lerp(YP, 1 - len / 0.3); }
        camera.up.copy(UP.normalize());
      }
      MoonLayer.tick(tiltK, spinAngle);
      if (on && now - badgeAt > 1000) { badgeAt = now; const m = MoonLayer.info, el = document.getElementById("moonline"); if (m && el) el.textContent = `月　月齢 約${m.age.toFixed(1)}・いまの距離 約${(m.km / 10000).toFixed(1)}万km`; }
      if (!on || now < pauseUntil) return;
      const a = -(SPEEDS[speed] / 1440) * 2 * Math.PI * (dt / 1000);   /* 1440分＝1日で1周 */
      camera.position.applyAxisAngle(Y, a); camera.lookAt(0, 0, 0);
      sunDir.applyAxisAngle(Y, a); spinAngle += a;
    },
  };
})();
document.getElementById("spinfab")?.addEventListener("click", () => { Rotate.on = !Rotate.on; });   /* 歯車の外の丸ボタン：押すたびに回す／止める（速さはパネルの中で） */
function resize() { const w = stage.clientWidth, h = stage.clientHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); CurrentLayer?.resize(); }
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
  ["鮮度", `${wm.delivery}／通常${wm.usualIntervalH}時間ごと<br><span style="color:var(--ink-faint)">下の札の色＝データの古さ：<span style="color:var(--accent)">緑</span> 3時間以内／<span style="color:#f2d45c">黄</span> 3〜6時間／<span style="color:#ff9f43">橙</span> 6〜9時間／<span style="color:#ff6b6b">赤</span> 9時間以上。水源（無料の配信元）を守るため、数時間の遅れは残ります</span>${Catalog.generatedAt ? `<br><span class="num" style="color:var(--ink-faint)">取得 ${fmtJST(Catalog.generatedAt)}</span>` : ""}`],
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
  + (CurrentLayer ? `<div class="layer"><label>${CurrentLayer.meta.title}<span style="font-weight:400;color:var(--ink-faint);font-size:11.5px">　${CurrentLayer.meta.kind}</span></label>
      <div class="sub">${CurrentLayer.meta.model}。${CurrentLayer.meta.caution}<br>解像度：${CurrentLayer.meta.resolution}<br>出典：${CurrentLayer.meta.credit}</div></div>` : "")
  + `<div class="layer" id="why"><label>なんで？（小さな辞典）</label>
      <div class="sub"><a href="learn/typhoon.html" style="color:var(--accent)">台風の風と雲のしくみ</a>：地上で吸い込み、目の壁でのぼり、上空で吹き出し、目で下がる（動く模式図）<br><a href="learn/winds.html" style="color:var(--accent)">地球の大きな風の帯</a>：貿易風・偏西風・ジェット気流・極東風と、それを作る空気の大きな輪<br><a href="learn/earth.html" style="color:var(--accent)">プレートの一生</a>：海嶺で生まれ、海を旅して、海溝で沈む。地震の点の色の読み方、若い板と古い板、静かな境目（動く模式図）</div></div>`
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
    <div class="mysets presets" role="group" aria-label="自分のセット"></div>
    <div class="myhelp" hidden>
      <b>自分のセットとは</b>
      いま出している層の組み合わせに名前を付けて、ワンタップで呼び出せるようにするものです。
      <ul>
        <li>覚えるもの：出している層、モード（流れる地球・ふつうの地球儀・重ねる・地名）、国境の見方</li>
        <li>3つまで保存できます。名前の横の「×」で消せます</li>
        <li>保存先は<b>この端末の、このブラウザの中だけ</b>です。どこにも送りません</li>
        <li>そのため、別の端末や別のブラウザ（例：iPhone の Safari で作ったセットを、パソコンや Brave で開く）では出てきません</li>
        <li>プライベートブラウズを閉じたときや、ブラウザの履歴とデータを消したときは、なくなります</li>
      </ul>
      よく使う端末ごとに、1回ずつ作ってください。
    </div>
    <div class="spinrow presets" role="group" aria-label="自転の演出"><span class="cap">自転</span><button type="button" data-spin="1" aria-pressed="false">↻ 地球を回す</button>
      <span class="spinspd" hidden>${Object.entries({ slow: "ゆっくり", mid: "ふつう", fast: "はやい" }).map(([k, t]) => `<button type="button" data-spinspd="${k}" aria-pressed="${k === Rotate.speed}">${t}</button>`).join("")}</span></div>
    <p class="note spin-note" hidden></p>
    <p class="jumps"><span>地球儀で「なぜ？」を探す</span><button type="button" data-jump="tours">見てみよう（小さな旅）↓</button></p>
    <div class="groups" aria-label="層を出す・消す"></div>
    <p class="jumps">この下に、層ごとの説明と出典、「なんで？」の小さな辞典があります　<button type="button" data-jump="d-layers">説明へ ↓</button><button type="button" data-jump="why">なんで？へ ↓</button></p>
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
    { key: "front", label: "気温の境目", get: () => !!FrontLayer?.visible, set: v => FrontLayer?.setOn(v).then(() => typeof syncChips === "function" && syncChips()) },
    { key: "pressure", label: "気圧", get: () => layerById("pressure")?.visible, set: v => setLayer("pressure", v) },
    { key: "currents", label: "海流", get: () => !!CurrentLayer?.visible, set: v => CurrentLayer?.setOn(v) },
    { key: "sst-anom", label: "海水温（平年差）", get: () => layerById("sst-anom")?.visible, set: v => setLayer("sst-anom", v) },
    { key: "sea-ice", label: "海氷", get: () => layerById("sea-ice")?.visible, set: v => setLayer("sea-ice", v) },
    { key: "quakes", label: "地震", get: () => layerById("quakes")?.visible, set: v => setLayer("quakes", v) },
    { key: "quakehist", label: "過去の地震（深さ）", get: () => !!QuakeHistLayer?.visible, set: v => QuakeHistLayer?.setOn(v).then(() => typeof syncChips === "function" && syncChips()) },
    { key: "seaage", label: "海底の年齢", get: () => !!SeaAgeLayer?.visible, set: v => SeaAgeLayer?.setOn(v).then(() => typeof syncChips === "function" && syncChips()) },
    { key: "platemove", label: "プレートの動き", get: () => PlateMoveLayer.visible, set: v => PlateMoveLayer.setOn(v).then(() => typeof syncChips === "function" && syncChips()) },
    { key: "interior", label: "地球の中（断面）", get: () => InteriorLayer.visible, set: v => InteriorLayer.setOn(v) },
    { key: "volcanoes", label: "火山", get: () => layerById("volcanoes")?.visible, set: v => setLayer("volcanoes", v) },
    { key: "sats", label: "人工衛星", get: () => layerById("sats")?.visible, set: v => setLayer("sats", v) },
    { key: "aurora", label: "オーロラ帯", get: () => AuroraLayer?.visible, set: v => { if (AuroraLayer) { AuroraLayer.visible = v; AuroraLayer.userOn = v; } } },
    { key: "milky", label: "天の川", get: () => SkyLayer?.milky, set: v => { if (SkyLayer) SkyLayer.milky = v; } },
    { key: "plates", label: "プレート", get: () => PlateLayer?.visible, set: v => { if (PlateLayer) { PlateLayer.visible = v; PlateLayer.userOn = v; const cb = document.getElementById("t-plates"); if (cb) cb.checked = v; } } },
    { key: "guide", label: "赤道・日付変更線", get: () => GuideLayer?.visible, set: v => { if (GuideLayer) { GuideLayer.visible = v; GuideLayer.userOn = v; } } },
    { key: "capitals", label: "★ 首都", get: () => CapitalLayer?.visible, set: v => { if (CapitalLayer) CapitalLayer.visible = v; } },
    { key: "map", label: "国境・地名", get: () => MapLayer.visible, set: v => { MapLayer.visible = v; box.querySelector(".viewbox").hidden = !v; } },
    { key: "sky", label: "✦ 星座", get: () => SkyLayer?.visible, set: v => { if (SkyLayer) SkyLayer.visible = v; } },
  ].filter(c => c.key === "wind" || c.key === "map" || (c.key === "front" ? !!FrontLayer : false) || c.key === "interior" || c.key === "platemove" || (c.key === "seaage" ? !!SeaAgeLayer : false) || (c.key === "quakehist" ? !!QuakeHistLayer : false) || (c.key === "currents" ? !!CurrentLayer : false) || ((c.key === "sky" || c.key === "milky") ? !!SkyLayer : c.key === "guide" ? !!GuideLayer : c.key === "aurora" ? !!AuroraLayer : c.key === "plates" ? !!PlateLayer : c.key === "capitals" ? !!CapitalLayer : !!layerById(c.key)));
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
    if (CurrentLayer?.visible && !P.on.includes("currents")) CurrentLayer.setOn(false);   /* 先に海流をやめて、風を選べるようにする */
    for (const c of CHIPS) { if (KEEP.includes(c.key) || box.querySelector(`[data-chip="${c.key}"]`)?.disabled) continue; const want = P.on.includes(c.key); if (!!c.get() !== want) c.set(want); }
    if (P.far && camera.position.length() < P.far) camera.position.setLength(P.far);   /* 宇宙は、衛星が入るところまで引く */
    syncChips(); updateChip();
  };
  /* 見てみよう（小さな旅）：その場所へ回り込み、必要な層だけ出して、問いを1つだけ出す。答えは辞典に */
  const TOURS = [
    { key: "slab", label: "日本の下の板", on: ["quakehist", "plates"], at: [37, 139, 2.3], link: "learn/earth.html#subduction",
      q: "日本海溝（東の線）から西の陸の方へ、点の色が 橙 → 黄緑 → 青紫 と変わっていく。地面の下で、何が起きている？", act: { label: "断面で確かめる", run: () => { const c = CHIPS.find(c => c.key === "interior"); if (c && !c.get()) c.set(true); } } },
    { key: "life", label: "生まれる海・沈む海", on: ["platemove", "plates"], at: [5, -140, 3.4], link: "learn/earth.html#life",
      q: "右の海嶺で赤く生まれた線は、どこへ向かって、どこで消える？　途中で色が赤→黄→青と変わるのはなぜ？" },
    { key: "young", label: "チリの南が静かなわけ", on: ["quakehist", "plates", "seaage"], at: [-43, -78, 2.2], link: "learn/earth.html#young",
      q: "南緯46°あたりから南だけ、地震の点が少ない。左のジグザグの線（海嶺）と、海底の色にヒントがある。なぜ？" },
    { key: "quiet", label: "静かな境目は安全？", on: ["quakehist", "plates"], at: [32, 135, 2.1], link: "learn/earth.html#locked",
      q: "南海トラフ（四国・紀伊半島の沖の線）に沿っては、点が少ない。少ない＝安全、と言える？", foot: "この地球儀は、地震が起きるかどうかの判断はしません。公式の情報は気象庁・地震本部へ" },
    { key: "slide", label: "ずれる境目", on: ["quakehist", "plates", "platemove"], at: [53, -178, 2.3], link: "learn/earth.html#slide",
      q: "アリューシャンの弓は、東の端と西の端で点の色（深さ）がちがう。動く線の向きと、弓の線の向きを比べてみると？" },
  ];
  const card = document.getElementById("tourcard");
  const startTour = T => {
    if (Rotate.on) Rotate.on = false;
    if (InteriorLayer.visible) { const c = CHIPS.find(c => c.key === "interior"); c?.set(false); }
    setMode("globe"); applyPreset({ on: T.on });
    Fly.to(T.at[0], T.at[1], T.at[2]);
    const dk = document.getElementById("dock"), dt = document.getElementById("lens"); if (dk && dt && !dt.hidden) { dt.hidden = true; dk.setAttribute("aria-expanded", "false"); }
    if (card) {
      card.querySelector(".tq").textContent = T.q;
      card.querySelector(".ta").innerHTML = `<a href="${T.link}">辞典で答えを読む →</a>${T.act ? `<button type="button" class="tact">${T.act.label}</button>` : ""}${T.foot ? `<span class="tf">${T.foot}</span>` : ""}`;
      const b = card.querySelector(".tact"); if (b) b.onclick = () => { T.act.run(); card.hidden = true; };
      card.hidden = false;
    }
  };
  if (card) card.querySelector(".tx").onclick = () => { card.hidden = true; };
  /* 層のボタンを分野ごとの枠に分ける（ダッシュボードのように）。枠はたためる（たたんだ状態はこの端末にだけ覚える） */
  const GROUPS = [
    { key: "air", en: "AIR", ja: "空気", keys: ["wind", "rain", "cloud-ir", "pressure", "front"] },
    { key: "sea", en: "SEA", ja: "海", keys: ["currents", "sst-anom", "sea-ice"] },
    { key: "earth", en: "EARTH", ja: "大地", keys: ["quakes", "quakehist", "plates", "platemove", "seaage", "volcanoes", "interior"] },
    { key: "space", en: "SPACE", ja: "宇宙", keys: ["sats", "aurora", "milky", "sky"] },
    { key: "map", en: "MAP", ja: "地図", keys: ["map", "capitals", "guide"] },
  ];
  const GKEY = "globe.groupsClosed.v1";
  const closed = (() => { try { return new Set(JSON.parse(localStorage.getItem(GKEY) || "[]")); } catch (_) { return new Set(); } })();
  const chipHtml = c => `<button type="button" data-chip="${c.key}">${c.label}</button>`;
  const placed = new Set();
  box.querySelector(".groups").innerHTML = GROUPS.map(G => {
    const cs = G.keys.map(k => CHIPS.find(c => c.key === k)).filter(Boolean); cs.forEach(c => placed.add(c.key)); if (!cs.length) return "";
    return `<section class="grp" data-grp="${G.key}"${closed.has(G.key) ? " data-closed" : ""}>
      <button type="button" class="grp-h" data-grptoggle="${G.key}" aria-expanded="${!closed.has(G.key)}"><span class="en">${G.en}</span><span class="ja">${G.ja}</span><span class="cnt" data-cnt="${G.key}"></span><span class="chev" aria-hidden="true">▾</span></button>
      <div class="grp-b"><div class="chips" role="group" aria-label="${G.ja}の層">${cs.map(chipHtml).join("")}</div></div></section>`; }).join("")
    + (CHIPS.some(c => !placed.has(c.key)) ? `<section class="grp" data-grp="other"><div class="grp-b"><div class="chips">${CHIPS.filter(c => !placed.has(c.key)).map(chipHtml).join("")}</div></div></section>` : "");
  const grpBody = k => box.querySelector(`[data-grp="${k}"] .grp-b`);
  /* 風の高さと風の名前は AIR の中へ、国境の見方は MAP の中へ */
  const WIND_NAMES = [
    { key: "trade", label: "貿易風", lev: 0, band: [0, 30], note: "貿易風：赤道〜緯度30°くらいを、東から西へ吹く風（青い線）。北半球では北東から、南半球では南東から吹く。地上から1〜2kmの薄い層" },
    { key: "west", label: "偏西風", lev: 2, band: [30, 60], note: "偏西風：緯度30〜60°くらいを、西から東へ吹く風（橙の線）。波打ちながら天気を東へ運ぶ。地上から上空まで分厚い層で、上ほど強い" },
    { key: "jet", label: "ジェット気流", lev: 3, band: [20, 65], jet: 12, note: "ジェット気流：偏西風の中の一番速い筋（約10km）。速い線だけを明るくしている。日本の上空は世界でも特に強い場所" },
    { key: "polar", label: "極東風", lev: 0, band: [60, 90], note: "極東風：極のまわりを、東から西へ吹く冷たい風（青い線）。弱くて乱れやすい" },
  ];
  const airB = grpBody("air");
  if (airB) {
    airB.insertAdjacentHTML("beforeend", `<div class="wnames"><span class="cap">風の名前</span>${WIND_NAMES.map(w => `<button type="button" data-wname="${w.key}">${w.label}</button>`).join("")}<button type="button" data-wdir="1" aria-pressed="false">東西の色分け</button></div>
      <p class="note wname-note" hidden></p>
      <p class="note wdir-legend" hidden><span style="color:rgb(255,153,71)">━ 東へ吹く風</span>　<span style="color:rgb(77,184,255)">━ 西へ吹く風</span>　（線の色を速さではなく向きで。データはそのまま）</p>`);
    const wh = box.querySelector(".windh"); if (wh) airB.appendChild(wh);
    if (FrontLayer) airB.insertAdjacentHTML("beforeend", `<p class="note fr-note" hidden><b>気温の境目</b>：約1.5km（850 hPa）の気温を、<span style="color:rgb(90,150,255)">青 寒い</span> → <span style="color:rgb(255,170,80)">橙 暖かい</span> でうすく塗り、気温が急に変わる所（寒い空気と暖かい空気の境目）を<span style="color:rgb(255,240,180)">明るく</span>光らせています。前線は、こういう境目にできます。低気圧の雲や雨の帯と重ねて見てください。<b>天気図の前線そのものではありません</b>（前線は気象庁の予報官が判断して引くものです。本物は<a href="https://www.jma.go.jp/bosai/weather_map/" target="_blank" rel="noopener" style="color:var(--accent)">気象庁の天気図</a>で）。高い山や南極・グリーンランドの氷床の上は、この高さが地面の下になるので出していません</p>`);
  }
  const mapB = grpBody("map"); if (mapB) mapB.appendChild(box.querySelector(".viewbox"));
  /* 海流：出している間は風の線をお休みにする（消したのではなく、やめると元に戻す） */
  const seaB = grpBody("sea");
  if (seaB && CurrentLayer) seaB.insertAdjacentHTML("beforeend", `<p class="note cur-note" hidden><b>海流（いつもの流れ）</b>：今日の海流ではなく、漂流ブイの何十年ぶんの記録から作った<b>${CurrentLayer.meta.month}月のいつもの流れ</b>です。線の色＝水温（同じ記録の平年値）：<span style="color:rgb(64,140,255)">青 冷たい</span> → <span style="color:rgb(150,240,215)">緑がかった白</span> → <span style="color:rgb(255,150,64)">橙</span> → <span style="color:rgb(255,77,64)">赤 温かい</span>。暖流（黒潮・メキシコ湾流など）は温かい水を極の方へ、寒流（親潮・カリフォルニア海流など）は冷たい水を赤道の方へ運びます。流れる速さは見やすさのための倍率（本物は速い所で秒速1〜2m）。海流の名札は「だいたいこの辺を流れる」目安の位置で、文字の色は<span style="color:rgb(255,176,110)">暖流＝橙</span>・<span style="color:rgb(125,200,255)">寒流＝水色</span>。拡大すると名札が増えます。出している間、風の線はお休みです</p>`);
  /* 地球の中（断面）：入る前の層の状態を覚えて全部しまい、ほかのボタンは押せなくする。出るときに元へ戻す */
  const earthB = grpBody("earth");
  if (earthB) earthB.insertAdjacentHTML("beforeend", `<p class="note int-note" hidden><b>地球の中（断面）</b>：日本を東西に通る断面と、東経125°の断面で、地球を4分の1切り取っています。層の深さは地震波から作られた標準モデル（PREM）、切り口の色は深さごとの温度の推定（文献の代表的な値で、数百℃の幅があります）。切り取った中の点は、1990〜2025年の M5.0 以上の地震を本当の深さに置いたものです。プレートの境目（地表の線）も一緒に出しています。点の列が地表の境目（海溝）から始まって、斜めに深くなっていくのを見てください（色＝深さ：<span style="color:rgb(255,158,64)">橙 浅い〜70km</span>／<span style="color:rgb(160,240,120)">黄緑 70〜300km</span>／<span style="color:rgb(130,170,255)">青紫 300km〜</span>）。日本の下で、点が斜めに深くなっていく列が、沈み込んだ海のプレートだと考えられています。中の動き（マントル対流など）は、まだ入れていません</p>`);
  if (earthB && QuakeHistLayer) earthB.insertAdjacentHTML("beforeend", `<p class="note qh-note" hidden><b>過去の地震（深さ）</b>：1990〜2025年の M5.0 以上、約6万件の震央です（USGS の記録。予測ではありません）。色＝震源の深さ：<span style="color:rgb(255,158,64)">橙 〜70km</span>／<span style="color:rgb(220,235,90)">黄</span>〜<span style="color:rgb(120,240,140)">黄緑 70〜300km</span>／<span style="color:rgb(130,170,255)">青紫 300km〜</span>。ほとんどがプレートの境目に並びます。海溝から陸側へ、橙→黄緑→青紫と深くなっていく所は、海のプレートがその向きへ沈み込んでいると考えられている所です。「プレート」と一緒に出すと見比べやすくなります</p>`);
  if (earthB) earthB.insertAdjacentHTML("beforeend", `<p class="note pm-note" hidden><b>プレートの動き</b>：研究モデル（PB2002、Bird 2003）の回り方から計算した、ここ数百万年の平均の動きです。基準は「地球全体として回っていない」と見る取り方（NNR）。線は通った跡で、先頭がいまの位置です。<b>線の色は、その場所の海底の年齢から付けた「温かさの目安」</b>：海嶺で生まれたばかりの若い板は熱く（赤〜だいだい）、離れて年をとるほど冷えて青くなります（冷えると重くなり、やがて海溝で沈む）。温度の数字ではなく年齢による目安です。陸の上は年齢のデータがないので白。プレートごとにまとまって動き、ほかのプレートに入ると消えます（沈む・押し合う所）。新しい線の半分は「広がる」境目（海嶺）の脇から出しています（生まれる所の演出）。速さは早送りで、1秒でおよそ80万年ぶん（本物は1年に数cm）。地表をタップすると、その場所の速さと向きが出ます</p>
    <p class="note sa-note" hidden><b>海底の年齢</b>：海の底の岩ができてから何年か（研究モデル、Seton et al. 2020）。<span style="color:rgb(255,70,55)">赤 生まれたて</span> → <span style="color:rgb(245,224,80)">黄 約4千万年</span> → <span style="color:rgb(110,220,115)">緑 約7千万年</span> → <span style="color:rgb(70,185,240)">水色 約1億1千万年</span> → <span style="color:rgb(110,100,235)">青紫 約1億8千万年</span>。海嶺で生まれた海底は、両側へ運ばれながら古くなり、海溝で沈みます。陸と大陸棚はデータがありません</p>`);
  let intSaved = null;
  const intSync = on => {
    box.querySelectorAll("[data-chip]").forEach(b => { if (b.dataset.chip !== "interior" && b.dataset.chip !== "plates") b.disabled = on; });   /* 断面の間も、プレートの境目は出し入れできる */
    box.querySelectorAll("[data-mode],[data-preset],[data-myset],[data-wname],[data-wdir],[data-wlev]").forEach(b => { b.disabled = on; });   /* 小さな旅は押せる（断面から出て始める） */
    const nt = box.querySelector(".int-note"); if (nt) nt.hidden = !on;
  };
  InteriorLayer.onChange = on => {
    if (on) {
      intSaved = Object.fromEntries(CHIPS.filter(c => c.key !== "interior").map(c => [c.key, !!c.get()]));
      for (const c of CHIPS) if (c.key !== "interior" && c.key !== "sky" && c.key !== "milky" && c.get()) c.set(false);
      VisualParticles.visible = false; for (const l of SCALAR_LAYERS) { l.visible = false; }
      const pc = CHIPS.find(c => c.key === "plates"); if (pc && !pc.get()) pc.set(true);   /* 地震の点の「始まり」が分かるよう、プレートの境目は最初から出す */
      intSync(true);
    } else {
      intSync(false); setMode(curMode);                                 /* ボタンを戻し、モードの見た目に戻してから、入る前の層を戻す */
      if (intSaved) for (const c of CHIPS) if (c.key !== "interior" && intSaved[c.key] !== undefined && !!c.get() !== intSaved[c.key]) c.set(intSaved[c.key]);
      intSaved = null;
    }
    syncChips(); updateChip();
  };
  let windWas = false;
  const curSync = () => {
    const on = !!CurrentLayer?.visible;
    const wc = box.querySelector('[data-chip="wind"]'); if (wc) wc.disabled = on || (NamesMode && !NAMES_OK.includes("wind"));
    box.querySelectorAll("[data-wname],[data-wdir],[data-wlev]").forEach(b => { b.disabled = on; });
    const nt = box.querySelector(".cur-note"); if (nt) nt.hidden = !on;
    syncChips();
  };
  if (CurrentLayer) CurrentLayer.onChange = on => {
    if (on) { windWas = VisualParticles.visible; VisualParticles.visible = false; }
    else { VisualParticles.visible = windWas && !NamesMode; }
    curSync();
  };
  let wname = null;
  const setDir = v => { VisualParticles.dirMode = v; const b = box.querySelector("[data-wdir]"); if (b) b.setAttribute("aria-pressed", String(v)); const lg = box.querySelector(".wdir-legend"); if (lg) lg.hidden = !v; };
  const setWName = async key => {
    const W = WIND_NAMES.find(w => w.key === key); wname = W ? key : null;
    box.querySelectorAll("[data-wname]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.wname === wname)));
    const nt = box.querySelector(".wname-note");
    if (!W) { VisualParticles.setBand(null); if (nt) nt.hidden = true; return; }
    if (CurrentLayer?.visible) return;
    const wc = CHIPS.find(c => c.key === "wind"); if (wc && !wc.get()) wc.set(true);
    if (Catalog.has(WIND_LEVELS[W.lev].id)) { await setWindLevel(W.lev); box.querySelectorAll("[data-wlev]").forEach(x => x.setAttribute("aria-pressed", String(+x.dataset.wlev === W.lev))); }
    setDir(true); VisualParticles.setBand(W.band, W.jet || 0);
    if (nt) { nt.innerHTML = W.note + `。帯の範囲は目安で、実際の風は季節や日によってはみ出します　<a href="learn/winds.html" style="color:var(--accent)">辞典：地球の大きな風の帯</a>`; nt.hidden = false; }
    syncChips();
  };
  const syncCounts = () => GROUPS.forEach(G => { const el = box.querySelector(`[data-cnt="${G.key}"]`); if (!el) return; const n = G.keys.filter(k => { const c = CHIPS.find(c => c.key === k); return c && c.get(); }).length; el.textContent = n ? `${n}` : ""; });
  /* 見てみよう（小さな旅）のボタンは、パネルの下の方（「なんで？」の小さな辞典のすぐ上）にまとめる。上には「見てみよう ↓」の飛び先だけ */
  { const sec = document.createElement("div"); sec.className = "layer"; sec.id = "tours";
    sec.innerHTML = `<label>見てみよう（小さな旅）</label><div class="tours presets" role="group" aria-label="見てみよう（小さな旅）">${TOURS.filter(T => T.on.some(k => CHIPS.find(c => c.key === k))).map(T => `<button type="button" data-tour="${T.key}">${T.label}</button>`).join("")}</div>
      <div class="sub">押すと、その場所へ地球が回り込み、関係する層だけが出て、問いが1つ出ます。答えは「動く大地のしくみ」の辞典で</div>`;
    const why = document.getElementById("why"); (why ? why.before(sec) : document.getElementById("d-layers").appendChild(sec));
    sec.addEventListener("click", e => { const b = e.target.closest("[data-tour]"); if (b) startTour(TOURS.find(T => T.key === b.dataset.tour)); }); }
  box.querySelector(".presets").insertAdjacentHTML("beforeend", PRESETS.filter(P => P.on.some(k => CHIPS.find(c => c.key === k))).map(P => `<button type="button" data-preset="${P.key}">${P.label}</button>`).join(""));
  /* 自分のセット（カスタムプリセット）：いまの組み合わせを、この端末のブラウザに3つまで保存する。サーバーには送らない */
  const MY_KEY = "globe.mySets.v1", MY_MAX = 3;
  const myLoad = () => { try { const a = JSON.parse(localStorage.getItem(MY_KEY) || "[]"); return Array.isArray(a) ? a.slice(0, MY_MAX) : []; } catch (_) { return []; } };
  const mySave = a => { try { localStorage.setItem(MY_KEY, JSON.stringify(a)); return true; } catch (_) { return false; } };
  const esc = t => String(t).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const myRender = () => {
    const a = myLoad(), el = box.querySelector(".mysets");
    el.innerHTML = `<span class="cap">自分のセット</span><button type="button" class="help" data-myhelp="1" aria-expanded="${!box.querySelector(".myhelp").hidden}" aria-label="自分のセットの説明">？</button>` + a.map((m, i) => `<span class="myset"><button type="button" data-myset="${i}">${esc(m.name)}</button><button type="button" class="del" data-mydel="${i}" aria-label="${esc(m.name)}を消す">×</button></span>`).join("")
      + (a.length < MY_MAX ? `<button type="button" class="add" data-myadd="1">＋ いまの組み合わせを保存</button>` : "");
  };

  var syncChips = () => { box.querySelectorAll("[data-chip]").forEach(b => b.setAttribute("aria-pressed", String(!!CHIPS.find(c => c.key === b.dataset.chip).get()))); syncCounts(); const qn = box.querySelector(".qh-note"); if (qn) qn.hidden = !QuakeHistLayer?.visible; const fn = box.querySelector(".fr-note"); if (fn) fn.hidden = !FrontLayer?.visible; const pn = box.querySelector(".pm-note"); if (pn) pn.hidden = !PlateMoveLayer.visible; const sn = box.querySelector(".sa-note"); if (sn) sn.hidden = !SeaAgeLayer?.visible; };
  /* 地名の地球儀：文字が見やすいよう、選べる層をしぼった固定モード。入る前の状態を覚えておき、出るときに戻す */
  const NAMES_OK = ["map", "capitals", "guide", "plates", "platemove", "seaage", "quakes", "quakehist", "volcanoes"], NAMES_OFF_AT_START = ["quakes", "quakehist", "volcanoes", "plates", "platemove", "seaage"];
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
    if (Rotate.on) { const sc = box.querySelector('[data-chip="sats"]'); if (sc) sc.disabled = true; }   /* 自分のセットは地名モードでも使える（出せない層は飛ばす） */
    const wh = box.querySelector(".windh"); if (wh) wh.hidden = !!m.names;
    const wn = box.querySelector(".wnames"); if (wn) wn.hidden = !!m.names;
    box.querySelector(".names-note").hidden = !m.names;
    curMode = k; NamesMode = !!m.names;
    if (CurrentLayer?.visible) { windWas = m.wind; VisualParticles.visible = false; }   /* 海流を出している間は、風はお休みのまま（やめるとこのモードの風に戻る） */
    if (CurrentLayer) curSync();
    syncChips();
    updateChip();
  };
  /* 自転の演出：ボタンの見た目と、衛星のチップを押せなくする（消したのではなく、お休み） */
  const SPIN_TXT = { slow: "画面の1秒が地球の10分（1周は約2分半）", mid: "画面の1秒が地球の30分（1周は48秒）", fast: "画面の1秒が地球の1時間（1周は24秒）" };
  const spinSync = () => {
    const on = Rotate.on, b = box.querySelector("[data-spin]");
    b.setAttribute("aria-pressed", String(on)); b.textContent = on ? "■ 回すのをやめる" : "↻ 地球を回す";
    box.querySelector(".spinspd").hidden = !on;
    box.querySelectorAll("[data-spinspd]").forEach(x => x.setAttribute("aria-pressed", String(x.dataset.spinspd === Rotate.speed)));
    const nt = box.querySelector(".spin-note"); nt.hidden = !on;
    nt.innerHTML = `<b>自転の演出</b>：太陽を止めたまま、地球を西から東へ回しています。本当の速さ（1時間に15°、1周24時間）ではなく、${SPIN_TXT[Rotate.speed]}。画面の上を、地球が太陽を回る面の北に合わせているので、地軸が本物どおり約23.4°傾いて見えます（傾いている向きは今日の位置。真横から見ると一番よく傾いて見え、地軸がこちら向き・向こう向きに倒れている方向から見ると、まっすぐに見えます）。月は式で計算した本物の向き・満ち欠けで、いつも同じ面を地球に向けています（距離だけ縮めて描いています。本物は地球の半径の約60倍の遠さ。大きさの比は本物。表面の模様は作り物）。画面の外にいるときは、端に「➤ 月」と方向を出します。<br><b>月が見えないとき</b>：月は約27.3日で地球を1周するので、地球の自転よりずっとゆっくりです（「はやい」でも1周に約11分、「ふつう」で約22分、「ゆっくり」で1時間以上）。目線は宇宙で止まっているので、回し続ければいつか画面の中を通ります。ただ縦長の画面では、月が地球の手前か向こう側を通るときしか映らず、向こう側では地球に隠れることもあります。すぐ見たいときは、「➤ 月」の矢印の方へ指で地球を回すか、ピンチで少し引いてください。<br>回している間の昼と夜の位置は、本当の時刻とは合いません（やめると本当の位置に戻ります）。雲・風・地震などのデータは地球に付いたまま一緒に回るので、データの時刻は変わりません。${SatLayer ? "人工衛星は「いま」の位置で飛んでいるので、回している間はお休みです。" : ""}触ると止まり、離すとまた回ります`;
    const sc = box.querySelector('[data-chip="sats"]'); if (sc) sc.disabled = on || (NamesMode && !NAMES_OK.includes("sats"));
    const cb = document.getElementById("t-sats"); if (cb) { cb.disabled = on; cb.checked = !!SatLayer?.visible; }
    syncChips();
  };
  Rotate.onChange = spinSync;
  const setView = v => { MapLayer.view = v; box.querySelectorAll("[data-view]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.view === v))); };
  box.addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.wlev) { if (wname) setWName(null); const k = +b.dataset.wlev; setWindLevel(k).then(() => box.querySelectorAll("[data-wlev]").forEach(x => x.setAttribute("aria-pressed", String(x === b)))); return; }
    if (b.dataset.grptoggle) { const sec = b.closest(".grp"), k = b.dataset.grptoggle, isClosed = sec.toggleAttribute("data-closed"); b.setAttribute("aria-expanded", String(!isClosed));
      isClosed ? closed.add(k) : closed.delete(k); try { localStorage.setItem(GKEY, JSON.stringify([...closed])); } catch (_) {} return; }
    if (b.dataset.wname) { setWName(wname === b.dataset.wname ? null : b.dataset.wname); return; }
    if (b.dataset.wdir) { setDir(!VisualParticles.dirMode); return; }
    if (b.dataset.jump) { document.getElementById(b.dataset.jump)?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }); return; }
    if (b.dataset.tour) { startTour(TOURS.find(T => T.key === b.dataset.tour)); return; }
    if (b.dataset.spin) { Rotate.on = !Rotate.on; return; }
    if (b.dataset.spinspd) { Rotate.speed = b.dataset.spinspd; spinSync(); return; }
    if (b.dataset.preset) { applyPreset(PRESETS.find(P => P.key === b.dataset.preset)); return; }
    if (b.dataset.myhelp) { const h = box.querySelector(".myhelp"); h.hidden = !h.hidden; b.setAttribute("aria-expanded", String(!h.hidden)); return; }
    if (b.dataset.myadd) { const a = myLoad(); const name = (window.prompt("セットの名前（あとで見て分かる名前）", `マイセット${a.length + 1}`) || "").trim().slice(0, 16); if (!name) return;
      a.push({ name, mode: curMode, on: CHIPS.filter(c => c.get()).map(c => c.key), view: MapLayer.view });
      if (!mySave(a)) window.alert("このブラウザでは保存できませんでした（プライベートブラウズなど）"); myRender(); return; }
    if (b.dataset.myset) { const m = myLoad()[+b.dataset.myset]; if (!m) return;
      if (m.mode && MODES[m.mode] && m.mode !== curMode) setMode(m.mode);
      if (m.view && MapLayer.views[m.view]) setView(m.view);
      if (CurrentLayer?.visible && !m.on.includes("currents")) CurrentLayer.setOn(false);
      for (const c of CHIPS) { if (box.querySelector(`[data-chip="${c.key}"]`)?.disabled) continue; const want = m.on.includes(c.key); if (!!c.get() !== want) c.set(want); }
      syncChips(); updateChip(); return; }
    if (b.dataset.mydel) { const a = myLoad(), i = +b.dataset.mydel; if (!a[i] || !window.confirm(`「${a[i].name}」を消しますか？`)) return; a.splice(i, 1); mySave(a); myRender(); return; }
    if (b.dataset.chip) { const c = CHIPS.find(c => c.key === b.dataset.chip); c.set(!c.get()); syncChips(); return; }   /* 一つだけ出す・消す。他の層は勝手に消さない */
    if (b.dataset.mode) setMode(b.dataset.mode); if (b.dataset.view) setView(b.dataset.view); });
  setView("jp"); setMode("flow"); myRender();
}
for (const l of SCALAR_LAYERS) document.getElementById("t-" + l.id).addEventListener("change", e => { l.visible = e.target.checked; updateChip(); if (typeof syncChips === "function") syncChips(); });
/** 見る帯の札：いまの時計の時刻が「どれくらい前／後」か。止まっていたら知らせる */
function updateChip() {
  const chip = document.getElementById("d-fresh"), now = Date.now();
  const mismatch = SCALAR_LAYERS.some(l => l.visible && !Catalog.validAt(l.id, Clock.now()));
  let text, ok = false, age = "";
  if (Catalog.mode !== "live") text = "サンプル";
  else if (Catalog.generatedAt && now - Catalog.generatedAt > wm.usualIntervalH * 3 * 3600000) { text = "更新が止まっています"; age = "stop"; }
  else {
    const hf = (now - Clock.now()) / 3600000, h = Math.round(-hf);
    text = h === 0 ? "いまごろ" : h < 0 ? `約${-h}時間前` : `約${h}時間後`;
    ok = true;
    /* 古さで札の色を変える（3時間ごと）：緑 3時間以内／黄 3〜6／橙 6〜9／赤 9時間以上 */
    age = hf < 3 ? "a0" : hf < 6 ? "a1" : hf < 9 ? "a2" : "a3";
  }
  if (mismatch) { text = "時刻ちがいを含む"; ok = false; age = ""; }
  chip.textContent = text; chip.classList.toggle("ok", ok);
  chip.dataset.age = age;
  chip.title = age === "stop" ? "データの更新が止まっています" : age ? "札の色＝データの古さ（緑 3時間以内／黄 3〜6時間／橙 6〜9時間／赤 9時間以上）" : "";
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
    + (FrontLayer?.visible ? (() => { const f = FrontLayer.at(lo, la); return f ? `<br>約1.5kmの気温 <span class="num">${f[0]}℃</span>・変わり方 <span class="num">${f[1].toFixed(1)}℃/100km</span>${f[1] >= 3 ? "（境目）" : ""}` : ""; })() : "")
    + (PlateMoveLayer.visible ? (() => { const m = PlateMoveLayer.at(lo, la); if (!m) return ""; return `<br>プレートの動き（研究モデル） <span class="num">1年に約${(m[0] / 10).toFixed(1)} cm</span>　${DIRS[Math.round(m[1] / 22.5) % 16]}へ（${PLATE_JA[m[2]] ? PLATE_JA[m[2]] + "プレート" : m[2]}）`; })() : "")
    + (SeaAgeLayer?.visible ? (() => { const a = SeaAgeLayer.at(lo, la); return a === null ? "" : `<br>海底の年齢（推定） <span class="num">約${a >= 100 ? (a / 100).toFixed(1) + "億" : a * 100 + "万"}年</span>`; })() : "")
    + (CurrentLayer?.visible ? (() => { const c = CurrentLayer.sample(lo, la); if (!c) return ""; const sp = Math.hypot(c[0], c[1]), to = (Math.atan2(c[0], c[1]) / D2R + 360) % 360;
        return `<br>海流（${CurrentLayer.meta.month}月のいつもの流れ） <span class="num">${sp.toFixed(2)} m/s</span>　${DIRS[Math.round(to / 22.5) % 16]}へ${Number.isNaN(c[2]) ? "" : `・水温（平年） <span class="num">${c[2].toFixed(1)}℃</span>`}`; })() : "")
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

realSun();
let last = performance.now(), meterAt = last;
function loop(now) {
  const dt = Math.min(now - last, 100); last = now;
  frames.push(dt); if (frames.length > 120) frames.shift();
  if (VisualParticles.visible) VisualParticles.step(Math.min(dt / 16.667, 3));
  CurrentLayer?.tick(dt); InteriorLayer.tick(); QuakeHistLayer?.tick(); PlateMoveLayer.tick(dt);
  for (const l of SCALAR_LAYERS) l.tick?.(); MapLayer?.tick(); CapitalLayer?.tick(); StateLayer?.tick(); SkyLayer?.tick(); GuideLayer?.tick(); AuroraLayer?.tick(now); ShakeRipples?.tick(now, !!FEATURE_LAYERS.find(l => l.id === "quakes")?.visible);
  Fly.tick(now); Rotate.tick(now, dt); Spin.tick(); controls.update();
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
