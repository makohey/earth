/* ===== ダッシュボードの電卓（思考の道具） =====
   ・iPhone の電卓と同じものは作らない。「この数字って大きいの？」をその場で確かめる道具
   ・計算は自分で読み取って行う（eval も外のサービスも使わない）
   ・タイルの大きい数字を押すと、「どこの・何の値か」の札ごと電卓に入る
   ・天気を先へ延ばす計算は入れない（例：台風の速さ × 時間 → いつ着く、は予報になる）。過去と今の数字・物理の換算・天体の計算だけ
   ・どの答えにも単位を付け、目安のものは「目安」と書く
   設計：Notion「止まっている議論」9（2026-10-11）。2026-10-13 作成 */
(() => {
"use strict";
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const D2R = Math.PI / 180;
const DIRS = ["北","北北東","北東","東北東","東","東南東","南東","南南東","南","南南西","南西","西南西","西","西北西","北西","北北西"];
const fmt = v => { if (!Number.isFinite(v)) return "—"; const a = Math.abs(v); const d = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 2 : 4; return (+v.toFixed(d)).toLocaleString("ja-JP", { maximumFractionDigits: d }); };
const store = { get: k => { try { return localStorage.getItem(k); } catch (_) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} } };

/* ---------- 見た目 ---------- */
const css = `
.cfab{position:fixed;right:16px;bottom:calc(16px + env(safe-area-inset-bottom,0px));z-index:40;width:52px;height:52px;border-radius:50%;border:1px solid var(--tile-edge);background:#0d1630;color:var(--ink);font-size:24px;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.45)}
.cfab[aria-expanded="true"]{border-color:var(--accent)}
.cpan{position:fixed;left:0;right:0;bottom:0;z-index:39;max-height:72vh;overflow:auto;background:#0b1328;border-top:1px solid var(--tile-edge);border-radius:18px 18px 0 0;padding:12px 16px calc(78px + env(safe-area-inset-bottom,0px));box-shadow:0 -10px 30px rgba(0,0,0,.5)}
@media (min-width:900px){.cpan{left:auto;top:0;width:360px;max-height:none;border-radius:0;border-top:0;border-left:1px solid var(--tile-edge);padding-top:16px}body.calc-open{padding-right:376px}}
.cpan[hidden]{display:none}
.ctabs{display:flex;gap:6px;margin-bottom:10px}
.ctabs button,.ckeys button,.cbtn{font:inherit;color:var(--ink);background:rgba(20,30,58,.9);border:1px solid var(--tile-edge);border-radius:10px;cursor:pointer}
.ctabs button{flex:1;padding:7px 0;font-size:13px}.ctabs button[aria-selected="true"]{border-color:var(--accent);color:var(--accent)}
.cdisp{background:rgba(3,5,11,.7);border:1px solid var(--tile-edge);border-radius:12px;padding:8px 12px;margin-bottom:8px;min-height:74px}
.cdisp .lab{font-size:12px;color:var(--ink-soft);min-height:1.2em;word-break:break-all}
.cdisp .exp{font-family:var(--mono);font-size:15px;color:var(--ink-soft);min-height:1.3em;word-break:break-all}
.cdisp .res{font-family:var(--mono);font-size:26px;text-align:right;word-break:break-all}
.ckeys{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
.ckeys button{padding:11px 0;font-size:18px;font-family:var(--mono)}.ckeys .op{color:var(--accent)}.ckeys .eq{background:rgba(143,227,212,.18);border-color:var(--accent)}
.chist{margin-top:8px;font-size:12.5px;color:var(--ink-soft);line-height:1.7}
.chist div{border-top:1px dashed var(--tile-edge);padding-top:2px;cursor:pointer}
.cnote{font-size:11.5px;color:var(--ink-faint);line-height:1.6;margin:6px 0}
.crow{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:6px 0;font-size:14px}
.crow input,.crow select{font:inherit;font-size:16px;color:var(--ink);background:rgba(3,5,11,.7);border:1px solid var(--tile-edge);border-radius:8px;padding:6px 8px;min-width:0}
.crow input{width:8em}
.cout{display:grid;grid-template-columns:1fr auto;gap:3px 10px;font-size:14px;margin:4px 0 10px}
.cout span:nth-child(odd){color:var(--ink-soft)}
.cbtn{font-size:12px;padding:3px 8px}
.ccard{border:1px solid var(--tile-edge);border-radius:12px;padding:8px 10px;margin-bottom:10px}
.ccard h4{margin:0 0 4px;font-size:14px}
.takeable{text-decoration:underline dotted rgba(143,227,212,.7);text-underline-offset:5px;cursor:copy}
`;
const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

/* ---------- 式を読む（自前。eval は使わない） ---------- */
function evaluate(src) {
  const s = src.replace(/×/g, "*").replace(/÷/g, "/").replace(/−/g, "-").replace(/\s+/g, "");
  let i = 0;
  const peek = () => s[i], eat = c => { if (s[i] === c) { i++; return true; } return false; };
  function num() { const m = s.slice(i).match(/^\d*\.?\d+(?:e[+-]?\d+)?|^\d+\./); if (!m) throw new Error("数字がありません"); i += m[0].length; return parseFloat(m[0]); }
  function factor() { if (eat("-")) return -factor(); if (eat("+")) return factor(); if (eat("(")) { const v = expr(); if (!eat(")")) throw new Error("かっこが閉じていません"); return v; } return num(); }
  function term() { let v = factor(); for (;;) { if (eat("*")) v *= factor(); else if (eat("/")) { const d = factor(); if (d === 0) throw new Error("0では割れません"); v /= d; } else return v; } }
  function expr() { let v = term(); for (;;) { if (eat("+")) v += term(); else if (eat("-")) v -= term(); else return v; } }
  const v = expr(); if (i < s.length) throw new Error("読めない所があります"); return v;
}

/* ---------- 電卓の状態：部品の並び（数字には札がつくことがある） ---------- */
let parts = [], last = null;   // parts: {t:"num"|"op"|"(" |")", v:string, label?, unit?}
const hist = (() => { try { return JSON.parse(store.get("dash.calc.hist") || "[]"); } catch (_) { return []; } })();
function exprText() { return parts.map(p => p.v).join(" "); }
function labelText() { return parts.some(p => p.label) ? parts.map(p => p.label ? `${p.label}` : p.v).join(" ") : ""; }
function lastNum() { const p = parts[parts.length - 1]; return p && p.t === "num" ? p : null; }
function press(k) {
  if (last != null && /[0-9.]/.test(k)) { parts = []; last = null; }
  else if (last != null && /[+−×÷]/.test(k)) { parts = [{ t: "num", v: fmtRaw(last.v), label: last.label, unit: last.unit }]; last = null; }
  else last = null;
  const p = lastNum();
  if (/[0-9]/.test(k)) { if (p && !p.label) p.v = p.v === "0" ? k : p.v === "-0" ? "-" + k : p.v + k; else if (!p) parts.push({ t: "num", v: k }); }
  else if (k === ".") { if (p && !p.label) { if (!p.v.includes(".")) p.v += "."; } else if (!p) parts.push({ t: "num", v: "0." }); }
  else if (/[+−×÷]/.test(k)) { const q = parts[parts.length - 1]; if (q && q.t === "op") q.v = k; else if (q && q.t !== "(") parts.push({ t: "op", v: k }); }
  else if (k === "(") { const q = parts[parts.length - 1]; if (!q || q.t === "op" || q.t === "(") parts.push({ t: "(", v: "(" }); }
  else if (k === ")") { const open = parts.filter(x => x.t === "(").length - parts.filter(x => x.t === ")").length, q = parts[parts.length - 1]; if (open > 0 && q && (q.t === "num" || q.t === ")")) parts.push({ t: ")", v: ")" }); }
  else if (k === "±") { if (p) p.v = p.v.startsWith("-") ? p.v.slice(1) : "-" + p.v; }
  else if (k === "⌫") { if (p && !p.label && p.v.length > 1) p.v = p.v.slice(0, -1); else parts.pop(); }
  else if (k === "C") parts = [];
  else if (k === "=") return equals();
  draw();
}
const fmtRaw = v => String(+v.toPrecision(12));
function unitOf() {
  /* 足し算・引き算だけで、札の単位がそろっていればその単位を付ける。かけ算・割り算が入ったら付けない */
  const u = parts.filter(p => p.t === "num" && p.unit).map(p => p.unit);
  if (!u.length || parts.some(p => p.t === "op" && /[×÷]/.test(p.v))) return "";
  return u.every(x => x === u[0]) ? u[0] : "";
}
function equals() {
  if (!parts.length) return;
  try {
    const v = evaluate(exprText()), unit = unitOf(), lab = labelText();
    const line = `${lab || exprText()} ＝ ${fmt(v)}${unit ? " " + unit : ""}`;
    hist.unshift(line); hist.length = Math.min(hist.length, 3); store.set("dash.calc.hist", JSON.stringify(hist));
    last = { v, unit, label: lab ? `（${lab}）の答え` : "" };
    draw(v, unit);
  } catch (e) { draw(null, "", e.message); }
}
function take(value, label, unit) {
  /* タイルの数字を取り込む：前が数字なら置きかえ、演算の後ならつなげる */
  if (last != null) { parts = []; last = null; }
  const q = parts[parts.length - 1];
  const part = { t: "num", v: fmtRaw(value), label, unit };
  if (q && (q.t === "num")) parts[parts.length - 1] = part; else if (q && q.t === ")") { parts.push({ t: "op", v: "×" }, part); } else parts.push(part);
  open(true); tab("calc"); draw();
}
function draw(res, unit = "", err = "") {
  const d = $("cdisp"); if (!d) return;
  d.querySelector(".lab").textContent = labelText();
  d.querySelector(".exp").textContent = exprText() || " ";
  let r = "";
  if (err) r = `<span style="color:#ff7d7d;font-size:15px">${esc(err)}</span>`;
  else if (res != null) r = `${esc(fmt(res))}${unit ? `<small style="font-size:14px"> ${esc(unit)}</small>` : ""}`;
  else { try { if (parts.length && parts[parts.length - 1].t !== "op") { const v = evaluate(exprText()); r = `<span style="color:var(--ink-faint)">${esc(fmt(v))}</span>`; } } catch (_) {} }
  d.querySelector(".res").innerHTML = r || "&nbsp;";
  $("chist").innerHTML = hist.map(h => `<div title="もう一度使う">${esc(h)}</div>`).join("");
}

/* ---------- 単位の変換 ---------- */
const BEAU = [[0.3, "0 静穏"], [1.6, "1 至軽風"], [3.4, "2 軽風"], [5.5, "3 軟風"], [8.0, "4 和風"], [10.8, "5 疾風"], [13.9, "6 雄風"], [17.2, "7 強風"], [20.8, "8 疾強風"], [24.5, "9 大強風"], [28.5, "10 全強風"], [32.7, "11 暴風"], [Infinity, "12 颶風"]];
const UNITS = {
  wind: { name: "風の速さ", base: "m/s", list: [["m/s", 1], ["km/h", 3.6], ["ノット（船・飛行機）", 1 / 0.514444]],
    extra: v => `風の強さの階級（ビューフォート）：${BEAU.find(b => v < b[0])[1]}（目安）` },
  pres: { name: "気圧", base: "hPa", list: [["hPa", 1], ["mmHg（水銀柱）", 0.750062], ["inHg（飛行機の高度計）", 0.0295300]] },
  temp: { name: "温度", base: "℃", conv: v => [["℃", v], ["℉", v * 9 / 5 + 32], ["K（絶対温度）", v + 273.15]] },
  dist: { name: "距離", base: "km", list: [["km", 1], ["海里（船・飛行機）", 1 / 1.852], ["マイル", 1 / 1.609344]] },
};
function unitsHtml() {
  return `<div class="crow"><select id="cuK">${Object.entries(UNITS).map(([k, u]) => `<option value="${k}">${u.name}</option>`).join("")}</select>
    <input id="cuV" inputmode="decimal" value=""><span id="cuB"></span><button type="button" class="cbtn" id="cuFrom">電卓の答えを使う</button></div>
    <div class="cout" id="cuOut"></div><p class="cnote" id="cuNote"></p>
    <p class="cnote">左の欄に入れた数を、ほかの単位に直します。右の「電卓へ」で、その値を電卓に入れられます。</p>`;
}
function unitsDraw() {
  const k = $("cuK").value, u = UNITS[k], v = parseFloat($("cuV").value);
  $("cuB").textContent = u.base;
  if (!Number.isFinite(v)) { $("cuOut").innerHTML = ""; $("cuNote").textContent = ""; return; }
  const rows = u.conv ? u.conv(v) : u.list.map(([n, f]) => [n, v * f]);
  $("cuOut").innerHTML = rows.map(([n, x], i) => `<span>${esc(n)}</span><span>${esc(fmt(x))} <button type="button" class="cbtn" data-take="${x}" data-label="${esc(`${v}${u.base} を ${n.replace(/（.*）/, "")} に`)}" data-unit="${esc(n.replace(/（.*）/, ""))}">電卓へ</button></span>`).join("");
  $("cuNote").textContent = u.extra ? u.extra(v) : "";
}

/* ---------- 地球の計算 ---------- */
function earthHtml() {
  return `
  <div class="ccard"><h4>📏 2つの場所の距離と方角</h4>
    <div class="crow"><span id="ceFrom"></span> から <input id="ceTo" list="cePlaces" placeholder="地名（例：札幌）" style="width:10em"><datalist id="cePlaces"></datalist></div>
    <div class="cout" id="ceOut"></div>
    <p class="cnote">地球が丸いことを入れた計算（大圏）。方角は出発する時の向き。</p></div>
  <div class="ccard"><h4>💡 光・電波が届くまで</h4>
    <div class="crow"><select id="clK"><option value="384400">月（平均 38万4400km）</option><option value="149597871">太陽（平均 1億4960万km）</option><option value="36000">静止衛星（約3万6000km）</option><option value="">距離を入れる</option></select><input id="clV" inputmode="decimal" placeholder="km" hidden></div>
    <div class="cout" id="clOut"></div><p class="cnote">光の速さ 秒速約30万km。今見ている月は約1.3秒前の月。</p></div>
  <div class="ccard"><h4>⚡ 雷までの距離</h4>
    <div class="crow">光ってから <input id="ctV" inputmode="decimal" value="5" style="width:4em"> 秒で音</div>
    <div class="cout" id="ctOut"></div><p class="cnote">音の速さ 秒速約340m で計算（目安）。もう起きた雷の距離で、これからの動きはわかりません。</p></div>
  <div class="ccard"><h4>🪨 プレートが動いた距離</h4>
    <div class="crow">年に <input id="cpV" inputmode="decimal" value="" style="width:5em"> cm で <input id="cpY" inputmode="decimal" value="1000" style="width:5em"> 年</div>
    <div class="cout" id="cpOut"></div><p class="cnote">今の速さがずっと同じだったら、という仮定の計算（実際は変わる）。速さは地面の下のタイルの値を入れています。</p></div>
  <div class="ccard"><h4>🏔 高さと気圧</h4>
    <div class="crow"><input id="chV" inputmode="decimal" value="100" style="width:5em"> m 高い所へ</div>
    <div class="cout" id="chOut"></div><p class="cnote">地上の近くでは、約8mのぼると気圧が約1hPa下がる（目安。高い所ほど下がり方はゆるくなる）。</p></div>`;
}
const tk = (x, label, unit) => `<button type="button" class="cbtn" data-take="${x}" data-label="${esc(label)}" data-unit="${esc(unit)}">電卓へ</button>`;
function earthDraw() {
  const cur = window.Dash?.cur?.(); const P = window.Dash?.places?.() || [];
  $("ceFrom").textContent = cur ? cur.name : "（場所を選んでください）";
  const dl = $("cePlaces"); if (dl && !dl.childElementCount && P.length) dl.innerHTML = P.filter(p => p.kind === "日本" || p.kind === "首都").map(p => `<option value="${esc(p.ja)}">`).join("");
  const to = $("ceTo").value.trim(), dest = to && P.find(p => p.ja === to || p.ja.replace(/[市都]$/, "") === to || p.kana === to);
  if (cur && dest) { const [a1, o1, a2, o2] = [cur.lat, cur.lon, dest.lat, dest.lon].map(x => x * D2R);
    const h = Math.sin((a2 - a1) / 2) ** 2 + Math.cos(a1) * Math.cos(a2) * Math.sin((o2 - o1) / 2) ** 2, km = 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
    const br = (Math.atan2(Math.sin(o2 - o1) * Math.cos(a2), Math.cos(a1) * Math.sin(a2) - Math.sin(a1) * Math.cos(a2) * Math.cos(o2 - o1)) / D2R + 360) % 360;
    $("ceOut").innerHTML = `<span>距離</span><span>${fmt(km)} km ${tk(km, `${cur.name.replace(/のあたり$/, "")}〜${dest.ja}の距離`, "km")}</span><span>方角</span><span>${DIRS[Math.round(br / 22.5) % 16]}（${br.toFixed(0)}°）</span><span>海里</span><span>${fmt(km / 1.852)} 海里</span>`; }
  else $("ceOut").innerHTML = to ? `<span>見つかりません</span><span>日本の主な地点か、世界の首都の名前で</span>` : "";
  const lk = $("clK").value; $("clV").hidden = !!lk; const lkm = parseFloat(lk || $("clV").value);
  $("clOut").innerHTML = Number.isFinite(lkm) ? (() => { const s = lkm / 299792.458; return `<span>かかる時間</span><span>${s < 60 ? fmt(s) + " 秒" : `${Math.floor(s / 60)}分${Math.round(s % 60)}秒`} ${tk(s, "光が届く秒数", "秒")}</span><span>行って帰る</span><span>${s * 2 < 60 ? fmt(s * 2) + " 秒" : `${Math.floor(s * 2 / 60)}分${Math.round(s * 2 % 60)}秒`}</span>`; })() : "";
  const ts = parseFloat($("ctV").value); $("ctOut").innerHTML = Number.isFinite(ts) ? `<span>雷までの距離</span><span>約 ${fmt(ts * 0.34)} km（目安） ${tk(ts * 0.34, "雷までの距離", "km")}</span>` : "";
  const pv = parseFloat($("cpV").value), py = parseFloat($("cpY").value);
  $("cpOut").innerHTML = Number.isFinite(pv) && Number.isFinite(py) ? (() => { const m = pv * py / 100; return `<span>動いた距離</span><span>${m >= 1000 ? fmt(m / 1000) + " km" : fmt(m) + " m"}（仮定） ${tk(m, `プレートが${py}年で動く距離`, "m")}</span>`; })() : "";
  const hm = parseFloat($("chV").value); $("chOut").innerHTML = Number.isFinite(hm) ? `<span>下がる気圧</span><span>約 ${fmt(hm / 8.3)} hPa（目安） ${tk(hm / 8.3, `${hm}m のぼった時の気圧の差`, "hPa")}</span><span>逆に</span><span>1 hPa ≒ 約8m</span>` : "";
}

/* ---------- 組み立て ---------- */
let built = false;
function build() {
  if (built) return; built = true;
  const pan = document.createElement("aside"); pan.className = "cpan"; pan.id = "cpan"; pan.hidden = true; pan.setAttribute("aria-label", "電卓");
  pan.innerHTML = `
  <div class="ctabs" role="tablist"><button type="button" data-tab="calc" aria-selected="true">🧮 計算</button><button type="button" data-tab="unit" aria-selected="false">🔁 単位</button><button type="button" data-tab="earth" aria-selected="false">🌏 地球の計算</button></div>
  <div data-pane="calc">
    <div class="cdisp" id="cdisp"><div class="lab"></div><div class="exp"></div><div class="res">&nbsp;</div></div>
    <div class="ckeys">${["C", "(", ")", "÷", "7", "8", "9", "×", "4", "5", "6", "−", "1", "2", "3", "+", "±", "0", ".", "="].map(k => `<button type="button" data-k="${k}" class="${/[÷×−+]/.test(k) ? "op" : k === "=" ? "eq" : ""}">${k}</button>`).join("")}</div>
    <div class="crow" style="justify-content:flex-end"><button type="button" class="cbtn" data-k="⌫">⌫ 1文字消す</button></div>
    <p class="cnote">タイルの<span class="takeable">点線の数字</span>を押すと、「どこの・何の値か」の札ごと入ります。最近の計算（この端末の中だけ・3行まで）：</p>
    <div class="chist" id="chist"></div>
    <p class="cnote">天気を先へ延ばす計算（いつ着く、など）は入れていません。</p></div>
  <div data-pane="unit" hidden>${unitsHtml()}</div>
  <div data-pane="earth" hidden>${earthHtml()}</div>`;
  document.body.appendChild(pan);
  const fab = document.createElement("button"); fab.type = "button"; fab.className = "cfab"; fab.id = "cfab"; fab.textContent = "🧮"; fab.setAttribute("aria-label", "電卓"); fab.setAttribute("aria-expanded", "false");
  document.body.appendChild(fab);
  fab.onclick = () => open(pan.hidden);
  pan.addEventListener("click", e => {
    const k = e.target.closest("[data-k]"); if (k) return press(k.dataset.k);
    const t = e.target.closest("[data-tab]"); if (t) return tab(t.dataset.tab);
    const g = e.target.closest("[data-take]"); if (g) return take(+g.dataset.take, g.dataset.label, g.dataset.unit);
    const h = e.target.closest(".chist div"); if (h) { const m = h.textContent.match(/＝\s*([-\d,.]+)\s*(.*)$/); if (m) take(parseFloat(m[1].replace(/,/g, "")), "前の答え", m[2].trim()); }
  });
  ["cuK", "cuV"].forEach(id => $(id).addEventListener("input", unitsDraw));
  $("cuFrom").onclick = () => { if (last) { $("cuV").value = fmtRaw(last.v); unitsDraw(); } };
  ["ceTo", "clK", "clV", "ctV", "cpV", "cpY", "chV"].forEach(id => $(id).addEventListener("input", earthDraw));
  addEventListener("keydown", e => { if (pan.hidden || /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || "")) return;
    const map = { "*": "×", "/": "÷", "-": "−", "Enter": "=", "Backspace": "⌫", "Escape": "C" }; const k = map[e.key] || e.key;
    if (/^[0-9.+()=]$/.test(k) || ["×", "÷", "−", "⌫", "C"].includes(k)) { e.preventDefault(); press(k); } });
  draw();
}
function open(on) {
  build(); const pan = $("cpan"); pan.hidden = !on; $("cfab").setAttribute("aria-expanded", String(on)); document.body.classList.toggle("calc-open", on);
  if (on) { unitsDraw(); earthDraw(); }
}
function tab(name) {
  document.querySelectorAll("#cpan [data-tab]").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  document.querySelectorAll("#cpan [data-pane]").forEach(p => { p.hidden = p.dataset.pane !== name; });
  if (name === "unit") unitsDraw(); if (name === "earth") earthDraw();
}

/* ---------- タイルの数字に点線をつける（描き直すたび） ---------- */
function mark() {
  const cur = window.Dash?.cur?.(); const place = cur ? cur.name.replace(/のあたり$|から約.*$/, "") : "";
  document.querySelectorAll("#grid .tile .big").forEach(b => {
    if (b.closest(".place")) return;
    const m = b.firstChild?.textContent?.match(/[+−-]?[\d,]+(?:\.\d+)?/); if (!m) return;
    const v = parseFloat(m[0].replace(/,/g, "").replace("−", "-")); if (!Number.isFinite(v)) return;
    const unit = b.querySelector("small")?.textContent || "", head = (b.closest(".tile").querySelector(".th")?.textContent || "").replace(/^[^\p{L}\p{N}]+/u, "").replace(/（.*）/, "").trim();
    b.classList.add("takeable"); b.title = "押すと電卓に入ります";
    b.onclick = () => take(v, `${place}・${head} ${fmt(v)}${unit}`, unit);
    if (head.startsWith("地面の下") && unit === "cm/年") { const pv = $("cpV"); if (pv && !pv.value) pv.value = v; }
  });
}
addEventListener("dash:render", () => { build(); mark(); if (!$("cpan").hidden) earthDraw(); });
build();
})();
