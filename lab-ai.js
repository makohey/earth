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
async function load(key) {
  if (!("gpu" in navigator)) { log("この端末のブラウザには WebGPU がないので、AIは動かせません（実験室の他の部分はそのまま使えます）"); return; }
  const s = SEATS[key];
  if (key === "jp" && isPhone() && !confirm(`${s.label}は${s.size}あります。iPhone だとページが落ちることがあります（記録や設定は消えません）。読み込みますか？`)) return;
  if (key === "light" && !confirm(`${s.label}（${s.size}）を Hugging Face から読み込みます。通信量に気をつけてください。読み込みますか？`)) return;
  setBusy(true); lastModel = null; const t0 = performance.now();
  try {
    webllm = libs[key] ||= await import(LIBS[key]);
    const m = await modelFor(key); lastModel = m;
    if (useIDB()) m.appConfig = { ...(m.appConfig || webllm.prebuiltAppConfig), cacheBackend: "indexeddb", useIndexedDBCache: true };
    if (engine) { try { await engine.unload(); } catch (_) {} engine = null; }
    log("読み込みを始めます…");
    engine = await webllm.CreateMLCEngine(m.id, { appConfig: m.appConfig, initProgressCallback: p => { log(`読み込み中：${Math.round((p.progress || 0) * 100)}%　${p.text || ""}`); const b = $("aiBar"); if (b) b.style.width = `${Math.round((p.progress || 0) * 100)}%`; } });
    curId = m.id; const sec = (performance.now() - t0) / 1000;
    (stats[m.id] ||= { loads: 0, runs: 0, passed: 0, blocked: 0 }).loads++; stats[m.id].loadSec = sec; saveStats();
    log(`読み込み完了：${m.id}（${sec.toFixed(0)} 秒）。「ふりかえりを書かせる」を押してください。`);
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
function setBusy(b) { for (const id of ["aiLight", "aiJp"]) { const el = $(id); if (el) el.disabled = b; } for (const id of ["aiRun", "aiDel"]) { const el = $(id); if (el) el.disabled = b || !engine; } }

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
  const el = $("aiStats"); if (!el) return; const rows = Object.entries(stats);
  el.innerHTML = rows.length ? rows.map(([id, s]) => `<span>${esc(id)}</span><span>読み込み ${s.loads}回（最後 ${Math.round(s.loadSec || 0)}秒）・書かせた ${s.runs}回・通過 ${s.passed}・止めた ${s.blocked}${s.tps ? `・1秒に約${s.tps.toFixed(1)}トークン` : ""}</span>`).join("") : "<span>まだ記録はありません</span><span></span>";
}
async function mount() {
  const host = $("aiCard"); if (!host) return;
  const rec = isPhone() ? "light" : "jp";
  host.innerHTML = `
  <h2><span class="no">05</span>ローカルAIに書かせてみる（試し）</h2>
  <p class="what">② の事実だけをAIに渡して、ふりかえりの文を書かせます。AIの文は ③ の見張りと「数字の照合」を通ってから出ます。押した人だけ、モデルを Hugging Face（AIモデルの置き場）から読み込みます。読み込んだモデルは端末の中に残り、下のボタンで消せます。</p>
  <div class="ctrl">
    <button type="button" id="aiLight">${esc(SEATS.light.label)}・${SEATS.light.size}${rec === "light" ? "　★この端末のおすすめ" : ""}</button>
    <button type="button" id="aiJp">${esc(SEATS.jp.label)}・${SEATS.jp.size}${rec === "jp" ? "　★この端末のおすすめ" : ""}</button>
  </div>
  <div style="height:4px;background:rgba(150,172,226,.15);border-radius:4px;overflow:hidden;margin:4px 0 8px"><div id="aiBar" style="height:100%;width:0;background:#c9a7ff"></div></div>
  <label class="note" style="display:block;margin:2px 0 6px"><input type="checkbox" id="aiIDB"> 保存のしかたを変える（IndexedDB。読み込めないときの試し）</label>
  <p class="note" id="aiLog" style="white-space:pre-wrap">${"gpu" in navigator ? "席を選ぶと読み込みが始まります。" : "この端末のブラウザには WebGPU がないので、AIは動かせません。"}</p>
  <div class="ctrl"><button type="button" id="aiRun" disabled>ふりかえりを書かせる</button><button type="button" id="aiDel" disabled>読み込んだモデルを消す</button></div>
  <div id="aiOut"></div>
  <p class="note">この端末での記録（端末の中だけ）</p><div class="kv" id="aiStats"></div>
  <p class="note">軽い席は海外製、少し上の席は日本製（Sakana AI の TinySwallow。有志がブラウザ用に変換したもの）。どちらも試しです。AIはまちがえることがあります。</p>`;
  $("aiLight").onclick = () => load("light"); $("aiJp").onclick = () => load("jp"); $("aiRun").onclick = run; $("aiDel").onclick = del;
  showStats();
}
if (document.readyState === "loading") addEventListener("DOMContentLoaded", mount); else mount();
})();
