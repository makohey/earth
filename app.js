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
      const e = this.meta(id).encoding, q = e.type === "linear" ? new Int16Array(bufs[id]) : new Uint8Array(bufs[id]), out = new Float32Array(q.length);
      const L = Math.log1p(e.max || 1);
      const decoders = {
        log1p: c => c === e.missing ? NaN : c === e.zero ? 0 : Math.expm1((c - 1) / e.levels * L),
        linear: c => c === e.missing ? NaN : c * e.scale + e.offset,
        raw: c => c === e.missing ? NaN : c,
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
  uniforms: { uLand: { value: buildLandMask() }, uSun: { value: sunDir }, uNight: { value: 1 }, uLights: { value: null }, uLightsOn: { value: 0 }, uIce: { value: null }, uIceOn: { value: 0 } },
  vertexShader: `varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D uLand; uniform sampler2D uLights; uniform sampler2D uIce; uniform float uIceOn; uniform vec3 uSun; uniform float uNight; uniform float uLightsOn; varying vec3 vPos;
    const float PI = 3.141592653589793;
    void main(){
      vec3 n = normalize(vPos);
      float lat = asin(clamp(n.y,-1.0,1.0)), lon = atan(-n.z, n.x);
      float land = texture2D(uLand, vec2((lon+PI)/(2.0*PI), (lat+PI*0.5)/PI)).r;
      vec3 ocean = mix(vec3(0.030,0.062,0.118), vec3(0.040,0.090,0.160), 0.5 + 0.5*n.y*n.y);
      vec3 ground = vec3(0.105,0.130,0.160);
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
      const c = rampRGBA(profile.stops, v); if (!c) continue;
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
  const pos = new Float32Array(feats.length * 3), age = new Float32Array(feats.length), size = new Float32Array(feats.length);
  feats.forEach((f, i) => { toXYZ(f.lat, f.lon, 1.0045, pos, i * 3); age[i] = (Clock.now() - f.time) / 60000 / profile.maxAgeMin; size[i] = profile.sizeOf ? profile.sizeOf(f) : 1; });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3)); geo.setAttribute("aAge", new THREE.BufferAttribute(age, 1)); geo.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uSize: { value: profile.size * renderer.getPixelRatio() }, uShow: { value: 0 }, uOpacity: { value: 1 }, uColor: { value: new THREE.Vector3(...profile.color) } },
    transparent: true, depthWrite: false,
    vertexShader: `attribute float aAge; attribute float aSize; uniform float uSize; varying float vAge;
      void main(){ vAge = aAge; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_PointSize = uSize * aSize; }`,
    fragmentShader: `uniform float uShow; uniform float uOpacity; uniform vec3 uColor; varying float vAge;
      void main(){ vec2 d = gl_PointCoord - 0.5; float r = length(d); if (r > 0.5) discard;
        float ring = smoothstep(0.5, 0.36, r) * (0.55 + 0.45 * smoothstep(0.30, 0.18, r));
        float a = ring * uShow * uOpacity * mix(1.0, 0.45, clamp(vAge, 0.0, 1.0));
        if (a < 0.01) discard; gl_FragColor = vec4(uColor, a); }`,
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
let MapLayer = null;
if (ON) { try { MapLayer = await createMapLayer(); MapLayer.view = "jp"; MapLayer.visible = false; } catch (e) { console.warn("地図を読めませんでした", e); } }
if (DEV && Catalog.has("metar")) FEATURE_LAYERS.push(createPointLayer(createFeatureSource("metar"), OBS_PROFILE));

/* 最近の地震：点の大きさ＝マグニチュード（USGS）。古いほど少し薄い。警報・判定はしない */
const QUAKE_PROFILE = {
  color: [1.00, 0.62, 0.42], size: 4.0,
  showFrom: 99, fullAt: 98,            // 引いた地球でも出す（数が少ないので）
  maxAgeMin: 24 * 60,
  sizeOf: f => Math.max(1, Math.min(6, (f.props.mag - 1.5) * 0.9)),
  describe(l) {
    const m = l.source.meta, big = l.feats.filter(f => f.props.mag >= 5).length;
    return `時計の時刻までの24時間・M2.5以上 <span class="num">${l.feats.length}</span>件（M5以上 <span class="num">${big}</span>件）<br>点の大きさ＝マグニチュード・点をタップで詳細<br>${m.caution}<br><a href="https://www.jma.go.jp/bosai/map.html#contents=earthquake_map" target="_blank" rel="noopener" style="color:var(--accent)">気象庁の地震情報</a><br>出典：${m.credit}`;
  },
  present(f) {
    const p = f.props, h = (Clock.now() - f.time) / 3600000;
    const ago = h < 1 ? `${Math.round(h * 60)}分前` : `${h.toFixed(h < 10 ? 1 : 0)}時間前`;
    return `地震 <span class="num">M${p.mag.toFixed(1)}（USGS）</span>　深さ <span class="num">${p.depth ?? "–"} km</span>　${p.place ?? ""} <span style="color:var(--ink-faint)">（時計の${ago}・震度ではありません）</span>`;
  },
};
if (ON && Catalog.has("quakes")) FEATURE_LAYERS.push(createPointLayer(createFeatureSource("quakes"), QUAKE_PROFILE));

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
  return { step, count: N, lines, set visible(v) { lines.visible = v; }, get visible() { return lines.visible; } };
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
  const legend = opts.profile && opts.profile.stops ? `<div class="legend"><div class="cap">${opts.profile.label}</div><div class="bar" style="background:linear-gradient(90deg, ${opts.profile.stops.map(([s, c], k) => `rgba(${c.slice(0,3).map(x => Math.round(x*255)).join(",")},${Math.max(c[3], .5)}) ${(k / (opts.profile.stops.length - 1) * 100).toFixed(0)}%`).join(", ")})"></div><div class="ticks">${opts.profile.ticks.map(v => `<span>${v}</span>`).join("")}</div></div>` : "";
  return `<div class="layer">
    <label><input type="checkbox" id="t-${id}" ${opts.visible ? "checked" : ""}> ${m.title}<span style="font-weight:400;color:var(--ink-faint);font-size:11.5px">　${m.kind}</span></label>
    <div class="sub">${fmtSpan(m)}${m.selection ? `（時計の <span class="num">${Math.round((Clock.now() - new Date(m.validTime)) / 60000)}</span>分前の画像）` : ""}・${m.resolution || ""}${m.coverage ? "・" + m.coverage : ""}${m.caution ? "<br>" + m.caution : ""}<br>出典：${m.credit}${m.sampleCredit ? "（" + m.sampleCredit + "）" : ""}</div>
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
      <div class="sub">${LAND_ICE.note}<br>出典：${LAND_ICE.credit}</div></div>` : "");
for (const l of FEATURE_LAYERS) document.getElementById("t-" + l.id).addEventListener("change", e => { l.visible = e.target.checked; });

/* 見せ方の切り替え（試作）：流れる地球／ふつうの地球儀／重ねる */
if (MapLayer) {
  const MODES = {
    flow:  { label: "流れる地球",     wind: true,  scalar: true,  map: false, night: 1 },
    globe: { label: "ふつうの地球儀", wind: false, scalar: false, map: true,  night: 0 },
    both:  { label: "重ねる",         wind: true,  scalar: true,  map: true,  night: 1 },
  };
  const box = document.createElement("div"); box.className = "modes";
  box.innerHTML = `<div class="seg" role="group" aria-label="見せ方">${Object.entries(MODES).map(([k, m]) => `<button type="button" data-mode="${k}">${m.label}</button>`).join("")}</div>
    <div class="viewbox"><div class="seg small" role="group" aria-label="国境の見方">${Object.entries(MapLayer.views).map(([k, t]) => `<button type="button" data-view="${k}">${t}</button>`).join("")}</div>
    <p class="note">国境の見方は二つから選べます。どちらも Natural Earth（パブリックドメイン）の見方別データです。</p></div>`;
  document.getElementById("detail").insertBefore(box, document.getElementById("d-rows"));
  const setMode = k => {
    const m = MODES[k]; VisualParticles.visible = m.wind; MapLayer.visible = m.map; globe.material.uniforms.uNight.value = m.night;
    for (const l of SCALAR_LAYERS) { const v = Boolean((m.scalar || l.profile.ground) && (!l.profile.modes || l.profile.modes.includes(k))) /* undefined だと three.js は「見える」と扱うので必ず真偽値に */; l.visible = v; const cb = document.getElementById("t-" + l.id); if (cb) cb.checked = v; }
    box.querySelectorAll("[data-mode]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.mode === k)));
    box.querySelector(".viewbox").hidden = !m.map;
    document.getElementById("d-mode").textContent = m.wind ? "風" : "地球儀";
    updateChip();
  };
  const setView = v => { MapLayer.view = v; box.querySelectorAll("[data-view]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.view === v))); };
  box.addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; if (b.dataset.mode) setMode(b.dataset.mode); if (b.dataset.view) setView(b.dataset.view); });
  setView("jp"); setMode("flow");
}
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
  const hit = raycaster.intersectObject(globe)[0]; if (!hit) return;
  const n = hit.point.clone().normalize(), la = Math.asin(n.y) / D2R, lo = Math.atan2(-n.z, n.x) / D2R;
  const [u, v] = field.sample(lo, la, Clock.now()), sp = Math.hypot(u, v), from = (Math.atan2(-u, -v) / D2R + 360) % 360;
  const ll = `${Math.abs(la).toFixed(1)}°${la >= 0 ? "N" : "S"} ${Math.abs(lo).toFixed(1)}°${lo >= 0 ? "E" : "W"}`;
  document.getElementById("d-pick").innerHTML = `<span class="num">${ll}</span>　風速 <span class="num">${sp.toFixed(1)} m/s</span>　${DIRS[Math.round(from / 22.5) % 16]}の風 <span style="color:var(--ink-faint)">（${wm.kind}・格子から補間）</span>`
    + SCALAR_LAYERS.filter(l => l.visible).map(l => presentValue(l, l.field.sample(lo, la, Clock.now()))).filter(Boolean).map(t => "<br>" + t).join("")
    + FEATURE_LAYERS.filter(l => l.shown).map(l => { const f = l.nearest(lo, la, 0.5 + 1.2 * (camera.position.length() - 1)); return f ? "<br>" + (l.profile.present ? l.profile.present(f) : presentObs(f)) : ""; }).join("");
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
  if (VisualParticles.visible) VisualParticles.step(Math.min(dt / 16.667, 3));
  MapLayer?.tick();
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
