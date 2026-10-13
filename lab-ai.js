/* ===== 実験室 05：ローカルAI（試し）=====
   ・押した人だけ、モデルを Hugging Face から読み込む（実験室の中だけの例外。2026-10-13 まことが決定。本番にするなら置き場を考え直す）
   ・AIに渡すのは ② の「事実だけのリスト」だけ。AIの文は ③ の見張りと「数字の照合」を通ってから出す
   ・扱うのは過去だけ。この先の天気・助言は書かせない／出さない
   ・このファイルを外せば、実験室は元の（AIなしの）形に戻る */
(() => {
"use strict";
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
/* 版を固定する。0.2.80 から設定ファイル名が tensor-cache.json に変わり、
   TinySwallow の置き場には古い名前（ndarray-cache.json）しかないので、日本製の席は 0.2.79 を使う（2026-10-13 iPad Safari で確認） */
const LIBS = { light: "https://esm.run/@mlc-ai/web-llm@0.2.86", jp: "https://esm.run/@mlc-ai/web-llm@0.2.79" };
const libs = {};
/* 2つの席：軽い（海外製・iPhone向き）／少し上（日本製・iPad向き） */
const SEATS = {
  light: { label: "軽い：Qwen2.5 0.5B（Alibaba・中国）", size: "約0.4GB", f16: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC", f32: "Qwen2.5-0.5B-Instruct-q4f32_1-MLC" },
  jp: { label: "少し上：TinySwallow 1.5B（Sakana AI・日本）", size: "約1.2GB", custom: true,
    repo: "https://huggingface.co/asai95/TinySwallow-1.5B-Instruct-q4f32_1-MLC", id: "TinySwallow-1.5B-Instruct-q4f32_1-MLC", libFrom: "Qwen2.5-1.5B-Instruct-q4f32_1-MLC" },
};
const SYS = [
  "あなたは天気の記録を一緒に振り返る係です。",
  "使ってよいのは、あとで渡す「事実」の文だけです。事実にない数字や出来事を作ってはいけません。",
  "書くのは過去のことだけです。この先の天気、予想、助言（傘・外出・避難など）は書きません。",
  "日本語で、やさしい言葉で、3文以内。最後に、読んだ人が自分で考えたくなる問いを1つだけ添えてください。",
].join("\n");
let webllm = null, engine = null, curId = null;
const stats = (() => { try { return JSON.parse(localStorage.getItem("lab.ai.stats") || "{}"); } catch (_) { return {}; } })();
const saveStats = () => { try { localStorage.setItem("lab.ai.stats", JSON.stringify(stats)); } catch (_) {} };
const log = msg => { const el = $("aiLog"); if (el) el.textContent = msg; };

async function hasF16() { try { const ad = await navigator.gpu?.requestAdapter(); return !!ad?.features?.has?.("shader-f16"); } catch (_) { return false; } }
function isPhone() { return /iPhone|Android.+Mobile/.test(navigator.userAgent); }

async function modelFor(key) {
  const s = SEATS[key];
  if (!s.custom) return { id: (await hasF16()) ? s.f16 : s.f32, appConfig: undefined };
  const base = webllm.prebuiltAppConfig, lib = base.model_list.find(m => m.model_id === s.libFrom)?.model_lib;
  if (!lib) throw new Error("この版の WebLLM に、TinySwallow を動かす部品（Qwen2.5 1.5B 用）が見つかりませんでした");
  return { id: s.id, appConfig: { ...base, model_list: [...base.model_list, { model: s.repo, model_id: s.id, model_lib: lib }] } };
}
async function load(key, auto = false) {
  if (!("gpu" in navigator)) { log("この端末のブラウザには WebGPU がないので、AIは動かせません（実験室の他の部分はそのまま使えます）"); return; }
  const s = SEATS[key];
  if (!auto && key === "jp" && isPhone() && !confirm(`${s.label}は${s.size}あります。iPhone だとページが落ちることがあります（記録や設定は消えません）。読み込みますか？`)) return;
  if (!auto && key === "light" && !confirm(`${s.label}（${s.size}）を Hugging Face から読み込みます。通信量に気をつけてください。読み込みますか？`)) return;
  setBusy(true); lastModel = null; const t0 = performance.now();
  try {
    webllm = libs[key] ||= await import(LIBS[key]);
    const m = await modelFor(key); lastModel = m;
    if (useIDB()) m.appConfig = { ...(m.appConfig || webllm.prebuiltAppConfig), cacheBackend: "indexeddb", useIndexedDBCache: true };
    if (engine) { try { await engine.unload(); } catch (_) {} engine = null; }
    log("読み込みを始めます…");
    engine = await webllm.CreateMLCEngine(m.id, { appConfig: m.appConfig, initProgressCallback: p => { log(`読み込み中：${Math.round((p.progress || 0) * 100)}%　${p.text || ""}`); const b = $("aiBar"); if (b) b.style.width = `${Math.round((p.progress || 0) * 100)}%`; } });
    curId = m.id; try { localStorage.setItem("lab.ai.seat", key); } catch (_) {} const sec = (performance.now() - t0) / 1000;
    (stats[m.id] ||= { loads: 0, runs: 0, passed: 0, blocked: 0 }).loads++; stats[m.id].loadSec = sec; saveStats();
    log(`読み込み完了：${m.id}（${sec.toFixed(0)} 秒）。「AIに並べてもらう」か、06番の「AIに頼む」を押してください。`);
  } catch (e) { log(`読み込めませんでした（${SEATS[key].label}）：` + (e?.message || e) + "　→ どこで止まったか調べています…"); await probe(m0(), `（${SEATS[key].label}）` + String(e?.message || e)); }
  finally { setBusy(false); showStats(); }
}
/* 失敗したとき：どの置き場が断ったかを1回ずつだけ確かめる（何度も叩かない） */
let lastModel = null; const m0 = () => lastModel;
async function probe(m, msg) {
  if (!m) return;
  const base = (m.appConfig || webllm.prebuiltAppConfig).model_list.find(x => x.model_id === m.id);
  if (!base) { log(`読み込めませんでした：${msg}（席の情報が見つからない）`); return; }
  const url = base.model.replace(/\/?$/, "/") + (/\/resolve\//.test(base.model) ? "" : "resolve/main/");
  const tries = [["モデルの設定（Hugging Face）", url + "mlc-chat-config.json"], ["動かす部品（GitHub）", base.model_lib]];
  const out = [];
  for (const [name, u] of tries) {
    try { const r = await fetch(u, { method: "HEAD", cache: "no-store" }); out.push(`${name}：${r.ok ? "届く" : "断られた " + r.status}`); }
    catch (e) { out.push(`${name}：届かない（${e?.message || e}）`); }
  }
  log(`読み込めませんでした：${msg}\n調べた結果 → ${out.join("／")}\n保存のしかた：${useIDB() ? "IndexedDB" : "Cache"}`);
}
const useIDB = () => !!$("aiIDB")?.checked;
function setBusy(b) { for (const id of ["aiLight", "aiJp"]) { const el = $(id); if (el) el.disabled = b; } for (const id of ["aiRun", "aiFree", "aiDel", "wAi", "wTestAi"]) { const el = $(id); if (el) el.disabled = b || !engine; } }

/* 数字の照合：AIの文に出てくる数字が、渡した事実の中にあるか */
function numbersOk(out, facts) {
  const nums = (out.match(/[0-9０-９]+(?:[.．][0-9０-９]+)?/g) || []).map(n => n.replace(/[０-９．]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)));
  const src = facts.join(" ").replace(/[０-９．]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  const bad = nums.filter(n => !src.includes(n));
  return { ok: !bad.length, bad };
}
async function run() {
  if (!engine || !window.LAB) return;
  const facts = window.LAB.facts();
  if (!facts.length || facts.length < 2) { log("事実がまだ少なすぎます（記録がたまるのを待ってください）"); return; }
  setBusy(true); $("aiOut").innerHTML = '<p class="note">書いています…</p>'; const t0 = performance.now();
  try {
    const r = await engine.chat.completions.create({ messages: [{ role: "system", content: SYS }, { role: "user", content: "事実：\n" + facts.map(f => "・" + f).join("\n") + "\n\nこの事実だけを使って、ふりかえりを書いてください。" }], temperature: 0.3, max_tokens: 220 });
    const text = (r.choices?.[0]?.message?.content || "").trim(), sec = (performance.now() - t0) / 1000;
    const toks = r.usage?.completion_tokens || 0, g = window.LAB.guard(text), n = numbersOk(text, facts), st = stats[curId] ||= { loads: 0, runs: 0, passed: 0, blocked: 0 };
    st.runs++; st.lastSec = sec; st.tps = toks / sec;
    let html;
    if (g.ok && n.ok) { st.passed++;
      html = `<p class="aiText">${esc(text)}</p><p class="verdict"><b class="ok">見張りを通過</b>：未来の言葉なし・数字はすべて事実の中にありました。</p>`; }
    else { st.blocked++;
      const why = [g.ok ? "" : `未来・助言の言葉（${g.hits.map(esc).join("・")}）`, n.ok ? "" : `事実にない数字（${n.bad.map(esc).join("・")}）`].filter(Boolean).join("と");
      html = `<p class="verdict"><b class="ng">見張りで止めました</b>：${why}が入っていたので、ふつうは表示しません。</p><details><summary>止めた文を見る（実験のため）</summary><p class="aiText" style="opacity:.75">${esc(text)}</p></details>`; }
    saveStats();
    $("aiOut").innerHTML = html + `<p class="note">${sec.toFixed(1)} 秒・約 ${toks} トークン（1秒に約 ${(toks / sec).toFixed(1)}）・${esc(curId)}</p>`;
    log("");
  } catch (e) { $("aiOut").innerHTML = ""; log("書けませんでした：" + (e?.message || e)); }
  finally { setBusy(false); showStats(); }
}
async function del() {
  if (!curId || !webllm) return; if (!confirm("読み込んだモデルを、この端末から消しますか？（また使う時は読み込み直しになります）")) return;
  try { if (engine) await engine.unload(); engine = null; const m = lastModel || await modelFor(Object.keys(SEATS).find(k => (SEATS[k].id || "") === curId) || "light");
    await webllm.deleteModelAllInfoInCache(curId, m.appConfig); log("消しました。端末の容量が戻ります。"); curId = null; setBusy(false); }
  catch (e) { log("消せませんでした：" + (e?.message || e)); }
}
function showStats() {
  const el = $("aiStats"); if (!el) return; const rows = Object.entries(stats).filter(([k]) => k !== "waiter");
  el.innerHTML = rows.length ? rows.map(([id, s]) => `<span>${esc(id)}</span><span>読み込み ${s.loads}回（最後 ${Math.round(s.loadSec || 0)}秒）・書かせた ${s.runs}回・通過 ${s.passed}・止めた ${s.blocked}${s.tps ? `・1秒に約${s.tps.toFixed(1)}トークン` : ""}</span>`).join("") : "<span>まだ記録はありません</span><span></span>";
}


/* ===== 05 項目別ならべ：行を作るのはコード。AIは「聞かれたこと」を読んで、出す順番と最後の問いを選ぶだけ ===== */
const ITEMS = ["気圧", "風", "雨"];
const QS = [
  { id: "q1", item: "気圧", text: "気圧がいちばん低かった時、地球儀の雲はどんな形をしていた？" },
  { id: "q2", item: "気圧", text: "気圧がいちばん大きく動いた6時間の前と後で、風の向きは変わっていた？" },
  { id: "q3", item: "風", text: "風がいちばん強かった時、気圧は高かった？低かった？" },
  { id: "q4", item: "風", text: "風の向きが変わった時、何かが近くを通りすぎていた？" },
  { id: "q5", item: "雨", text: "雨が出ていた回は、気圧が低い時と重なっていた？" },
  { id: "q6", item: "", text: "この期間で、いちばん気になった数字はどれ？" },
];
const T = t => window.LAB.F.format(t);
const kmh = v => Math.round(v * 3.6);
function itemLines(rows) {
  const L = window.LAB, out = {}, P = rows.filter(r => r.p != null), W = rows.filter(r => r.spd != null);
  if (P.length) { const lo = P.reduce((a, b) => b.p < a.p ? b : a), hi = P.reduce((a, b) => b.p > a.p ? b : a), d = hi.p - lo.p;
    const ln = [`低い ${lo.p.toFixed(1)} hPa（${T(lo.t)}）／高い ${hi.p.toFixed(1)} hPa（${T(hi.t)}）`, `差 ${d.toFixed(1)} hPa（ものさし：高さ約${Math.round(d * 8.3)}mぶんの気圧の差。エレベーターで約${Math.max(1, Math.round(d * 8.3 / 3))}階ぶん）`];
    let best = null; for (let i = 1; i < P.length; i++) { const h = (P[i].t - P[i - 1].t) / 3600000; if (h > 0 && h <= 6.5) { const x = P[i].p - P[i - 1].p; if (!best || Math.abs(x) > Math.abs(best.x)) best = { x, a: P[i - 1], b: P[i] }; } }
    if (best && Math.abs(best.x) >= 1) ln.push(`いちばん大きく${best.x < 0 ? "下がった" : "上がった"}6時間：${best.x >= 0 ? "+" : ""}${best.x.toFixed(1)} hPa（${T(best.a.t)}〜${T(best.b.t)}）`);
    out["気圧"] = ln; }
  if (W.length) { const mx = W.reduce((a, b) => b.spd > a.spd ? b : a), ln = [`いちばん強い：${L.DIRS[Math.round(mx.from / 22.5) % 16]}の風 ${mx.spd.toFixed(1)} m/s（${T(mx.t)}）＝ 時速約${kmh(mx.spd)}km`];
    let turn = null; for (let i = 1; i < W.length; i++) { let d = Math.abs(W[i].from - W[i - 1].from); d = Math.min(d, 360 - d); if (W[i].spd > 2 && W[i - 1].spd > 2 && (!turn || d > turn.d)) turn = { d, a: W[i - 1], b: W[i] }; }
    if (turn && turn.d >= 60) ln.push(`向きが大きく変わった：${L.DIRS[Math.round(turn.a.from / 22.5) % 16]} → ${L.DIRS[Math.round(turn.b.from / 22.5) % 16]}（${T(turn.a.t)}〜${T(turn.b.t)}）`);
    out["風"] = ln; }
  const Rr = rows.filter(r => r.rain != null), wet = Rr.filter(r => r.rain >= 0.1);
  if (Rr.length) out["雨"] = wet.length ? [`雨が出ていた記録：${Rr.length}回中${wet.length}回（6時間ごとの記録。ずっと降っていたとは限らない）`, `いちばん強かった：${T(wet.reduce((a, b) => b.rain > a.rain ? b : a).t)}（${L.rainWord(wet.reduce((a, b) => b.rain > a.rain ? b : a).rain)}）`] : [`雨が出ていた記録：${Rr.length}回中0回`];
  return out;
}
function ruleArrange(ask) {
  const order = []; const add = k => { if (!order.includes(k)) order.push(k); };
  if (/荒れ|しけ|嵐|台風/.test(ask)) { add("風"); add("雨"); }
  if (/気圧|hPa|頭痛/.test(ask)) add("気圧");
  if (/風/.test(ask)) add("風");
  if (/雨|降/.test(ask)) add("雨");
  if (!order.length) ITEMS.forEach(add);
  const q = QS.find(x => x.item === order[0]) || QS[QS.length - 1];
  return { order, q: q.id };
}
const ARR_SCHEMA = { type: "object", properties: { order: { type: "array", items: { type: "string", enum: ITEMS } }, q: { type: "string", enum: QS.map(x => x.id) } }, required: ["order", "q"] };
async function aiArrange(ask) {
  const sys = ["あなたは並べ係です。お客さんの「聞きたいこと」を読んで、見せる項目の順番と、最後に添える問いを選ぶだけが仕事です。文章は書きません。JSONだけを返します。",
    `order：${ITEMS.join("・")} から、聞きたいことに近い順に並べる（関係ないものは入れなくてよい）`,
    "q：次の問いから1つ選んで id を書く", ...QS.map(x => `${x.id}：${x.text}`),
    '例：「昨日荒れてた？」→ {"order":["風","雨"],"q":"q3"}'].join("\n");
  const msgs = [{ role: "system", content: sys }, { role: "user", content: ask }];
  let r; try { r = await engine.chat.completions.create({ messages: msgs, temperature: 0, max_tokens: 60, response_format: { type: "json_object", schema: JSON.stringify(ARR_SCHEMA) } }); }
  catch (_) { r = await engine.chat.completions.create({ messages: msgs, temperature: 0, max_tokens: 60 }); }
  const raw = (r.choices?.[0]?.message?.content || "").trim(), m = raw.match(/\{[\s\S]*\}/); let o = null; try { o = JSON.parse(m ? m[0] : raw); } catch (_) {}
  if (!o) return { bad: true, raw };
  const order = [...new Set((Array.isArray(o.order) ? o.order : []).filter(k => ITEMS.includes(k)))];
  return { order, q: QS.some(x => x.id === o.q) ? o.q : null, raw };
}
function showArranged(a, who, sec) {
  const rows = window.LAB.rowsNow(), lines = itemLines(rows), out = $("aiOut");
  if (rows.length < 2) { out.innerHTML = '<p class="note">記録がまだ少なすぎます（2回分以上たまると並べられます）。</p>'; return; }
  if (a.bad) { out.innerHTML = `<p class="verdict"><b class="ng">並べ方が読めませんでした</b>（${esc(who)}）。</p><details><summary>AIが書いたもの</summary><pre class="note">${esc(a.raw)}</pre></details>`; return; }
  const rest = ITEMS.filter(k => !a.order.includes(k) && lines[k]), q = QS.find(x => x.id === a.q);
  const block = (k, dim) => lines[k] ? `<div style="margin:8px 0;${dim ? "opacity:.5" : ""}"><b style="display:inline-block;min-width:3.2em;color:var(--lab)">【${k}】</b>${lines[k].map((l, i) => `<div style="padding-left:3.4em;${i ? "font-size:13.5px;color:var(--ink-soft)" : ""}">${esc(l)}</div>`).join("")}</div>` : "";
  out.innerHTML = `<div style="margin:6px 0">${chip("並べた人", who + (sec != null ? `・${sec.toFixed(1)}秒` : ""))}${chip("順番", a.order.join(" → ") || "（なし）")}${chip("問い", a.q || "なし")}</div>`
    + `<div class="aiText" style="font-size:14.5px">📅 ${esc(T(rows[0].t))}〜${esc(T(rows[rows.length - 1].t))}（${rows.length}回分）`
    + a.order.map(k => block(k, false)).join("") + (rest.length ? `<div class="note" style="margin-top:6px">聞かれていない項目</div>` + rest.map(k => block(k, true)).join("") : "")
    + (q ? `<div style="margin-top:10px">❓ ${esc(q.text)}</div>` : "") + `</div>`
    + `<p class="note">行の文と数字はコードが作りました（AIは順番と問いを選んだだけ）。</p>`;
}
async function arrange(useAi) {
  const ask = ($("aiAsk")?.value || "").trim() || "この期間、どうだった？";
  if (!useAi) return showArranged(ruleArrange(ask), "AIなし");
  if (!engine) return;
  setBusy(true); $("aiOut").innerHTML = '<p class="note">AIが並べ方を選んでいます…</p>'; const t0 = performance.now();
  try { const a = await aiArrange(ask), st = stats[curId] ||= { loads: 0, runs: 0, passed: 0, blocked: 0 }; st.arranged = (st.arranged || 0) + 1; saveStats(); showArranged(a, "AI（" + curId.split("-").slice(0, 2).join(" ") + "）", (performance.now() - t0) / 1000); }
  catch (e) { $("aiOut").innerHTML = ""; log("並べられませんでした：" + (e?.message || e)); }
  finally { setBusy(false); }
}

/* ===== 06 データのウエイター =====
   AIの仕事は「注文を聞いて伝票に書く」だけ。料理（値・表・グラフ）を運ぶのはコード。
   伝票はそのまま見せるので、まちがえたら「ちがう料理が来た」と分かる。日付の計算・未来の断り・場所さがしはコード */
const WHAT = ["気圧", "風", "雨"], OFF = "メニューにない", OFFRE = /気温|温度|最高|最低|暑|寒|湿度|雪|雷|霧|紫外線|花粉/, DAYS = ["今日", "昨日", "おととい", "3日前", "4日前", "5日前", "6日前", "1週間前", "日付", "最近", "未来"], PARTS = ["一日", "深夜", "朝", "昼", "夕方", "夜"];
const ORDER_SCHEMA = { type: "object", properties: {
  what: { type: "array", items: { type: "string", enum: [...WHAT, OFF] } }, day: { type: "string", enum: DAYS },
  date: { type: "string" }, part: { type: "string", enum: PARTS }, where: { type: "string" } }, required: ["what", "day", "part", "where"] };
const WSYS = [
  "あなたはデータのウエイターです。お客さんの言葉を、注文の伝票（JSON）に書き直すだけが仕事です。答えや説明は書きません。",
  `what：${WHAT.join("・")} から選ぶ（言われていなければ3つ全部）。気温・湿度・雪など、この3つにないものを頼まれたら「${OFF}」を入れる（似たものに置きかえない）`,
  `day：${DAYS.join("・")} から選ぶ。「10月11日」「10/11」のように日付で言われたら「日付」にして date に「10/11」の形で書く。明日・来週などこの先のことは「未来」。言われていなければ「最近」`,
  `part：${PARTS.join("・")} から選ぶ（言われていなければ「一日」）`,
  "where：言われた地名をそのまま書く。言われていなければ空の文字",
  '例：「おとといの夜の京都の気圧」→ {"what":["気圧"],"day":"おととい","date":"","part":"夜","where":"京都"}',
  '例：「10月11日の札幌の風と雨」→ {"what":["風","雨"],"day":"日付","date":"10/11","part":"一日","where":"札幌"}',
].join("\n");
let PLACES = null;
async function places() {
  if (PLACES) return PLACES;
  try { const j = await (await fetch("data/map/places_jp.json")).json(); PLACES = j.rows.map(([ja, kana, lat, lon]) => ({ name: ja, keys: [ja, ja.replace(/[市都]$|（.*）/g, ""), kana].filter(Boolean), lat, lon })); }
  catch (_) { PLACES = []; }
  return PLACES;
}
function findPlace(text, P) {
  if (!text) return null; let best = null;
  for (const p of P) for (const k of p.keys) if (k.length >= 2 && text.includes(k) && (!best || k.length > best.k.length)) best = { p, k };
  return best?.p || null;
}
/* AIなしの伝票係：言葉を拾うだけ（比べるための相手） */
function ruleOrder(text, P) {
  const what = WHAT.filter(w => ({ 気圧: /気圧|hPa|ヘクトパスカル/, 風: /風/, 雨: /雨|降/ })[w].test(text));
  let day = "最近", date = "", m;
  if ((window.LAB?.FUTURE || []).some(w => text.includes(w))) day = "未来";
  else if ((m = text.match(/(\d{1,2})\s*[\/月]\s*(\d{1,2})/))) { day = "日付"; date = `${+m[1]}/${+m[2]}`; }
  else if (/おととい|一昨日/.test(text)) day = "おととい";
  else if (/昨日|きのう/.test(text)) day = "昨日";
  else if (/今日|きょう/.test(text)) day = "今日";
  else if (/先週|1週間前|一週間前/.test(text)) day = "1週間前";
  else if ((m = text.match(/([3-6三四五六])日前/))) day = `${{ 三: 3, 四: 4, 五: 5, 六: 6 }[m[1]] || m[1]}日前`;
  const part = /深夜|夜中|未明/.test(text) ? "深夜" : /夕方/.test(text) ? "夕方" : /夜|晩/.test(text) ? "夜" : /朝|午前/.test(text) ? "朝" : /昼|日中|午後/.test(text) ? "昼" : "一日";
  const pl = findPlace(text, P);
  const off = OFFRE.test(text);
  return { what: what.length ? (off ? [...what, OFF] : what) : off ? [OFF] : WHAT.slice(), day, date, part, where: pl ? pl.keys[1] || pl.name : "" };
}
async function aiOrder(text) {
  const msgs = [{ role: "system", content: WSYS }, { role: "user", content: text }];
  let r, raw = "";
  try { r = await engine.chat.completions.create({ messages: msgs, temperature: 0, max_tokens: 120, response_format: { type: "json_object", schema: JSON.stringify(ORDER_SCHEMA) } }); }
  catch (_) { r = await engine.chat.completions.create({ messages: msgs, temperature: 0, max_tokens: 120 }); }   /* 枠つきが使えない版のとき */
  raw = (r.choices?.[0]?.message?.content || "").trim();
  const j = raw.match(/\{[\s\S]*\}/); let o = null;
  try { o = JSON.parse(j ? j[0] : raw); } catch (_) {}
  if (!o) return { bad: true, raw };
  /* コードの点検：メニューにない品は落とす */
  const what = (Array.isArray(o.what) ? o.what : []).filter(w => WHAT.includes(w) || w === OFF);
  return { what: what.length ? what : WHAT.slice(), day: DAYS.includes(o.day) ? o.day : "最近", date: String(o.date || ""), part: PARTS.includes(o.part) ? o.part : "一日", where: String(o.where || ""), raw };
}
/* 伝票 → 時間の範囲（日本時間）。計算はコード */
const HOURS = { 一日: [0, 24], 深夜: [0, 5], 朝: [5, 11], 昼: [11, 17], 夕方: [15, 20], 夜: [18, 24] };
function range(o) {
  const now = new Date(), jst = new Date(now.getTime() + 9 * 3600000), y = jst.getUTCFullYear();
  const midnight = (yy, mm, dd) => Date.UTC(yy, mm, dd) - 9 * 3600000;
  if (o.day === "最近") return { t0: now - 3 * 86400000, t1: +now, label: "この3日" };
  let d0;
  if (o.day === "日付") { const m = o.date.match(/(\d{1,2})\D+(\d{1,2})/); if (!m) return null; d0 = midnight(y, +m[1] - 1, +m[2]); if (d0 > now) d0 = midnight(y - 1, +m[1] - 1, +m[2]); }
  else { const back = { 今日: 0, 昨日: 1, おととい: 2, "3日前": 3, "4日前": 4, "5日前": 5, "6日前": 6, "1週間前": 7 }[o.day]; if (back == null) return null; d0 = midnight(y, jst.getUTCMonth(), jst.getUTCDate() - back); }
  const [h0, h1] = HOURS[o.part] || HOURS.一日;
  return { t0: d0 + h0 * 3600000, t1: d0 + h1 * 3600000, label: `${new Date(d0 + 9 * 3600000).getUTCMonth() + 1}/${new Date(d0 + 9 * 3600000).getUTCDate()} ${o.part}` };
}
const chip = (k, v) => `<span style="display:inline-block;border:1px solid var(--tile-edge);border-radius:8px;padding:3px 9px;margin:2px 4px 2px 0;font-size:14px"><span style="color:var(--ink-faint);font-size:12px">${k}</span> ${esc(v)}</span>`;
async function serve(o, who, sec, text = "") {
  const L = window.LAB, P = await places(), out = $("wOut");
  if (o.bad) { out.innerHTML = `<p class="verdict"><b class="ng">伝票が読めませんでした</b>（${who}）。もう一度、言い方を変えて頼んでみてください。</p><details><summary>AIが書いたもの</summary><pre class="note">${esc(o.raw)}</pre></details>`; return; }
  const pl = o.where ? findPlace(o.where, P) : null, place = pl ? { name: pl.name, lat: pl.lat, lon: pl.lon } : L.place();
  let ticket = `<div style="margin:6px 0">${chip("書いた人", who + (sec != null ? `・${sec.toFixed(1)}秒` : ""))}${chip("何", o.what.join("・"))}${chip("いつ", o.day === "日付" ? o.date : o.day)}${chip("時間帯", o.part)}${chip("どこ", place.name + (o.where && !pl ? `（「${o.where}」は見つからず）` : ""))}</div>`;
  /* コードの点検：メニューにない品（気温など）を頼まれていたら、AIの伝票に関係なく止める。言葉で書かれた品だけ運ぶ */
  const offWord = ["気温", "温度", "湿度", "雪", "雷", "霧", "紫外線", "花粉"].find(w => text.includes(w)) || (OFFRE.test(text) ? "気温" : ""), said = WHAT.filter(w => ({ 気圧: /気圧|hPa/, 風: /風|しけ/, 雨: /雨|降|しけ/ })[w].test(text));
  if (offWord || o.what.includes(OFF)) {
    const swapped = offWord && !o.what.includes(OFF);
    const note = `<p class="verdict"><b class="mid">「${esc(offWord || "その品")}」はメニューにありません</b>。記録庫にためているのは気圧・風・雨だけです。${swapped ? `<br><b class="ng">AIは伝票を「${esc(o.what.join("・"))}」に置きかえていました</b>。コードが気づいて止めました。` : ""}</p>`;
    if (!said.length) { out.innerHTML = ticket + note; return; }
    o = { ...o, what: said }; ticket += note;
  }
  if (o.day === "未来") { out.innerHTML = ticket + `<p class="verdict"><b class="mid">この先のことはメニューにありません</b>。ここは過去の記録だけを運びます。この先の天気は <a href="https://www.jma.go.jp/bosai/forecast/" target="_blank" rel="noopener">気象庁の天気予報</a> へ。</p>`; return; }
  const rg = range(o); if (!rg) { out.innerHTML = ticket + `<p class="verdict"><b class="ng">日付が読めませんでした</b>。</p>`; return; }
  out.innerHTML = ticket + '<p class="note">記録庫から運んでいます…</p>';
  const rows = await L.rows(place, rg.t0, rg.t1), ix = L.index();
  if (!rows.length) { const first = ix?.sets?.[0]; out.innerHTML = ticket + `<p class="verdict"><b class="mid">その時間の記録はありません</b>（${esc(rg.label)}）。${first ? `記録庫は ${L.F.format(new Date(first.validTime))} からです。` : ""}記録は6時間ごと（日本時間の0・6・12・18時ごろ）なので、時間帯がせまいと入らないことがあります。</p>`; return; }
  const cols = [], C = o.what;
  if (C.includes("気圧")) cols.push(["気圧 hPa", r => r.p == null ? "—" : r.p.toFixed(1)]);
  if (C.includes("風")) cols.push(["風 m/s", r => r.spd == null ? "—" : L.DIRS[Math.round(r.from / 22.5) % 16] + " " + r.spd.toFixed(1)]);
  if (C.includes("雨")) cols.push(["雨", r => L.rainWord(r.rain)]);
  const charts = (C.includes("気圧") ? L.chart(rows, "p", "気圧", "hPa", "#8fe3d4", 1) : "") + (C.includes("風") ? L.chart(rows, "spd", "風の速さ", "m/s", "#c9a7ff", 1) : "") + (C.includes("雨") ? L.chart(rows, "rain", "雨の強さ", "mm/時", "#7fb4ff", 1) : "");
  out.innerHTML = ticket + `<p class="verdict"><b class="ok">お持ちしました</b>：${esc(place.name)}・${esc(rg.label)}・${rows.length} 回分（運んだのはコード。値は記録庫そのまま）</p>`
    + `<div class="tblbox"><table class="tbl"><tr><th>時刻（日本時間）</th>${cols.map(c => `<th>${c[0]}</th>`).join("")}</tr>${rows.map(r => `<tr><td>${L.F.format(r.t)}</td>${cols.map(c => `<td>${c[1](r)}</td>`).join("")}</tr>`).join("")}</table></div>` + charts;
}
async function wGo(useAi) {
  const text = $("wIn").value.trim(); if (!text) return;
  const P = await places();
  if (!useAi) return serve(ruleOrder(text, P), "AIなし", null, text);
  if (!engine) return;
  setBusy(true); $("wOut").innerHTML = '<p class="note">AIが伝票を書いています…</p>'; const t0 = performance.now();
  try { const o = await aiOrder(text); await serve(o, "AI（" + curId.split("-").slice(0, 2).join(" ") + "）", (performance.now() - t0) / 1000, text); }
  catch (e) { $("wOut").innerHTML = `<p class="verdict"><b class="ng">止まりました</b>：${esc(e?.message || e)}</p>`; }
  finally { setBusy(false); }
}
/* 試しの言い方（正解の伝票つき）。AIなし と AI で、合っていた数を数える */
const TESTS = [
  ["おとといの夜の京都の気圧", { what: ["気圧"], day: "おととい", part: "夜", where: "京都" }],
  ["昨日の札幌の風", { what: ["風"], day: "昨日", part: "一日", where: "札幌" }],
  ["今日の朝、雨降ってた？", { what: ["雨"], day: "今日", part: "朝", where: "" }],
  ["10月11日の那覇の風と雨", { what: ["風", "雨"], day: "日付", date: "10/11", part: "一日", where: "那覇" }],
  ["明日の京都の天気", { day: "未来" }],
  ["最近の気圧を見せて", { what: ["気圧"], day: "最近", part: "一日", where: "" }],
  ["きのうの夕方って風強かった？", { what: ["風"], day: "昨日", part: "夕方", where: "" }],
  ["3日前の大阪", { what: WHAT, day: "3日前", part: "一日", where: "大阪" }],
  ["10/9 の東京の気圧と風", { what: ["気圧", "風"], day: "日付", date: "10/9", part: "一日", where: "東京" }],
  ["来週の福岡の雨", { day: "未来" }],
  ["一昨日の深夜の舞鶴の風", { what: ["風"], day: "おととい", part: "深夜", where: "舞鶴" }],
  ["昨日の昼の名古屋の雨と気圧", { what: ["気圧", "雨"], day: "昨日", part: "昼", where: "名古屋" }],
  ["今日の仙台", { what: WHAT, day: "今日", part: "一日", where: "仙台" }],
  ["この前の土曜の雨すごかった日の京都", { what: ["雨"], day: "日付?", part: "一日", where: "京都" }],
  ["きのうの晩の神戸の風", { what: ["風"], day: "昨日", part: "夜", where: "神戸" }],
  ["10月10日朝の広島の気圧", { what: ["気圧"], day: "日付", date: "10/10", part: "朝", where: "広島" }],
  ["今夜の大阪の風", { day: "未来" }],
  ["おとといの金沢の気圧", { what: ["気圧"], day: "おととい", part: "一日", where: "金沢" }],
  ["昨日の朝の気圧と風と雨", { what: WHAT, day: "昨日", part: "朝", where: "" }],
  ["鹿児島の最近の風", { what: ["風"], day: "最近", part: "一日", where: "鹿児島" }],
  /* ここから下は、AIなしの係が知らない言い方（ルミが係を作ったあとに足した。比べどころ） */
  ["ゆうべの京都の風", { what: ["風"], day: "昨日", part: "夜", where: "京都" }],
  ["きょうの明け方の東京の気圧", { what: ["気圧"], day: "今日", part: "深夜", where: "東京" }],
  ["昨日の京都市の最低気温は？", { what: [OFF], day: "昨日", part: "一日", where: "京都" }],
  ["なごやって昨日しけてた？", { what: ["風", "雨"], day: "昨日", part: "一日", where: "名古屋" }],
];
function score(o, want, P) {
  if (o.bad) return { ok: false, why: "読めない" };
  const miss = []; want = { ...want, what: want.what || WHAT };
  if (want.day === "未来") return o.day === "未来" ? { ok: true } : { ok: false, why: `いつ：${o.day}` };
  if (want.day === "日付?") { /* 正解が決まらない言い方。「未来」にしなければ可（どう書いたかを見る） */ }
  else if (o.day !== want.day) miss.push(`いつ：${o.day}`);
  if (want.date && (o.date.match(/\d+/g) || []).map(Number).join("/") !== want.date) miss.push(`日付：${o.date || "空"}`);
  if (o.part !== want.part) miss.push(`時間帯：${o.part}`);
  if ([...o.what].sort().join() !== [...want.what].sort().join()) miss.push(`何：${o.what.join("・")}`);
  const gp = want.where ? findPlace(want.where, P) : null, op = o.where ? findPlace(o.where, P) : null;
  if ((gp?.name || "") !== (op?.name || "")) miss.push(`どこ：${o.where || "空"}`);
  return { ok: !miss.length, why: miss.join("、") };
}
async function wTest(useAi) {
  const P = await places(), out = $("wOut"); if (useAi && !engine) return;
  setBusy(true); let okN = 0; const lines = [];
  try {
    for (let i = 0; i < TESTS.length; i++) {
      const [text, want] = TESTS[i];
      out.innerHTML = `<p class="note">${useAi ? "AI" : "AIなし"}で試しています… ${i + 1}/${TESTS.length}</p>`;
      const o = useAi ? await aiOrder(text) : ruleOrder(text, P), s = score(o, want, P);
      if (s.ok) okN++;
      lines.push(`<tr><td style="text-align:left;white-space:normal">${esc(text)}</td><td>${s.ok ? '<b class="ok">○</b>' : '<b class="ng">×</b>'}</td><td style="text-align:left;white-space:normal;color:var(--ink-soft)">${esc(s.why || "")}${want.day === "日付?" ? `（→ ${esc(o.day)}${o.date ? " " + esc(o.date) : ""}）` : ""}</td></tr>`);
    }
    const who = useAi ? "AI（" + curId + "）" : "AIなし";
    const st = (stats.waiter ||= {}); st[who] = `${okN}/${TESTS.length}`; saveStats();
    out.innerHTML = `<p class="verdict"><b>${esc(who)}</b>：伝票が合っていたのは <b>${okN} / ${TESTS.length}</b></p><div class="tblbox" style="max-height:420px"><table class="tbl"><tr><th>言い方</th><th>合否</th><th>ちがったところ</th></tr>${lines.join("")}</table></div>`;
    showWStats();
  } catch (e) { out.innerHTML = `<p class="verdict"><b class="ng">止まりました</b>：${esc(e?.message || e)}</p>`; }
  finally { setBusy(false); }
}
window.__waiter = { ruleOrder, score, range, findPlace, TESTS, places: () => places() };   /* 実験室の点検用 */
function showWStats() { const el = $("wStats"); if (!el) return; const w = stats.waiter || {}; el.textContent = Object.keys(w).length ? "これまでの成績（この端末）：" + Object.entries(w).map(([k, v]) => `${k} ${v}`).join("／") : ""; }
function mountWaiter() {
  const host = $("waiterCard"); if (!host) return;
  host.innerHTML = `
  <h2><span class="no">06</span>データのウエイター（AIは伝票を書くだけ）</h2>
  <p class="what">「いつの・どこの・何を持ってきて」と頼むと、AIが<b>伝票</b>（何・いつ・時間帯・どこ）を書きます。記録庫から値を運んで表とグラフにするのはコードです。伝票はそのまま見せるので、まちがえたら「ちがう料理が来た」と分かります。日付の計算・場所さがし・この先のことの断りもコードがします。AIは 05 で読み込んだものを使います（AIなしでも試せます）。</p>
  <textarea id="wIn" style="min-height:56px" placeholder="例：おとといの夜の京都の気圧">おとといの夜の京都の気圧</textarea>
  <div class="ctrl" style="margin-top:8px"><button type="button" id="wAi" disabled>AIに頼む</button><button type="button" id="wRule">AIなしで頼む</button></div>
  <div id="wOut"></div>
  <div class="ctrl" style="margin-top:10px"><span class="note">試しの言い方 ${TESTS.length} 個を一気に流す：</span><button type="button" id="wTestAi" disabled>AIで</button><button type="button" id="wTestRule">AIなしで</button></div>
  <p class="note" id="wStats"></p>
  <p class="note">記録は6時間ごと・場所は日本の主な地点だけ（地名が見つからない時は、ダッシュボードで選んでいる場所）。「この前の土曜の雨すごかった日」のような言い方は正解が1つに決まらないので、どう書いたかを見るためのものです。</p>`;
  $("wAi").onclick = () => wGo(true); $("wRule").onclick = () => wGo(false); $("wTestAi").onclick = () => wTest(true); $("wTestRule").onclick = () => wTest(false);
  showWStats();
}
async function mount() {
  const host = $("aiCard"); if (!host) return;
  const rec = isPhone() ? "light" : "jp";
  host.innerHTML = `
  <h2><span class="no">05</span>ローカルAIでふりかえる（試し）</h2>
  <p class="what">気圧・風・雨の行は<b>コードが作ります</b>（数字と日時はまちがえない）。AIは「聞きたいこと」を読んで、<b>どの項目をどの順で出すか</b>と、最後の問いを選ぶだけです。押した人だけ、モデルを Hugging Face（AIモデルの置き場）から読み込みます。読み込んだモデルは端末の中に残り、下のボタンで消せます。</p>
  <div class="ctrl">
    <button type="button" id="aiLight">${esc(SEATS.light.label)}・${SEATS.light.size}${rec === "light" ? "　★この端末のおすすめ" : ""}</button>
    <button type="button" id="aiJp">${esc(SEATS.jp.label)}・${SEATS.jp.size}${rec === "jp" ? "　★この端末のおすすめ" : ""}</button>
  </div>
  <div style="height:4px;background:rgba(150,172,226,.15);border-radius:4px;overflow:hidden;margin:4px 0 8px"><div id="aiBar" style="height:100%;width:0;background:#c9a7ff"></div></div>
  <label class="note" style="display:block;margin:2px 0 2px"><input type="checkbox" id="aiAuto" checked> 開いた時、前に使った席を自動で読み込む（端末の中にある時だけ。通信なし）</label>
  <label class="note" style="display:block;margin:2px 0 6px"><input type="checkbox" id="aiIDB"> 保存のしかたを変える（IndexedDB。読み込めないときの試し）</label>
  <p class="note" id="aiLog" style="white-space:pre-wrap">${"gpu" in navigator ? "席を選ぶと読み込みが始まります。" : "この端末のブラウザには WebGPU がないので、AIは動かせません。"}</p>
  <textarea id="aiAsk" style="min-height:48px" placeholder="聞きたいこと（例：昨日荒れてた？）">この3日、どうだった？</textarea>
  <div class="ctrl" style="margin-top:8px"><button type="button" id="aiRun" disabled>AIに並べてもらう</button><button type="button" id="aiRule">AIなしで並べる</button><button type="button" id="aiFree" disabled>自由に書かせる（比べる用）</button><button type="button" id="aiDel" disabled>読み込んだモデルを消す</button></div>
  <div id="aiOut"></div>
  <p class="note">この端末での記録（端末の中だけ）</p><div class="kv" id="aiStats"></div>
  <p class="note">軽い席は海外製、少し上の席は日本製（Sakana AI の TinySwallow。有志がブラウザ用に変換したもの）。どちらも試しです。AIはまちがえることがあります。</p>`;
  $("aiLight").onclick = () => load("light"); $("aiJp").onclick = () => load("jp"); $("aiRun").onclick = () => arrange(true); $("aiRule").onclick = () => arrange(false); $("aiFree").onclick = run; $("aiDel").onclick = del;
  showStats(); mountWaiter(); autoLoad();
}
/* 前に読み込めた席が端末の中に残っていれば、開いた時に自動で読み込む（通信なし。置き場へは行かない） */
async function autoLoad() {
  let key = null; try { key = localStorage.getItem("lab.ai.seat"); } catch (_) {}
  const box = $("aiAuto"); try { box.checked = localStorage.getItem("lab.ai.auto") !== "0"; } catch (_) {}
  box.onchange = () => { try { localStorage.setItem("lab.ai.auto", box.checked ? "1" : "0"); } catch (_) {} };
  if (!key || !SEATS[key] || !box.checked || !("gpu" in navigator)) return;
  try {
    webllm = libs[key] ||= await import(LIBS[key]);
    const m = await modelFor(key);
    if (!(await webllm.hasModelInCache(m.id, m.appConfig))) return;
    log(`前に使った ${SEATS[key].label} が端末の中にあるので、自動で読み込みます（通信なし）…`);
    await load(key, true);
  } catch (_) {}
}
if (document.readyState === "loading") addEventListener("DOMContentLoaded", mount); else mount();
})();
