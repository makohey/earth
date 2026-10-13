/* ===== 実験室 07：手帳の練習台 =====
   ・入力は1つだけ。ローカルくんが「種類・何・場所・すること」を読み取る。日付と時刻はコードが読む（まちがえない）
   ・読み取った結果はカードで見せて、確かめてから並べる（重要事項2：AIはまちがえる前提）
   ・保存は端末の中だけ（重要事項1）。書き出しボタンつき（重要事項4）
   ・その日の「ふりかえり」を予約できる。頼むのは前、出すのは後。その日の記録がそろうまでは何も出さない（予報はしない）
   ・手帳では「明日」「来週」は自分の予定なので、地球儀の「未来の言葉の見張り」は使わない
   2026-10-14 まことの構想（10・14朝9時スタバへ寄ってから出勤予定 → 日時に書き込み・直近の予定へ）から作成 */
(() => {
"use strict";
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const KEY = "plan.items";
const KINDS = ["予定", "やること", "習慣", "メモ"];
const ACTS = ["出勤", "釣り", "海", "山", "外出", "洗濯", "移動", "その他"];
/* すること → ふりかえりで見る項目 */
const LOOK = { 釣り: ["波", "風", "潮回り", "雨"], 海: ["波", "風", "潮回り", "雨"], 山: ["風", "雨", "気圧"], 洗濯: ["雨", "風"], 出勤: ["雨", "風"], 外出: ["雨", "風", "気圧"], 移動: ["雨", "風"], その他: ["雨", "風", "気圧"] };
const WD = ["日", "月", "火", "水", "木", "金", "土"];
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch (_) { return []; } };
const save = items => { try { localStorage.setItem(KEY, JSON.stringify(items)); } catch (_) {} };
const z = n => String(n).padStart(2, "0");

/* ---------- 日本時間の「今日」 ---------- */
function todayJ() { const j = new Date(Date.now() + 9 * 3600000); return { y: j.getUTCFullYear(), m: j.getUTCMonth() + 1, d: j.getUTCDate(), w: j.getUTCDay() }; }
const ymd = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return `${t.getUTCFullYear()}-${z(t.getUTCMonth() + 1)}-${z(t.getUTCDate())}`; };
const addDays = (n) => { const t = todayJ(); return ymd(t.y, t.m, t.d + n); };
const zen = s => String(s).replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/[：]/g, ":");

/* ---------- 日付と時刻はコードが読む ---------- */
function readDate(text) {
  const s = zen(text), t = todayJ(); let m;
  if ((m = s.match(/(\d{4})\s*[\/年.・-]\s*(\d{1,2})\s*[\/月.・-]\s*(\d{1,2})/))) return { date: ymd(+m[1], +m[2], +m[3]), how: m[0] };
  if ((m = s.match(/(\d{1,2})\s*[\/月.・-]\s*(\d{1,2})\s*日?/))) { const mo = +m[1], d = +m[2]; if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) { let y = t.y; if (ymd(y, mo, d) < ymd(t.y, t.m, t.d) && (t.m - mo) > 6) y++; return { date: ymd(y, mo, d), how: m[0] }; } }
  if ((m = s.match(/今日|きょう|本日/))) return { date: addDays(0), how: m[0] };
  if ((m = s.match(/明後日|あさって/))) return { date: addDays(2), how: m[0] };
  if ((m = s.match(/明日|あした|あす/))) return { date: addDays(1), how: m[0] };
  if ((m = s.match(/(再来週|来週|今週)?の?\s*([日月火水木金土])曜日?/))) { const want = WD.indexOf(m[2]); let n = (want - t.w + 7) % 7;
    /* 週は月曜はじまり。「来週の土曜」＝次の月曜から始まる週の土曜 */
    if (m[1] === "来週" || m[1] === "再来週") { const nextMon = ((8 - t.w) % 7) || 7; n = nextMon + (want + 6) % 7 + (m[1] === "再来週" ? 7 : 0); }
    return { date: addDays(n), how: m[0] }; }
  if ((m = s.match(/週末/))) return { date: addDays((6 - t.w + 7) % 7), how: m[0] };
  if ((m = s.match(/(\d{1,2})日/))) { const d = +m[1]; if (d >= 1 && d <= 31) { let mo = t.m, y = t.y; if (d < t.d) { mo++; if (mo > 12) { mo = 1; y++; } } return { date: ymd(y, mo, d), how: m[0] }; } }
  return null;
}
function readTime(text) {
  const s = zen(text); let m;
  const pm = /午後|夕方|夜|晩/.test(s), am = /午前|朝|明け方/.test(s);
  if ((m = s.match(/(\d{1,2}):(\d{2})/))) { let h = +m[1]; if (pm && h < 12) h += 12; return { time: `${z(h)}:${m[2]}`, how: m[0] }; }
  if ((m = s.match(/(\d{1,2})\s*時\s*(半|(\d{1,2})\s*分)?/))) { let h = +m[1]; const mi = m[2] === "半" ? 30 : m[3] ? +m[3] : 0; if (pm && h < 12) h += 12; if (am && h === 12) h = 0; return { time: `${z(h)}:${z(mi)}`, how: m[0] }; }
  if ((m = s.match(/明け方|朝|昼|夕方|夜|晩/))) return { time: "", part: m[0], how: m[0] };
  return null;
}

/* ---------- AIなしの係（比べる相手） ---------- */
const ACT_RE = { 出勤: /出勤|仕事|会社|職場|シフト/, 釣り: /釣り|つり/, 海: /海|ビーチ|海水浴|サーフィン/, 山: /山|登山|ハイキング/, 洗濯: /洗濯|布団|干す/, 移動: /旅行|出張|新幹線|飛行機|ドライブ/, 外出: /買い物|スタバ|カフェ|病院|散歩|外食|映画|遊び/ };
function ruleRead(text, P) {
  const d = readDate(text), tm = readTime(text);
  const act = Object.keys(ACT_RE).find(k => ACT_RE[k].test(text)) || "その他";
  const kind = /毎日|毎朝|毎晩|毎週|習慣/.test(text) ? "習慣" : (d || tm) ? "予定" : /買う|出す|払う|やる|する|片付け|返す|連絡/.test(text) ? "やること" : "メモ";
  let what = zen(text); for (const h of [d?.how, tm?.how]) if (h) what = what.replace(h, ""); what = what.replace(/^[\s、,。]+|予定$|[\s、,。]+$/g, "").replace(/^[にのへ\s]+/, "").trim();
  const pl = window.LABAI.findPlace(text, P);
  return { kind, what: what || text, place: pl ? pl.name : (text.match(/スタバ|[ァ-ヶー]{2,}|[一-龠]{1,4}(駅|港|山|海岸|公園)/) || [""])[0], activity: act, date: d?.date || "", time: tm?.time || "", part: tm?.part || "" };
}

/* ---------- ローカルくんに読ませる（日付と時刻は渡した文から、コードがあとで読む） ---------- */
const SCHEMA = { type: "object", properties: {
  kind: { type: "string", enum: KINDS }, what: { type: "string" }, place: { type: "string" },
  activity: { type: "string", enum: ACTS }, when: { type: "string" } }, required: ["kind", "what", "place", "activity", "when"] };
const SYS = [
  "あなたは手帳の係です。書かれた一行を読んで、JSONに分けるだけが仕事です。説明は書きません。",
  `kind：${KINDS.join("・")} から選ぶ（日時が決まっている用事は予定、いつかやる用事はやること、毎日・毎週のことは習慣、それ以外はメモ）`,
  "what：何をするかを短く（日付や時刻の言葉は入れない）",
  "place：行く場所や店の名前。なければ空",
  `activity：${ACTS.join("・")} から一番近いもの`,
  "when：日付と時刻の言葉を、書かれたまま抜き出す（例：「10・14朝9時」「明日の夜」）。なければ空",
  '例：「10・14朝9時スタバへ寄ってから出勤予定」→ {"kind":"予定","what":"スタバへ寄ってから出勤","place":"スタバ","activity":"出勤","when":"10・14朝9時"}',
  '例：「牛乳かう」→ {"kind":"やること","what":"牛乳を買う","place":"","activity":"外出","when":""}',
].join("\n");
async function aiRead(text) {
  const eng = window.LABAI.engine(); if (!eng) throw new Error("AIが読み込まれていません（05番で読み込んでください）");
  const msgs = [{ role: "system", content: SYS }, { role: "user", content: text }];
  let r; try { r = await eng.chat.completions.create({ messages: msgs, temperature: 0, max_tokens: 120, response_format: { type: "json_object", schema: JSON.stringify(SCHEMA) } }); }
  catch (_) { r = await eng.chat.completions.create({ messages: msgs, temperature: 0, max_tokens: 120 }); }
  const raw = (r.choices?.[0]?.message?.content || "").trim(), m = raw.match(/\{[\s\S]*\}/); let o = null; try { o = JSON.parse(m ? m[0] : raw); } catch (_) {}
  if (!o) return { bad: true, raw };
  /* 日付と時刻：まず元の文からコードが読む。読めなければ、AIが抜き出した言葉をコードが読む */
  const d = readDate(text) || readDate(o.when || ""), tm = readTime(text) || readTime(o.when || "");
  return { kind: KINDS.includes(o.kind) ? o.kind : "メモ", what: String(o.what || text), place: String(o.place || ""), activity: ACTS.includes(o.activity) ? o.activity : "その他",
    date: d?.date || "", time: tm?.time || "", part: tm?.part || "", raw };
}

/* ---------- 潮回り（月齢からの目安。暦の計算なので予報ではない） ---------- */
/* 月と太陽の離れ角（主な補正つき・Meeus の簡単な式）→ 月齢。誤差はおよそ数時間 */
function elong(t) { const d = (t - Date.UTC(2000, 0, 1, 12)) / 86400000, r = Math.PI / 180, S = x => Math.sin(x * r);
  const D = 297.8501921 + 12.19074912 * d, M = 357.5291092 + 0.98560028 * d, Mp = 134.9633964 + 13.06499295 * d;
  const e = D + 6.289 * S(Mp) - 2.100 * S(M) + 1.274 * S(2 * D - Mp) + 0.658 * S(2 * D) + 0.214 * S(2 * Mp) - 0.110 * S(D);
  return (e % 360 + 360) % 360; }
/* 月齢＝いちばん近い過去の新月（離れ角が0）からの日数。新月の時刻は二分法で探す */
function moonAge(t) { let a = t - elong(t) / 360 * 29.530588 * 86400000 - 2 * 86400000, b = a + 4 * 86400000;
  const f = x => { const e = elong(x); return e > 180 ? e - 360 : e; };
  for (let i = 0; i < 40; i++) { const m = (a + b) / 2; if (f(m) < 0) a = m; else b = m; }
  return (t - (a + b) / 2) / 86400000; }
function tideName(age) { const a = Math.round(age) % 30;
  return [0, 1, 2, 14, 15, 16, 17, 29].includes(a) ? "大潮" : [7, 8, 9, 22, 23, 24].includes(a) ? "小潮" : a === 10 || a === 25 ? "長潮" : a === 11 || a === 26 ? "若潮" : "中潮"; }

/* ---------- ふりかえり（その日の記録がそろってから、事後のまとめ） ---------- */
const DIRS = () => window.LAB.DIRS;
const dirName = deg => DIRS()[Math.round(deg / 22.5) % 16];
const HF = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "numeric" });
function dayRange(date) { const [y, m, d] = date.split("-").map(Number); const t0 = Date.UTC(y, m - 1, d) - 9 * 3600000; return [t0, t0 + 86400000]; }
function status(it) {
  if (!it.review) return { st: "none" };
  if (it.report) return { st: "done" };
  const [t0, t1] = dayRange(it.date), ix = window.LAB.index(); const last = ix?.sets?.length ? +new Date(ix.sets[ix.sets.length - 1].validTime) : 0;
  if (Date.now() < t0) return { st: "wait", why: "その日になっていません" };
  if (last < t1 - 6 * 3600000) return { st: "wait", why: "その日の記録がまだそろっていません（その日の夜〜次の日に、もう一度開いてください）" };
  return { st: "ready" };
}
async function buildReport(it) {
  const [t0, t1] = dayRange(it.date), rows = await window.LAB.rows({ lat: it.review.lat, lon: it.review.lon }, t0, t1);
  if (!rows.length) return { lines: [], note: "その日の記録が記録庫にありませんでした（記録庫は31日で消えます）。" };
  const L = window.LAB, look = it.review.items, out = [];
  for (const k of look) {
    if (k === "波") { const w = rows.filter(r => r.wh != null); if (!w.length) { out.push(["波", ["近くに海の升目がないか、波の記録がありませんでした"]]); continue; }
      const lo = Math.min(...w.map(r => r.wh)), hi = Math.max(...w.map(r => r.wh)), mx = w.find(r => r.wh === hi), per = w.filter(r => r.wper != null);
      out.push(["波", [`高さ ${lo.toFixed(1)}〜${hi.toFixed(1)} m（いちばん高かったのは ${HF.format(mx.t)}${mx.wdir != null ? "・" + dirName(mx.wdir) + "から" : ""}）`, per.length ? `周期 ${Math.min(...per.map(r => r.wper)).toFixed(0)}〜${Math.max(...per.map(r => r.wper)).toFixed(0)} 秒（10秒以上はうねり）` : ""].filter(Boolean)]); }
    if (k === "風") { const w = rows.filter(r => r.spd != null); if (!w.length) continue; const mx = w.reduce((a, b) => b.spd > a.spd ? b : a);
      out.push(["風", [`いちばん強い ${dirName(mx.from)}の風 ${mx.spd.toFixed(1)} m/s（${HF.format(mx.t)}）＝ 時速約${Math.round(mx.spd * 3.6)}km`]]); }
    if (k === "雨") { const r = rows.filter(x => x.rain != null), wet = r.filter(x => x.rain >= 0.1);
      out.push(["雨", [wet.length ? `雨が出ていた記録 ${r.length}回中${wet.length}回（いちばん強かったのは ${HF.format(wet.reduce((a, b) => b.rain > a.rain ? b : a).t)}・${L.rainWord(wet.reduce((a, b) => b.rain > a.rain ? b : a).rain)}）` : `雨が出ていた記録 ${r.length}回中0回`]]); }
    if (k === "気圧") { const p = rows.filter(x => x.p != null); if (!p.length) continue; const lo = p.reduce((a, b) => b.p < a.p ? b : a), hi = p.reduce((a, b) => b.p > a.p ? b : a);
      out.push(["気圧", [`${lo.p.toFixed(1)}〜${hi.p.toFixed(1)} hPa（差 ${(hi.p - lo.p).toFixed(1)}）`]]); }
    if (k === "潮回り") { const age = moonAge(t0 + 12 * 3600000); out.push(["潮回り", [`${tideName(age)}（月齢 ${age.toFixed(0)}・月の形からの目安。満潮・干潮の時刻はここにはありません）`]]); }
  }
  const complete = rows.length >= 4;
  return { lines: out, n: rows.length, complete, note: `${esc(it.review.name)}のあたり（約100km四方の計算。その場所の観測ではありません。湾や港の中の波は合いません）・記録 ${rows.length} 回分`, made: Date.now() };
}

/* ---------- 画面 ---------- */
let draft = null;
function card(o, who, sec) {
  const P = PL || [], pl = window.LABAI.findPlace(o.place || "", P), home = window.LAB.place();
  const rv = pl ? { name: pl.name, lat: pl.lat, lon: pl.lon } : { name: home.name, lat: home.lat, lon: home.lon };
  draft = { ...o, review: rv, look: LOOK[o.activity] || LOOK.その他 };
  const opts = (list, v) => list.map(x => `<option${x === v ? " selected" : ""}>${esc(x)}</option>`).join("");
  return `<div style="margin:6px 0">${window.LABAI.chip("読み取った人", who + (sec != null ? `・${sec.toFixed(1)}秒` : ""))}</div>
  <div class="aiText" style="font-size:14.5px">
    <div class="pf"><span>種類</span><select id="pKind">${opts(KINDS, o.kind)}</select></div>
    <div class="pf"><span>日付</span><input type="date" id="pDate" value="${esc(o.date)}"><small>${o.date ? esc(DF(o.date)) : "なし"}</small></div>
    <div class="pf"><span>時刻</span><input type="time" id="pTime" value="${esc(o.time)}">${o.part && !o.time ? `<small>${esc(o.part)}</small>` : ""}</div>
    <div class="pf"><span>何</span><input id="pWhat" value="${esc(o.what)}"></div>
    <div class="pf"><span>場所</span><input id="pPlace" value="${esc(o.place)}"></div>
    <div class="pf"><span>すること</span><select id="pAct">${opts(ACTS, o.activity)}</select></div>
    <label class="pf"><span>ふりかえり</span><span><input type="checkbox" id="pRev"${o.kind === "予定" && o.date ? " checked" : ""}> その日の記録がそろったら、<b id="pRevName">${esc(rv.name)}</b>のあたりの <span id="pLook">${esc(draft.look.join("・"))}</span> をまとめる${pl ? "" : `<br><small>（「${esc(o.place || "場所")}」は地図の地名にないので、いつもの場所＝${esc(home.name)}にしています）</small>`}</span></label>
  </div>
  <div class="ctrl"><button type="button" id="pOk">これで入れる</button><button type="button" id="pNo">やめる</button></div>
  <p class="note">まちがっていたら、ここで直してから入れてください（AIはまちがえる前提）。保存はこの端末の中だけです。</p>`;
}
function wireCard() {
  $("pAct").onchange = () => { draft.look = LOOK[$("pAct").value] || LOOK.その他; $("pLook").textContent = draft.look.join("・"); };
  $("pNo").onclick = () => { $("pOut").innerHTML = ""; draft = null; };
  $("pOk").onclick = () => {
    const it = { id: Date.now().toString(36), kind: $("pKind").value, date: $("pDate").value, time: $("pTime").value, part: draft.part || "", what: $("pWhat").value.trim(), place: $("pPlace").value.trim(), activity: $("pAct").value, src: draft.src, made: Date.now() };
    if ($("pRev").checked && it.date) it.review = { ...draft.review, items: draft.look.slice() };
    const items = load(); items.push(it); save(items); draft = null;
    $("pOut").innerHTML = `<p class="verdict"><b class="ok">入れました</b>：${esc(it.date || "日付なし")} ${esc(it.time || it.part)} ${esc(it.what)}</p>`; $("pIn").value = ""; list();
  };
}
async function go(useAi) {
  const text = $("pIn").value.trim(); if (!text) return;
  PL = PL || await window.LABAI.places();
  if (!useAi) { const o = ruleRead(text, PL); o.src = text; $("pOut").innerHTML = card(o, "AIなし"); wireCard(); return; }
  window.LABAI.busy(true); $("pOut").innerHTML = '<p class="note">ローカルくんが読み取っています…</p>'; const t0 = performance.now();
  try { const o = await aiRead(text); if (o.bad) { $("pOut").innerHTML = `<p class="verdict"><b class="ng">読み取れませんでした</b></p><details><summary>AIが書いたもの</summary><pre class="note">${esc(o.raw)}</pre></details>`; return; }
    o.src = text; $("pOut").innerHTML = card(o, "AI（" + window.LABAI.id().split("-").slice(0, 2).join(" ") + "）", (performance.now() - t0) / 1000); wireCard(); }
  catch (e) { $("pOut").innerHTML = `<p class="verdict"><b class="ng">止まりました</b>：${esc(e?.message || e)}</p>`; }
  finally { window.LABAI.busy(false); }
}
let PL = null;
const DF = d => { if (!d) return "日付なし"; const t = new Date(Date.parse(d + "T12:00:00+09:00")); return `${t.getUTCMonth() + 1}/${t.getUTCDate()}（${WD[t.getUTCDay()]}）`; };
async function list() {
  const items = load(), today = addDays(0), host = $("pList"); if (!host) return;
  const sortKey = it => `${it.date || "9999"} ${it.time || (it.part === "朝" ? "07:00" : it.part === "昼" ? "12:00" : it.part === "夕方" ? "17:00" : it.part ? "20:00" : "99:99")}`;
  const up = items.filter(it => it.date && it.date >= today).sort((a, b) => sortKey(a) < sortKey(b) ? -1 : 1);
  const undated = items.filter(it => !it.date), past = items.filter(it => it.date && it.date < today).sort((a, b) => sortKey(a) > sortKey(b) ? -1 : 1);
  /* ふりかえり：そろった分は作って、端末の中に残す（記録庫は31日で消えるので） */
  let made = 0;
  for (const it of past.concat(up)) if (it.review && !it.report && status(it).st === "ready") { try { const rp = await buildReport(it); if (rp.lines.length) { it.report = rp; made++; } } catch (_) {} }
  if (made) save(items);
  const row = it => { const s = status(it);
    const badge = s.st === "done" ? `<span class="ok">📋 ふりかえりあり</span>` : s.st === "wait" ? `<span class="note">⏳ ふりかえり予約中</span>` : "";
    return `<div class="prow" data-id="${it.id}"><div><b>${esc(DF(it.date))}</b> ${esc(it.time || it.part || "")} <span class="pk">${esc(it.kind)}</span> ${esc(it.what)}${it.place ? ` <small>＠${esc(it.place)}</small>` : ""} ${badge}</div>
      ${it.report ? `<details><summary>ふりかえりを見る</summary><div class="aiText" style="font-size:14px">📋 ${esc(DF(it.date))} ${esc(it.what)}${it.report.lines.map(([k, ls]) => `<div style="margin:6px 0"><b style="color:var(--lab)">【${esc(k)}】</b>${ls.map(l => `<div style="padding-left:1em">${esc(l)}</div>`).join("")}</div>`).join("")}<div class="note">${it.report.note}</div></div></details>` : s.st === "wait" ? `<div class="note" style="padding-left:1em">${esc(s.why)}。この先の天気は <a href="https://www.jma.go.jp/bosai/forecast/" target="_blank" rel="noopener">気象庁</a> へ。</div>` : ""}
      <button type="button" class="pdel" data-del="${it.id}" aria-label="消す">✕</button></div>`; };
  host.innerHTML = `<div class="note">直近の予定</div>${up.length ? up.map(row).join("") : '<p class="note">まだありません</p>'}`
    + (undated.length ? `<div class="note" style="margin-top:8px">日付なし（やること・メモ・習慣）</div>${undated.map(row).join("")}` : "")
    + (past.length ? `<details style="margin-top:8px"><summary>すんだ予定（${past.length}）</summary>${past.map(row).join("")}</details>` : "")
    + (made ? `<p class="verdict"><b class="ok">ふりかえりが ${made} 件できました</b></p>` : "");
}
/* ---------- 試しの文（ルミが作った分。まことの本物の書き方が来たら足す） ---------- */
const TESTS = [
  ["10・14朝9時スタバへ寄ってから出勤予定", { kind: "予定", activity: "出勤", date: "10-14", time: "09:00" }],
  ["10・20釣りに行く", { kind: "予定", activity: "釣り", date: "10-20" }],
  ["明日の夜7時に歯医者", { kind: "予定", activity: "外出", date: "+1", time: "19:00" }],
  ["牛乳かう", { kind: "やること", activity: "外出" }],
  ["毎朝ストレッチ10分", { kind: "習慣" }],
  ["来週の土曜、舞鶴で海釣り", { kind: "予定", activity: "釣り" }],
  ["急遽 明日出勤になった", { kind: "予定", activity: "出勤", date: "+1" }],
  ["10/25 14:30 打ち合わせ", { kind: "予定", date: "10-25", time: "14:30" }],
  ["布団干したい 晴れたら", { kind: "やること", activity: "洗濯" }],
  ["京大の公開講座のメール見とく", { kind: "やること" }],
  ["あさって休み", { kind: "予定", date: "+2" }],
  ["来月の車検の予約電話", { kind: "やること" }],
  ["今日あったこと：昼にラーメン", { kind: "メモ" }],
  ["週末 大阪へドライブ", { kind: "予定", activity: "移動" }],
  ["18日 夕方 散歩", { kind: "予定", activity: "外出" }],
];
function want(w) { const t = todayJ(); const o = { ...w }; if (o.date === "+1") o.date = addDays(1); else if (o.date === "+2") o.date = addDays(2); else if (o.date) o.date = `${t.y}-${o.date}`; return o; }
function score(o, w) { const W = want(w), miss = [];
  if (o.kind !== W.kind) miss.push(`種類：${o.kind}`); if (W.activity && o.activity !== W.activity) miss.push(`すること：${o.activity}`);
  if (W.date && o.date !== W.date) miss.push(`日付：${o.date || "空"}`); if (W.time && o.time !== W.time) miss.push(`時刻：${o.time || "空"}`);
  return { ok: !miss.length, why: miss.join("、") }; }
async function test(useAi) {
  PL = PL || await window.LABAI.places(); if (useAi && !window.LABAI.engine()) return;
  window.LABAI.busy(true); const res = []; let ok = 0, saved = 0;
  try { for (let i = 0; i < TESTS.length; i++) { const [text, w] = TESTS[i]; $("pOut").innerHTML = `<p class="note">${useAi ? "AI" : "AIなし"}で試しています… ${i + 1}/${TESTS.length}</p>`;
      const r = ruleRead(text, PL), sr = score(r, w); let o = r, s = sr;
      if (useAi) { o = await aiRead(text); s = o.bad ? { ok: false, why: "読めない" } : score(o, w); if (s.ok && !sr.ok) saved++; }
      if (s.ok) ok++; res.push([text, s]); }
    const who = useAi ? "AI（" + window.LABAI.id() + "）" : "AIなし", st = window.LABAI.stats(); (st.plan ||= {})[who] = `${ok}/${TESTS.length}${useAi ? `・救った ${saved}` : ""}`; window.LABAI.save();
    $("pOut").innerHTML = `<p class="verdict"><b>${esc(who)}</b>：正しく読み取れたのは <b>${ok} / ${TESTS.length}</b>${useAi ? `・<b>AIが救った数 ${saved}</b>（AIなしではまちがえて、AIでは合っていた）` : ""}</p>
      <div class="tblbox" style="max-height:420px"><table class="tbl"><tr><th>書いた文</th><th>合否</th><th>ちがったところ</th></tr>${res.map(([t, s]) => `<tr><td style="text-align:left;white-space:normal">${esc(t)}</td><td>${s.ok ? '<b class="ok">○</b>' : '<b class="ng">×</b>'}</td><td style="text-align:left;white-space:normal;color:var(--ink-soft)">${esc(s.why)}</td></tr>`).join("")}</table></div>`;
    showStats();
  } catch (e) { $("pOut").innerHTML = `<p class="verdict"><b class="ng">止まりました</b>：${esc(e?.message || e)}</p>`; }
  finally { window.LABAI.busy(false); }
}
function showStats() { const el = $("pStats"); const p = window.LABAI.stats().plan || {}; if (el) el.textContent = Object.keys(p).length ? "これまでの成績（この端末）：" + Object.entries(p).map(([k, v]) => `${k} ${v}`).join("／") : ""; }
function exportAll() {
  const blob = new Blob([JSON.stringify({ app: "地球儀の実験室・手帳の練習台", exportedAt: new Date().toISOString(), items: load() }, null, 1)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `techo-${addDays(0)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function mount() {
  const host = $("planCard"); if (!host) return;
  const st = document.createElement("style"); st.textContent = `.pf{display:grid;grid-template-columns:5.5em 1fr;gap:6px;align-items:center;margin:4px 0}.pf>span:first-child{color:var(--ink-soft);font-size:13px}
    .pf input,.pf select{font:inherit;font-size:15px;color:var(--ink);background:rgba(8,12,24,.6);border:1px solid var(--tile-edge);border-radius:8px;padding:5px 8px;min-width:0;max-width:100%}
    .prow{position:relative;border-bottom:1px solid var(--tile-edge);padding:7px 30px 7px 0;font-size:14.5px}.pk{font-size:11px;border:1px solid var(--tile-edge);border-radius:6px;padding:0 5px;color:var(--ink-soft)}
    .pdel{position:absolute;right:0;top:6px;background:none;border:0;color:var(--ink-faint);font-size:15px;cursor:pointer}`;
  document.head.appendChild(st);
  host.innerHTML = `
  <h2><span class="no">07</span>手帳の練習台（入力は1つだけ）</h2>
  <p class="what">ふだんの書き方で一行入れると、ローカルくんが<b>種類・何・場所・すること</b>を読み取ります。<b>日付と時刻はコードが読みます</b>（「10・14」「明日」「来週の土曜」など）。読み取った結果を確かめてから、直近の予定に並べます。予定には「その日の<b>ふりかえり</b>」を予約できます。頼むのは前、出すのは後。その日の記録がそろうまでは何も出しません（予報はしません）。保存はこの端末の中だけです。</p>
  <textarea id="pIn" style="min-height:48px" placeholder="例：10・14朝9時スタバへ寄ってから出勤予定">10・20釣りに行く</textarea>
  <div class="ctrl" style="margin-top:8px"><button type="button" id="pAi" disabled>AIに読み取ってもらう</button><button type="button" id="pRule">AIなしで読み取る</button></div>
  <div id="pOut"></div>
  <div id="pList" style="margin-top:10px"></div>
  <div class="ctrl" style="margin-top:10px"><span class="note">試しの文 ${TESTS.length} 個を一気に流す：</span><button type="button" id="pTestAi" disabled>AIで</button><button type="button" id="pTestRule">AIなしで</button><span style="flex:1"></span><button type="button" id="pExp">手帳を書き出す（JSON）</button></div>
  <p class="note" id="pStats"></p>
  <p class="note">試しの文はルミが作ったもの（AIなしの係に寄っているかもしれません）。まことの本物の書き方が来たら足します。ふりかえりの潮回りは月の形からの目安で、満潮・干潮の時刻はありません。</p>`;
  $("pAi").disabled = !window.LABAI?.engine?.();
  $("pList").onclick = e => { const b = e.target.closest("[data-del]"); if (!b) return; const items = load(), it = items.find(x => x.id === b.dataset.del);
    if (it && confirm(`「${it.what}」を消しますか？（ふりかえりも一緒に消えます）`)) { save(items.filter(x => x !== it)); list(); } };
  $("pAi").onclick = () => go(true); $("pRule").onclick = () => go(false); $("pTestAi").onclick = () => test(true); $("pTestRule").onclick = () => test(false); $("pExp").onclick = exportAll;
  showStats();
  const wait = () => window.LAB?.index?.() ? list() : setTimeout(wait, 500); wait();
}
window.__plan = { readDate, readTime, ruleRead, score, TESTS, moonAge, tideName, want };   /* 実験室の点検用 */
if (document.readyState === "loading") addEventListener("DOMContentLoaded", mount); else mount();
})();
