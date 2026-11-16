/* ===== ダッシュボード：日本の地震（ためた記録） =====
   ・地球儀が更新の回ごとに気象庁の地震情報を1回だけもらい、ためたもの（data/quakejp/quakes.json）を読むだけ。水源へは行かない
   ・日本の地図に、マグニチュード（丸の大きさ）と最大震度（色）で置く。一覧には日時・場所・マグニチュード・最大震度
   ・過去の記録だけ。地震の予知・予報ではない。くわしくは気象庁へ
   2026-11-16 まことの案から作成 */
(() => {
"use strict";
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const host = $("jpquake"); if (!host) return;
const D2R = Math.PI / 180;
const VIEW = { w: 122, e: 149.5, s: 23.5, n: 46.5 };   /* 日本の地図の範囲 */
const SHINDO = { "1": ["震度1", 1, "#7f93b3"], "2": ["震度2", 2, "#4f8fd8"], "3": ["震度3", 3, "#3fb98a"], "4": ["震度4", 4, "#e6cf4a"],
  "5-": ["震度5弱", 5, "#f2a33a"], "5+": ["震度5強", 6, "#e8772e"], "6-": ["震度6弱", 7, "#e0463a"], "6+": ["震度6強", 8, "#b8282f"], "7": ["震度7", 9, "#9b3fbf"] };
const NOINT = "#9aa6bf";
const F = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const FS = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const PERIODS = { day: ["今日", 1], week: ["7日", 7], month: ["30日", 30], all: ["ためた分ぜんぶ", Infinity] };
const st = { rows: null, coast: null, period: "week", sort: "new", sel: null, doc: null };
try { const p = localStorage.getItem("dash.jpq.period"); if (PERIODS[p]) st.period = p; } catch (_) {}

const css = document.createElement("style");
css.textContent = `
#jpquake{max-width:1100px;margin:12px auto 0;min-height:0}
#jpquake .jq-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:8px}
#jpquake .jq-seg{display:flex;gap:4px;flex-wrap:wrap}
#jpquake .jq-seg button{font:inherit;font-size:13px;color:var(--ink);background:rgba(20,30,58,.85);border:1px solid var(--tile-edge);border-radius:999px;padding:5px 11px;cursor:pointer}
#jpquake .jq-seg button[aria-pressed="true"]{border-color:var(--accent);color:var(--accent)}
#jpquake .jq-body{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:14px}
@media (max-width:760px){#jpquake .jq-body{grid-template-columns:1fr}}
#jpquake canvas{width:100%;aspect-ratio:1/1;max-height:560px;border-radius:12px;background:#081226;display:block;touch-action:manipulation}
#jpquake .jq-sum{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:14px;margin:2px 0 8px}
#jpquake .jq-sum b{font-size:20px;font-variant-numeric:tabular-nums}
#jpquake .jq-list{max-height:520px;overflow:auto;border-top:1px solid var(--tile-edge)}
#jpquake .jq-row{display:grid;grid-template-columns:auto 1fr auto;gap:2px 10px;align-items:baseline;padding:8px 4px;border-bottom:1px solid var(--tile-edge);cursor:pointer;font-size:14.5px}
#jpquake .jq-row[aria-current="true"]{background:rgba(143,227,212,.10)}
#jpquake .jq-row .t{font-variant-numeric:tabular-nums;color:var(--ink-soft);font-size:13px;white-space:nowrap}
#jpquake .jq-row .a{min-width:0}
#jpquake .jq-row .m{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
#jpquake .jq-row .s{grid-column:2/-1;font-size:12.5px;color:var(--ink-soft)}
#jpquake .jq-int{display:inline-block;font-size:12px;padding:1px 7px;border-radius:6px;color:#0b1328;font-weight:700;margin-left:6px}
#jpquake .jq-legend{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:12px;color:var(--ink-soft);margin-top:8px}
#jpquake .jq-legend i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:4px;vertical-align:-1px}
#jpquake .jq-links{display:flex;flex-wrap:wrap;gap:10px;margin-top:10px}
#jpquake .jq-links a{color:var(--accent)}
`;
document.head.appendChild(css);

const intOf = r => SHINDO[r.maxi] || null;
const tOf = r => Date.parse(r.t);
function filtered() {
  const days = PERIODS[st.period][1], now = Date.now();
  let rows = st.rows || [];
  if (st.period === "day") { const j = new Date(now + 9 * 3600000); const d0 = Date.UTC(j.getUTCFullYear(), j.getUTCMonth(), j.getUTCDate()) - 9 * 3600000; rows = rows.filter(r => tOf(r) >= d0); }
  else if (days !== Infinity) rows = rows.filter(r => tOf(r) >= now - days * 86400000);
  return rows;
}
function proj(W, H) {   /* 緯度の真ん中でゆがみを直した、まっすぐな地図 */
  const kx = Math.cos(((VIEW.n + VIEW.s) / 2) * D2R), sx = W / ((VIEW.e - VIEW.w) * kx), sy = H / (VIEW.n - VIEW.s), s = Math.min(sx, sy);
  const ox = (W - (VIEW.e - VIEW.w) * kx * s) / 2, oy = (H - (VIEW.n - VIEW.s) * s) / 2;
  return (lon, lat) => [ox + (lon - VIEW.w) * kx * s, oy + (VIEW.n - lat) * s];
}
const radius = m => m == null ? 3 : Math.max(2.5, 1.8 * Math.pow(Math.max(0.5, m), 1.25));
let hits = [];
function draw() {
  const cv = host.querySelector("canvas"); if (!cv) return;
  const r = cv.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2); if (!r.width) return;
  cv.width = r.width * dpr; cv.height = r.height * dpr; const x = cv.getContext("2d"); x.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = r.width, H = r.height, P = proj(W, H);
  x.fillStyle = "#081226"; x.fillRect(0, 0, W, H);
  x.strokeStyle = "rgba(150,172,226,.10)"; x.lineWidth = 1; x.font = "10px sans-serif"; x.fillStyle = "rgba(150,172,226,.45)";
  for (let g = 125; g <= 145; g += 5) { const [px] = P(g, 0); x.beginPath(); x.moveTo(px, 0); x.lineTo(px, H); x.stroke(); x.fillText(`${g}°E`, px + 2, H - 4); }
  for (let g = 25; g <= 45; g += 5) { const [, py] = P(0, g); x.beginPath(); x.moveTo(0, py); x.lineTo(W, py); x.stroke(); x.fillText(`${g}°N`, 2, py - 2); }
  if (st.coast) { x.strokeStyle = "rgba(220,230,250,.7)"; x.lineWidth = 1; x.beginPath(); let pen = false;
    for (let i = 0; i < st.coast.length; i += 2) { if (st.coast[i] === 32767) { pen = false; continue; } const lo = st.coast[i] / 100, la = st.coast[i + 1] / 100;
      if (lo < VIEW.w - 3 || lo > VIEW.e + 3 || la < VIEW.s - 3 || la > VIEW.n + 3) { pen = false; continue; }
      const [px, py] = P(lo, la); if (pen) x.lineTo(px, py); else x.moveTo(px, py); pen = true; }
    x.stroke(); }
  const rows = filtered(), now = Date.now(), span = Math.max(1, PERIODS[st.period][1] === Infinity ? 365 : PERIODS[st.period][1]) * 86400000;
  hits = [];
  /* 小さい順に描いて、大きい地震を上に */
  for (const q of [...rows].sort((a, b) => (a.mag ?? 0) - (b.mag ?? 0))) {
    const [px, py] = P(q.lon, q.lat), rr = radius(q.mag), it = intOf(q), age = Math.min(1, (now - tOf(q)) / span);
    x.globalAlpha = 0.9 - 0.55 * age; x.fillStyle = it ? it[2] : NOINT; x.beginPath(); x.arc(px, py, rr, 0, 7); x.fill();
    x.globalAlpha = 1; x.strokeStyle = "rgba(3,6,14,.7)"; x.lineWidth = 1; x.stroke();
    hits.push([px, py, rr, q]);
  }
  x.globalAlpha = 1;
  if (rows[0]) { const [px, py] = P(rows[0].lon, rows[0].lat); x.strokeStyle = "#fff"; x.lineWidth = 1.5; x.beginPath(); x.arc(px, py, radius(rows[0].mag) + 4, 0, 7); x.stroke(); }
  if (st.sel) { const [px, py] = P(st.sel.lon, st.sel.lat); x.strokeStyle = "#8fe3d4"; x.lineWidth = 2.5; x.beginPath(); x.arc(px, py, radius(st.sel.mag) + 6, 0, 7); x.stroke(); }
}
function rowHtml(q) {
  const it = intOf(q);
  return `<div class="jq-row" data-eid="${esc(q.eid)}"${st.sel && st.sel.eid === q.eid ? ' aria-current="true"' : ""}>
    <span class="t">${esc(FS.format(new Date(tOf(q))))}</span><span class="a">${esc(q.area || "（場所の名前なし）")}</span>
    <span class="m">${q.mag != null ? "M" + q.mag.toFixed(1) : "M不明"}${it ? `<span class="jq-int" style="background:${it[2]}">${it[0]}</span>` : ""}</span>
    <span class="s">${q.dep != null ? (q.dep === 0 ? "ごく浅い" : `深さ ${q.dep} km`) : "深さ不明"}・${q.lat.toFixed(1)}°N ${q.lon.toFixed(1)}°E</span></div>`;
}
function render() {
  if (!st.rows || !st.doc) { draw(); return; }
  const rows = filtered(), maxM = rows.reduce((a, r) => r.mag != null && (a == null || r.mag > a) ? r.mag : a, null);
  const maxI = rows.reduce((a, r) => { const it = intOf(r); return it && (!a || it[1] > a[1]) ? it : a; }, null);
  const list = st.sort === "big" ? [...rows].sort((a, b) => (b.mag ?? -9) - (a.mag ?? -9)) : rows;
  const since = st.doc?.since ? F.format(new Date(Date.parse(st.doc.since))) : null;
  host.querySelector(".jq-sum").innerHTML = `<span>${esc(PERIODS[st.period][0])}の地震 <b>${rows.length.toLocaleString()}</b> 回</span>`
    + (maxM != null ? `<span>いちばん大きい <b>M${maxM.toFixed(1)}</b></span>` : "") + (maxI ? `<span>最大震度 <b>${maxI[0].replace("震度", "")}</b></span>` : "");
  host.querySelector(".jq-list").innerHTML = list.length ? list.slice(0, 200).map(rowHtml).join("") + (list.length > 200 ? `<p class="say">ほか ${list.length - 200} 回（地図には全部出ています）</p>` : "")
    : `<p class="say">${esc(PERIODS[st.period][0])}は、記録された地震がありません。</p>`;
  host.querySelector(".jq-since").textContent = since ? `ためはじめ：${since}ごろ から（それより前の地震は入っていません）` : "";
  host.querySelectorAll("[data-period]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.period === st.period)));
  host.querySelectorAll("[data-sort]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.sort === st.sort)));
  draw();
}
function mount() {
  host.innerHTML = `<div class="th">🗾 日本の地震（ためた記録）</div>
  <div class="jq-head"><div class="jq-seg" role="group" aria-label="期間">${Object.entries(PERIODS).map(([k, v]) => `<button type="button" data-period="${k}" aria-pressed="false">${v[0]}</button>`).join("")}</div>
    <span style="flex:1"></span><div class="jq-seg" role="group" aria-label="並べ方"><button type="button" data-sort="new" aria-pressed="true">新しい順</button><button type="button" data-sort="big" aria-pressed="false">大きい順</button></div></div>
  <div class="jq-sum"></div>
  <div class="jq-body"><div><canvas aria-label="日本の地図に置いた地震"></canvas>
    <div class="jq-legend"><span><i style="background:${NOINT}"></i>震度の情報なし</span>${["1", "2", "3", "4", "5-", "5+", "6-", "6+", "7"].map(k => SHINDO[k]).map(v => `<span><i style="background:${v[2]}"></i>${v[0].replace("震度", "")}</span>`).join("")}<span>・丸の大きさ＝マグニチュード・白い輪＝いちばん新しい（選んでいる場所は上の📍で）</span></div></div>
    <div class="jq-list"><p class="say">読んでいます…</p></div></div>
  <div class="jq-links"><a href="https://www.jma.go.jp/bosai/map.html#contents=earthquake_map" target="_blank" rel="noopener">くわしくは気象庁の地震情報へ →</a></div>
  <div class="say">過去の記録です。地震の予知や予報ではありません。気象庁が発表した地震情報（震度1以上を観測した地震など）を、地球儀が更新のたびにためたものです。最大震度は、その地震でいちばん強く揺れた所の震度です（お住まいの場所の揺れではありません）。<span class="jq-since"></span></div>
  <div class="tag">出典：気象庁ホームページ（地震情報）を加工して作成</div>`;
  host.addEventListener("click", e => {
    const p = e.target.closest("[data-period]"); if (p) { st.period = p.dataset.period; st.sel = null; try { localStorage.setItem("dash.jpq.period", st.period); } catch (_) {} render(); return; }
    const s = e.target.closest("[data-sort]"); if (s) { st.sort = s.dataset.sort; render(); return; }
    const row = e.target.closest(".jq-row"); if (row) { st.sel = (st.rows || []).find(q => q.eid === row.dataset.eid) || null; render(); return; }
  });
  host.querySelector("canvas").addEventListener("click", e => {
    const r = e.currentTarget.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top; let best = null, bd = 1e9;
    for (const [px, py, rr, q] of hits) { const d = Math.hypot(px - mx, py - my); if (d < rr + 8 && d < bd) { bd = d; best = q; } }
    st.sel = best; render();
    if (best) host.querySelector(`.jq-row[data-eid="${CSS.escape(best.eid)}"]`)?.scrollIntoView({ block: "nearest" });
  });
  addEventListener("resize", () => draw());
  addEventListener("dash:render", () => draw());
}
async function load() {
  mount();
  try { const r = await fetch("data/coast.bin"); if (r.ok) st.coast = new Int16Array(await r.arrayBuffer()); } catch (_) {}
  try { const r = await fetch("data/quakejp/quakes.json", { cache: "no-cache" }); if (!r.ok) throw new Error(r.status);
    st.doc = await r.json(); st.rows = (st.doc.rows || []).filter(q => Number.isFinite(q.lat) && Number.isFinite(q.lon) && Number.isFinite(Date.parse(q.t))).sort((a, b) => tOf(b) - tOf(a)); }
  catch (_) { st.rows = []; host.querySelector(".jq-list").innerHTML = '<p class="say">まだ記録がありません。次の更新から、ためはじめます。</p>'; }
  render();
}
if (document.readyState === "loading") addEventListener("DOMContentLoaded", load); else load();
})();
