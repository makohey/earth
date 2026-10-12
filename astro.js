/* ===== アストロノミー（試作）：太陽系の並び ＋ 流星群の夜 =====
   ・惑星の位置：NASA JPL「惑星のおおよその位置」の軌道要素（Standish、1800〜2050年向け）から計算。水源へは行かない
   ・流星群：極大の日は「太陽が空のどこにいるか（太陽黄経）」から毎年計算する目安。正確な日時は国立天文台へ
   ・空の図：選んだ場所の地平線と天頂。放射点・月・惑星の位置は計算。流れ星の線は演出（数の多さは計算の目安を反映）
   ・天気（今夜晴れるか）は扱わない。雲の予報は気象庁へ */
(() => {
"use strict";
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const S = x => Math.sin(x * D2R), C = x => Math.cos(x * D2R);
const days = ms => ms / 86400000 + 2440587.5 - 2451545.0;
const gmst = ms => ((280.46061837 + 360.98564736629 * days(ms)) % 360 + 360) % 360;
const norm = a => ((a % 360) + 360) % 360;
const JSTH = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" });
const JSTD = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "numeric", day: "numeric" });
const JSTMD = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", weekday: "short" });
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* --- 惑星（JPL の表：a[AU], e, I[°], L[°], ϖ[°], Ω[°] と 1世紀あたりの変化） --- */
const PL = [
  ["水星", "#b9b3a8", 0.38709927, 0.00000037, 0.20563593, 0.00001906, 7.00497902, -0.00594749, 252.25032350, 149472.67411175, 77.45779628, 0.16047689, 48.33076593, -0.12534081],
  ["金星", "#f2d9a0", 0.72333566, 0.00000390, 0.00677672, -0.00004107, 3.39467605, -0.00078890, 181.97909950, 58517.81538729, 131.60246718, 0.00268329, 76.67984255, -0.27769418],
  ["地球", "#7fb4ff", 1.00000261, 0.00000562, 0.01671123, -0.00004392, -0.00001531, -0.01294668, 100.46457166, 35999.37244981, 102.93768193, 0.32327364, 0, 0],
  ["火星", "#ff8a65", 1.52371034, 0.00001847, 0.09339410, 0.00007882, 1.84969142, -0.00813131, -4.55343205, 19140.30268499, -23.94362959, 0.44441088, 49.55953891, -0.29257343],
  ["木星", "#e8c9a0", 5.20288700, -0.00011607, 0.04838624, -0.00013253, 1.30439695, -0.00183714, 34.39644051, 3034.74612775, 14.72847983, 0.21252668, 100.47390909, 0.20469106],
  ["土星", "#e6d39a", 9.53667594, -0.00125060, 0.05386179, -0.00050991, 2.48599187, 0.00193609, 49.95424423, 1222.49362201, 92.59887831, -0.41897216, 113.66242448, -0.28867794],
  ["天王星", "#9fe3e8", 19.18916464, -0.00196176, 0.04725744, -0.00004397, 0.77263783, -0.00242939, 313.23810451, 428.48202785, 170.95427630, 0.40805281, 74.01692503, 0.04240589],
  ["海王星", "#7d9cff", 30.06992276, 0.00026291, 0.00859048, 0.00005105, 1.77004347, 0.00035372, -55.12002969, 218.45945325, 44.96476227, -0.32241464, 131.78422574, -0.00508664],
];
/** 太陽中心・黄道座標（AU） */
function helio(p, ms) {
  const T = days(ms) / 36525, a = p[2] + p[3] * T, e = p[4] + p[5] * T, I = p[6] + p[7] * T, L = p[8] + p[9] * T, w = p[10] + p[11] * T, O = p[12] + p[13] * T;
  const om = w - O; let M = norm(L - w); if (M > 180) M -= 360;
  let E = M + R2D * e * S(M); for (let k = 0; k < 8; k++) E -= (E - R2D * e * S(E) - M) / (1 - e * C(E));
  const xp = a * (C(E) - e), yp = a * Math.sqrt(1 - e * e) * S(E);
  const x = (C(om) * C(O) - S(om) * S(O) * C(I)) * xp + (-S(om) * C(O) - C(om) * S(O) * C(I)) * yp;
  const y = (C(om) * S(O) + S(om) * C(O) * C(I)) * xp + (-S(om) * S(O) + C(om) * C(O) * C(I)) * yp;
  const z = (S(om) * S(I)) * xp + (C(om) * S(I)) * yp;
  return { x, y, z, lon: norm(Math.atan2(y, x) * R2D), r: Math.hypot(x, y, z) };
}
const ECL = 23.43928;
function eclToEq(x, y, z) { const ye = y * C(ECL) - z * S(ECL), ze = y * S(ECL) + z * C(ECL); return { ra: norm(Math.atan2(ye, x) * R2D), dec: Math.atan2(ze, Math.hypot(x, ye)) * R2D, dist: Math.hypot(x, y, z) }; }
function geo(i, ms) { const E = helio(PL[2], ms), P = helio(PL[i], ms); return eclToEq(P.x - E.x, P.y - E.y, P.z - E.z); }
function sunEq(ms) { const d = days(ms), g = 357.529 + 0.98560028 * d, lam = 280.460 + 0.9856474 * d + 1.915 * S(g) + 0.020 * S(2 * g); const r = eclToEq(C(lam), S(lam), 0); return { ...r, lam: norm(lam) }; }
function moonEq(ms) {
  const d = days(ms), L = 218.316 + 13.176396 * d, M = 134.963 + 13.064993 * d, F = 93.272 + 13.229350 * d, D = 297.850 + 12.190749 * d, Ms = 357.529 + 0.98560028 * d;
  const lam = L + 6.289 * S(M) + 1.274 * S(2 * D - M) + 0.658 * S(2 * D) + 0.214 * S(2 * M) - 0.186 * S(Ms) - 0.114 * S(2 * F);
  const bet = 5.128 * S(F) + 0.281 * S(M + F) + 0.278 * S(M - F) + 0.173 * S(2 * D - F);
  const r = eclToEq(C(bet) * C(lam), C(bet) * S(lam), S(bet)), age = norm(lam - sunEq(ms).lam) / 360 * 29.530589;
  return { ...r, age, illum: (1 - Math.cos(2 * Math.PI * age / 29.530589)) / 2 };
}
/** 高さ・方位（方位は北から東回り） */
function altaz(ra, dec, ms, lat, lon) {
  const H = gmst(ms) + lon - ra, alt = Math.asin(S(lat) * S(dec) + C(lat) * C(dec) * C(H)) * R2D;
  const az = norm(Math.atan2(-C(dec) * S(H), S(dec) * C(lat) - C(dec) * C(H) * S(lat)) * R2D);
  return { alt, az };
}

/* --- 流星群（極大の太陽黄経・放射点・理想的な空での1時間あたりの数 ZHR の目安） --- */
const SHOWERS = [
  { ja: "しぶんぎ座流星群", lam: 283.15, ra: 230, dec: 49, zhr: 110 },
  { ja: "こと座流星群", lam: 32.32, ra: 271, dec: 34, zhr: 18 },
  { ja: "みずがめ座η流星群", lam: 45.5, ra: 338, dec: -1, zhr: 50 },
  { ja: "みずがめ座δ南流星群", lam: 127, ra: 340, dec: -16, zhr: 25 },
  { ja: "ペルセウス座流星群", lam: 140.0, ra: 48, dec: 58, zhr: 100 },
  { ja: "オリオン座流星群", lam: 208, ra: 95, dec: 16, zhr: 20 },
  { ja: "おうし座南流星群", lam: 220, ra: 52, dec: 15, zhr: 5 },
  { ja: "おうし座北流星群", lam: 230, ra: 58, dec: 22, zhr: 5 },
  { ja: "しし座流星群", lam: 235.27, ra: 152, dec: 22, zhr: 15 },
  { ja: "ふたご座流星群", lam: 262.2, ra: 112, dec: 33, zhr: 150 },
  { ja: "こぐま座流星群", lam: 270.7, ra: 217, dec: 76, zhr: 10 },
];
/** 太陽黄経が lam になる時刻（start 以降で最初）。1日ずつ進めて、通り過ぎた日の中を細かく探す */
function whenSunAt(lam, start) {
  const diff = t => ((sunEq(t).lam - lam + 540) % 360) - 180;   /* −180〜+180：負＝まだ手前 */
  let t = start, d0 = diff(t);
  for (let k = 0; k < 370; k++) { const t2 = t + 86400000, d1 = diff(t2);
    if (d0 < 0 && d1 >= 0 && d1 - d0 < 10) { let a = t, b = t2; for (let j = 0; j < 30; j++) { const m = (a + b) / 2; if (diff(m) < 0) a = m; else b = m; } return (a + b) / 2; }
    t = t2; d0 = d1; }
  return null;
}
function nextShowers(now) { return SHOWERS.map(s => ({ ...s, peak: whenSunAt(s.lam, now - 2 * 86400000) })).filter(s => s.peak).sort((a, b) => a.peak - b.peak); }
/** その時刻に、その場所で1時間に見える数の目安（理想的な暗い空の値から、放射点の高さ・薄明・月で減らす） */
function rate(sh, ms, lat, lon) {
  const r = altaz(sh.ra, sh.dec, ms, lat, lon); if (r.alt <= 0) return { hr: 0, rad: r.alt };
  const sun = altaz(sunEq(ms).ra, sunEq(ms).dec, ms, lat, lon).alt, dark = sun < -18 ? 1 : sun > -6 ? 0 : (-6 - sun) / 12;
  const m = moonEq(ms), ma = altaz(m.ra, m.dec, ms, lat, lon).alt, moonF = ma > 0 ? 1 - 0.7 * m.illum * Math.sin(Math.min(ma, 60) * D2R) / Math.sin(60 * D2R) : 1;
  return { hr: sh.zhr * Math.sin(r.alt * D2R) * dark * moonF, rad: r.alt };
}

/* --- 描画 --- */
let st = null, timer = null, raf = null, meteors = [];
function orrery(ms) {
  const W = 300, c = W / 2, ring = i => 18 + i * 16;   /* 輪は同じ間隔（本物の距離ではない） */
  let g = `<circle cx="${c}" cy="${c}" r="7" fill="#ffd36e"/><circle cx="${c}" cy="${c}" r="12" fill="rgba(255,211,110,.18)"/>`;
  const E = helio(PL[2], ms), pos = PL.map((p, i) => { const h = helio(p, ms), r = ring(i); return { i, x: c + r * Math.cos(h.lon * D2R), y: c - r * Math.sin(h.lon * D2R), p }; });
  for (let i = 0; i < 8; i++) g += `<circle cx="${c}" cy="${c}" r="${ring(i)}" fill="none" stroke="rgba(228,233,244,${i === 2 ? .35 : .14})"/>`;
  const e = pos[2];
  for (const q of pos) if (q.i !== 2) g += `<line x1="${e.x}" y1="${e.y}" x2="${q.x}" y2="${q.y}" stroke="rgba(127,180,255,.18)" stroke-dasharray="2 3"/>`;
  for (const q of pos) { const r = q.i === 2 ? 4.5 : q.i >= 4 && q.i <= 5 ? 4.5 : 3.2;
    if (q.i === 5) g += `<ellipse cx="${q.x}" cy="${q.y}" rx="8" ry="2.6" fill="none" stroke="#e6d39a" stroke-width="1"/>`;
    g += `<circle cx="${q.x}" cy="${q.y}" r="${r}" fill="${q.p[1]}"/>`;
    const rt = q.x < W - 46; g += `<text x="${rt ? q.x + 6 : q.x - 6}" y="${q.y - 5}" fill="${q.i === 2 ? "#cfe0ff" : "#9ca7bf"}" font-size="9" text-anchor="${rt ? "start" : "end"}">${q.p[0]}</text>`; }
  return `<svg viewBox="0 0 ${W} ${W}" width="100%" style="max-width:340px;display:block;margin:0 auto" role="img" aria-label="太陽系の並び（上から見た図）">${g}</svg>`;
}
function skyXY(alt, az, R, c) { const r = (90 - alt) / 90 * R, a = az * D2R; return { x: c - r * Math.sin(a), y: c - r * Math.cos(a) }; }   /* 見上げた図：北が上・東が左 */
function skyDome(ms, place, sh) {
  const W = 300, c = W / 2, R = 132; let g = `<circle cx="${c}" cy="${c}" r="${R}" fill="url(#skyg)" stroke="rgba(228,233,244,.3)"/>`;
  g += `<circle cx="${c}" cy="${c}" r="${R * 2 / 3}" fill="none" stroke="rgba(228,233,244,.08)"/><circle cx="${c}" cy="${c}" r="${R / 3}" fill="none" stroke="rgba(228,233,244,.08)"/>`;
  for (const [t, az] of [["北", 0], ["東", 90], ["南", 180], ["西", 270]]) { const p = skyXY(-6, az, R, c); g += `<text x="${p.x}" y="${p.y + 4}" fill="#9ca7bf" font-size="11" text-anchor="middle">${t}</text>`; }
  const sun = sunEq(ms), sa = altaz(sun.ra, sun.dec, ms, place.lat, place.lon).alt;
  const items = [];
  for (let i = 0; i < 8; i++) if (i !== 2) { const q = geo(i, ms), h = altaz(q.ra, q.dec, ms, place.lat, place.lon); if (h.alt > 0) items.push({ name: PL[i][0], col: PL[i][1], ...h, r: i === 1 || i === 4 ? 3.5 : 2.6 }); }
  const m = moonEq(ms), mh = altaz(m.ra, m.dec, ms, place.lat, place.lon); if (mh.alt > 0) items.push({ name: `月（${Math.round(m.illum * 100)}%）`, col: "#f3f0e2", ...mh, r: 6 });
  if (sa > 0) { const p = altaz(sun.ra, sun.dec, ms, place.lat, place.lon); items.push({ name: "太陽", col: "#ffd36e", ...p, r: 7 }); }
  const placed = [];   /* 名前が重ならないように、近い名前は少しずらす */
  for (const it of items.map(it => ({ ...it, p: skyXY(it.alt, it.az, R, c) })).sort((a, b) => a.p.y - b.p.y)) {
    const p = it.p, right = p.x < W - 70; let ly = p.y + 3;
    while (placed.some(q => Math.abs(q.y - ly) < 11 && Math.abs(q.x - p.x) < 60)) ly += 11;
    placed.push({ x: p.x, y: ly });
    g += `<circle cx="${p.x}" cy="${p.y}" r="${it.r}" fill="${it.col}"/><text x="${right ? p.x + 8 : p.x - 8}" y="${ly}" fill="#cbd3e6" font-size="9.5" text-anchor="${right ? "start" : "end"}">${esc(it.name)}</text>`; }
  let radHtml = "";
  if (sh) { const h = altaz(sh.ra, sh.dec, ms, place.lat, place.lon);
    if (h.alt > 0) { const p = skyXY(h.alt, h.az, R, c); radHtml = `<circle cx="${p.x}" cy="${p.y}" r="9" fill="none" stroke="#c9a7ff" stroke-width="1.5"/><path d="M${p.x - 13} ${p.y}h6M${p.x + 7} ${p.y}h6M${p.x} ${p.y - 13}v6M${p.x} ${p.y + 7}v6" stroke="#c9a7ff"/><text x="${p.x + 12}" y="${p.y - 10}" fill="#c9a7ff" font-size="10">放射点</text>`; st.rad = p; }
    else st.rad = null; }
  const bg = sa > -6 ? "#24406e" : sa > -12 ? "#14254a" : sa > -18 ? "#0b1530" : "#050a18";
  return `<svg viewBox="0 0 ${W} ${W}" width="100%" style="max-width:340px;display:block;margin:0 auto" role="img" aria-label="選んだ場所の空（見上げた図）">
    <defs><radialGradient id="skyg"><stop offset="0" stop-color="${bg}"/><stop offset="1" stop-color="#03050b"/></radialGradient></defs>${g}${radHtml}<g id="meteorLayer"></g></svg>`;
}
function timeline(sh, place, t0) {
  const W = 360, H = 120, n = 72, step = 12 * 3600000 / n, xs = i => 8 + i / n * (W - 16), out = [];
  for (let i = 0; i <= n; i++) { const t = t0 + i * step, r = rate(sh, t, place.lat, place.lon), m = moonEq(t), ma = altaz(m.ra, m.dec, t, place.lat, place.lon).alt, sa = altaz(sunEq(t).ra, sunEq(t).dec, t, place.lat, place.lon).alt; out.push({ t, hr: r.hr, rad: r.rad, ma, sa }); }
  const mx = Math.max(1, ...out.map(o => o.hr));
  let g = "";
  out.forEach((o, i) => { if (i === n) return; const sh2 = o.sa > -6 ? .22 : o.sa > -18 ? .1 : 0; if (sh2) g += `<rect x="${xs(i)}" y="10" width="${(W - 16) / n + .5}" height="${H - 34}" fill="rgba(127,180,255,${sh2})"/>`; });
  out.forEach((o, i) => { if (i === n) return; const h = o.hr / mx * (H - 40); g += `<rect x="${xs(i)}" y="${H - 24 - h}" width="${(W - 16) / n - .6}" height="${h}" fill="#c9a7ff" opacity=".75"/>`; });
  const line = key => out.map((o, i) => `${i ? "L" : "M"}${xs(i).toFixed(1)} ${(H - 24 - Math.max(0, o[key]) / 90 * (H - 40)).toFixed(1)}`).join(" ");
  g += `<path d="${line("rad")}" fill="none" stroke="#c9a7ff" stroke-width="1.2" stroke-dasharray="3 2"/><path d="${line("ma")}" fill="none" stroke="#f3f0e2" stroke-width="1.2" opacity=".7"/>`;
  for (const h of [0, 3, 6, 9, 12]) { const t = t0 + h * 3600000; g += `<text x="${xs(h / 12 * n)}" y="${H - 8}" fill="#67718a" font-size="9" text-anchor="${h === 0 ? "start" : h === 12 ? "end" : "middle"}">${JSTH.format(t)}</text>`; }
  const best = out.reduce((a, b) => b.hr > a.hr ? b : a);
  st.tl = { t0, step, n, W, xs, out };
  return { svg: `<svg id="tlsvg" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="一晩の見えやすさ">${g}<line id="tlcur" x1="0" y1="8" x2="0" y2="${H - 22}" stroke="#8fe3d4" stroke-width="1.5"/></svg>`, best };
}

function render(place) {
  const host = document.getElementById("astro"); if (!host || !place) return;
  const now = Date.now();
  st = st || {}; st.place = place;
  const list = nextShowers(now), sh = st.shower ? list.find(s => s.ja === st.shower) || list[0] : list[0];
  st.shower = sh.ja;
  /* その流星群の極大の夜：極大の日の日本時間 18時から12時間 */
  const pk = sh.peak, jd = new Date(pk + 9 * 3600000); jd.setUTCHours(0, 0, 0, 0);
  let night0 = +jd - 9 * 3600000 + 18 * 3600000; if (pk < night0 - 6 * 3600000) night0 -= 86400000;
  if (st.night0 !== night0) { st.night0 = night0; st.t = null; }
  const tl = timeline(sh, place, night0); if (st.t == null) st.t = tl.best.t;
  const daysTo = Math.round((pk - now) / 86400000);
  host.innerHTML = `
    <div class="th">🔭 アストロノミー（試作）</div>
    <div class="astro-grid">
      <div><div class="mid">太陽系の並び</div>
        <div id="orr">${orrery(st.orrT || now)}</div>
        <input type="range" id="orrSlider" min="-365" max="365" value="${Math.round(((st.orrT || now) - now) / 86400000)}" aria-label="日付を動かす">
        <div class="say" id="orrDate" style="padding-top:2px"></div>
        <div class="say">輪は同じ間隔に縮めて描いています（本物は海王星が地球の30倍遠い）。惑星の向きは本物。点線は地球から見た向き。上から見るとバラバラでも、地球から見ると空の同じ帯に並んで見えます。</div></div>
      <div><div class="mid">流星群の夜</div>
        <select id="shSel" aria-label="流星群を選ぶ">${list.slice(0, 6).map(s => `<option ${s.ja === sh.ja ? "selected" : ""}>${esc(s.ja)}</option>`).join("")}</select>
        <div class="row"><span>いちばん多い夜（目安）</span><span>${JSTMD.format(night0)}の夜〜${JSTMD.format(night0 + 12 * 3600000)}の明け方（${daysTo > 0 ? `あと約${daysTo}日` : daysTo === 0 ? "今日ごろ" : "過ぎたばかり"}）</span></div>
        <div class="row"><span>暗い空での数の目安</span><span>1時間に約${sh.zhr}個（ZHR）</span></div>
        <div id="dome">${skyDome(st.t, place, sh)}</div>
        <input type="range" id="tSlider" min="0" max="${st.tl.out.length - 1}" value="${Math.max(0, Math.min(st.tl.out.length - 1, Math.round((st.t - night0) / st.tl.step)))}" aria-label="時刻を動かす">
        <div class="ctrl"><button type="button" id="play">▶ 一晩を流す</button><span id="tNow" class="tnum"></span></div>
        ${tl.svg}
        <div class="say">紫の棒＝その時刻に見える数の目安（放射点の高さ・薄明・月の明るさから計算）。紫の点線＝放射点の高さ、白い線＝月の高さ、青い帯＝明るい空。いちばん見やすいのは <b>${JSTH.format(tl.best.t)}</b> ごろ（約${Math.round(tl.best.hr)}個/時の目安）。</div>
        <div class="say">流れ星の線は演出です（放射点から飛び出すように描き、数の多さだけ計算を反映）。今夜晴れるかはこのページでは扱いません → <a href="https://www.jma.go.jp/bosai/wdist/" target="_blank" rel="noopener">気象庁の天気分布予報</a>。正確な極大の日時は <a href="https://www.nao.ac.jp/astro/sky/" target="_blank" rel="noopener">国立天文台 ほしぞら情報</a>。</div></div>
    </div>`;
  const setOrr = () => { const d = +document.getElementById("orrSlider").value; st.orrT = now + d * 86400000; document.getElementById("orr").innerHTML = orrery(st.orrT); document.getElementById("orrDate").textContent = `${JSTD.format(st.orrT)} の並び${d ? `（今日から${d > 0 ? d + "日後" : -d + "日前"}）` : "（今日）"}`; };
  document.getElementById("orrSlider").oninput = setOrr; setOrr();
  document.getElementById("shSel").onchange = e => { st.shower = e.target.value; st.night0 = null; stop(); render(place); };
  const setT = i => { const o = st.tl.out[i]; st.t = o.t; document.getElementById("dome").innerHTML = skyDome(st.t, place, sh); document.getElementById("tNow").textContent = `${JSTMD.format(st.t)} ${JSTH.format(st.t)}　見える数の目安 約${o.hr.toFixed(0)}個/時`;
    const x = st.tl.xs(i); const cl = document.getElementById("tlcur"); cl.setAttribute("x1", x); cl.setAttribute("x2", x); st.hr = o.hr; };
  const sl = document.getElementById("tSlider"); sl.oninput = () => setT(+sl.value); setT(+sl.value);
  const stop = () => { clearInterval(timer); timer = null; const b = document.getElementById("play"); if (b) b.textContent = "▶ 一晩を流す"; };
  document.getElementById("play").onclick = () => { if (timer) return stop(); document.getElementById("play").textContent = "■ 止める";
    if (+sl.value >= st.tl.out.length - 1) sl.value = 0;
    timer = setInterval(() => { const v = +sl.value + 1; if (v > st.tl.out.length - 1) return stop(); sl.value = v; setT(v); }, 220); };
  if (!raf) raf = requestAnimationFrame(tick);
}
/* 流れ星の演出：放射点から外へ。数の多さは「見える数の目安」に合わせる（画面の都合で何十倍にも早回し） */
let lastT = 0;
function tick(ts) {
  raf = requestAnimationFrame(tick);
  const layer = document.getElementById("meteorLayer"); if (!layer || !st) return;
  const dt = Math.min(0.1, (ts - lastT) / 1000 || 0); lastT = ts;
  if (st.rad && st.hr > 0 && !matchMedia("(prefers-reduced-motion: reduce)").matches && Math.random() < st.hr * dt / 12) {
    const a = Math.random() * Math.PI * 2, d0 = 15 + Math.random() * 60; meteors.push({ x: st.rad.x + Math.cos(a) * d0, y: st.rad.y + Math.sin(a) * d0, a, life: 0, len: 22 + Math.random() * 30 }); }
  meteors = meteors.filter(m => (m.life += dt) < 0.7);
  layer.innerHTML = meteors.map(m => { const f = m.life / 0.7, x2 = m.x + Math.cos(m.a) * m.len * f * 2, y2 = m.y + Math.sin(m.a) * m.len * f * 2, x1 = x2 - Math.cos(m.a) * m.len, y1 = y2 - Math.sin(m.a) * m.len;
    if (Math.hypot(x2 - 150, y2 - 150) > 132) return ""; return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="rgba(255,255,255,${(1 - f) * .9})" stroke-width="1.4" stroke-linecap="round"/>`; }).join("");
}
window.Astro = { render, _test: { geo, helio, nextShowers, rate, moonEq, altaz } };
})();
