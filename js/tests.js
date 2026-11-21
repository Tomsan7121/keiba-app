// app/tests.html から実行するテスト。結果は textContent で表示する。
import { validatePredictionText, validateStatsText, validateRecordText, places, levelOf, starsOf } from './validate.js';
import { combos, allocate, payoutYen } from './bets.js';
import { KEY, loadFiles, prepareImport, commitImport, sha256Hex, MAX_FILES, STATS_KEY, saveStats, loadStats, isStatsText,
  RECORD_KEY, saveRecord, loadRecord, isRecordText } from './store.js';
import { el, pct, render, state, ITEM_LABEL, budgetOf, demoRecordOf } from './app.js';
import { summarizeRecord, inPlace } from './record.js';

const results = [];
async function t(name, fn) {
  try { await fn(); results.push([true, name]); } catch (e) { results.push([false, name + ' … ' + (e && e.message ? e.message : e)]); }
}
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg || ''} 期待 ${JSON.stringify(b)} / 実際 ${JSON.stringify(a)}`); }
function ok(c, msg) { if (!c) throw new Error(msg || '条件が成り立たない'); }

async function main() {
  const ev = await (await fetch('./expected_values.json', { cache: 'no-cache' })).json();
  const demoText = await (await fetch('./data/demo.json', { cache: 'no-cache' })).text();
  const demo = JSON.parse(demoText);
  const saved = (() => { try { return localStorage.getItem(KEY); } catch (e) { return null; } })();

  // 1. JSON の検査：期待値の 16 例（pipeline の Python と同じ結果）
  for (const c of ev.json_validation) {
    await t('JSON検査：' + c.name, () => {
      const r = validatePredictionText(c.text);
      eq([r.ok, r.code, r.path], [c.ok, c.code, c.path]);
    });
  }
  await t('JSON検査：16 例そろっている', () => eq(ev.json_validation.length, 16));
  await t('JSON検査：5MB を超えると E_SIZE', () => eq(validatePredictionText(' '.repeat(5000001)).code, 'E_SIZE'));
  await t('JSON検査：文字列以外は受け付けない', () => eq(validatePredictionText(null).ok, false));

  // 2. 計算
  await t('払戻対象の頭数 places', () => eq([places(16), places(8), places(7), places(5), places(4)], [3, 3, 2, 2, 1]));
  await t('自信度の段階', () => eq([levelOf(0.8, 0.78), levelOf(0.7, 0.78), levelOf(0.6, 0.78), levelOf(null, 0.78)], ['high', 'mid', 'low', 'none']));
  await t('正規化の期待値（パーセント1桁で一致）', () => {
    const n = ev.normalize[0];
    eq(pct(n.confidence), (n.confidence * 100).toFixed(1) + '%');
    eq(pct(Number.NaN), '—');
  });
  await t('指標の期待値の表示（的中率をパーセント1桁）', () => eq(pct(ev.metrics.result.conf_place_rate), (ev.metrics.result.conf_place_rate * 100).toFixed(1) + '%'));

  // 3. デモデータ
  await t('デモ JSON が検査に通る', () => { const r = validatePredictionText(demoText); ok(r.ok, `${r.code} ${r.path}`); });
  await t('デモ JSON は kind=demo・架空と明記', () => { eq(demo.kind, 'demo'); ok(String(demo.source).includes('架空')); });
  await t('デモの全馬に11項目の根拠と説明文がある', () => {
    for (const r of demo.races) for (const h of r.horses) for (const k of Object.keys(ITEM_LABEL)) ok(h.items[k] && typeof h.items[k].t === 'string' && h.items[k].t.length > 0, `${r.race_id} ${h.umaban} ${k}`);
  });
  await t('デモに自信：高のレースと対象外以外の段階がある', () => ok(demo.races.some((r) => r.confidence.level === 'high')));

  // 4. 保存データ（項目ごとに検査）
  await t('保存データ：壊れた JSON 全体は消して件数を返す', () => {
    localStorage.setItem(KEY, '{壊れた');
    const r = loadFiles();
    eq([r.files.length, r.removed], [0, 1]);
    eq(localStorage.getItem(KEY), null);
  });
  await t('保存データ：1件だけ壊れていたらそれだけ消す', async () => {
    const id = await sha256Hex(demoText);
    const good = { id, imported_at: '2026-11-20T12:00:00Z', generated_at: demo.generated_at, dates: [...new Set(demo.races.map((r) => r.date))].sort(), data: demo };
    const badData = JSON.parse(demoText); badData.races[0].horses[0].p_place = 2;
    const bad = { ...good, id: 'a'.repeat(64), data: badData };
    const badId = { ...good, id: 'xyz' };
    localStorage.setItem(KEY, JSON.stringify([good, bad, badId, null, 5]));
    const r = loadFiles();
    eq([r.files.length, r.removed], [1, 4]);
    eq(JSON.parse(localStorage.getItem(KEY)).length, 1);
  });
  await t('取り込み：同じファイルは重複と判定', async () => {
    const files = loadFiles().files;
    const p = await prepareImport(demoText, files);
    eq(p.status, 'duplicate');
  });
  await t('取り込み：壊れたファイルはコードと場所を返し、保存しない', async () => {
    const before = localStorage.getItem(KEY);
    const p = await prepareImport('{"schema":', []);
    eq([p.status, p.code, p.path], ['invalid', 'E_PARSE', '$']);
    eq(localStorage.getItem(KEY), before);
  });
  await t('取り込み：同じ日付は置き換え候補、上限 8 を超えると確認が必要', async () => {
    const other = JSON.parse(demoText); other.generated_at = '2026-11-21T22:00:00+09:00';
    const text = JSON.stringify(other);
    const files = loadFiles().files;
    const p = await prepareImport(text, files);
    eq([p.status, p.replaces.length], ['ready', 1]);
    const many = Array.from({ length: MAX_FILES }, (_, i) => ({ id: String(i).padStart(64, '0'), dates: [`2026-01-0${i + 1}`], data: demo }));
    const p2 = await prepareImport(text, many);
    eq(p2.overLimit, true);
    const next = commitImport(files, p);
    eq(next.length, 1);
    eq(next[0].generated_at, '2026-11-21T22:00:00+09:00');
  });

  // 5. 表示の安全（外部の文字は textContent）
  await t('HTML タグを含む名前は文字として表示される', () => {
    const box = el('div', {}, '<img src=x onerror=alert(1)>');
    eq(box.querySelectorAll('img').length, 0);
    eq(box.textContent, '<img src=x onerror=alert(1)>');
  });
  await t('レース詳細の描画：HTMLタグの馬名でも要素が増えない・免責が出る', () => {
    const d = JSON.parse(demoText);
    d.races[0].horses[0].name = '<img src=x>';
    state.demo = d; state.files = []; state.useDemo = true;
    location.hash = '#/race/' + d.races[0].race_id;
    render();
    const main = document.getElementById('main');
    eq(main.querySelectorAll('img').length, 0);
    ok(main.textContent.includes('<img src=x>'));
    ok(main.textContent.includes('的中を保証するものではありません'));
    ok(main.textContent.includes('20歳未満'));
    eq(main.querySelectorAll('details.horse').length, d.races[0].horses.length);
  });
  await t('成績画面：的中率・区間・レース数・回収率・1番人気を並べる', () => {
    location.hash = '#/stats';
    render();
    const txt = document.getElementById('main').textContent;
    for (const w of ['複勝的中率', '95%区間', 'レース数', '回収率', '1番人気の複勝率', '架空']) ok(txt.includes(w), w);
  });
  await t('R1：デモの成績欄は架空の数字だけ（実データの集計を入れない）・「デモの数字です」と出る', () => {
    eq(demo.backtest.stats_source, 'synthetic');
    ok(!demoText.includes('validation_2026') && !demoText.includes('odds_only'));
    state.demo = demo; state.files = []; state.useDemo = true; state.stats = null;
    location.hash = '#/stats';
    render();
    const txt = document.getElementById('main').textContent;
    ok(txt.includes('デモの数字です'));
    ok(!txt.includes('2026年の検証'));
  });
  const statsObj = {
    schema: 'keiba-stats/v1', kind: 'stats', generated_at: '2026-11-19T21:00:00+09:00', model_version: 'm1-test', source: 'JRDB（取り込んだ実データ）',
    backtest_2025: { period: '2025年（前向き検証）', n_races: 100, n_conf: 10, conf_place_rate: 0.8, conf_ci_low: 0.5, conf_ci_high: 0.9, conf_place_return: 0.9 },
    validation_2026: { period: '2026年の検証', n_races: 90, n_conf: 9, conf_place_rate: 0.7777, conf_ci_low: 0.4, conf_ci_high: 0.9, all_place_rate: 0.6, all_win_rate: 0.3, all_place_return: 0.8 },
    odds_only: { method: 'テスト', source: 'テスト', rows: [{ label: '2026年・上位9%', n: 9, rate: 0.6, ci_low: 0.3, ci_high: 0.8, ret: 0.85 }] },
    trio: { scheme: 'a', rows: [{ key: 'a', label: '本命を軸に 2〜4 位へ流す（3 点）', period: '2025年（前向き検証）', n_races: 10, hit_rate: 0.3, roi: 0.852, roi_ci_low: 0.6, roi_ci_high: 1.04, avg_pay_when_hit: 754, max_pay: 2920, roi_without_max: 0.821, monthly_roi_min: 0.3, monthly_roi_max: 1.2 }] },
    notes: ['本命はほぼ1番人気です（テスト）', '2025年の数字は34通りから選んだ後（テスト）'],
  };
  await t('成績ファイル（keiba-stats/v1）：正しいものは通り、範囲外・形違いは止める', () => {
    ok(validateStatsText(JSON.stringify(statsObj)).ok);
    eq(validateStatsText(JSON.stringify({ ...statsObj, schema: 'x' })).code, 'E_SCHEMA');
    const bad = JSON.parse(JSON.stringify(statsObj)); bad.validation_2026.conf_place_rate = 1.5;
    eq(validateStatsText(JSON.stringify(bad)).path, '$.validation_2026.conf_place_rate');
    const bad2 = JSON.parse(JSON.stringify(statsObj)); bad2.trio.rows[0].key = 'z';
    eq(validateStatsText(JSON.stringify(bad2)).path, '$.trio.rows[0]');
  });
  await t('成績ファイルの保存と読み込み（端末の中だけ・壊れたものは消す）', () => {
    const bak = localStorage.getItem(STATS_KEY);
    try {
      ok(isStatsText(JSON.stringify(statsObj)) && !isStatsText(demoText));
      ok(saveStats(JSON.stringify(statsObj)).ok);
      eq(loadStats().stats.model_version, 'm1-test');
      eq(saveStats('{"schema":"keiba-stats/v1"}').ok, false);
      localStorage.setItem(STATS_KEY, '{"schema":"keiba-stats/v1","kind":"x"}');
      eq(loadStats(), { stats: null, removed: 1 });
      eq(localStorage.getItem(STATS_KEY), null);
    } finally {
      if (bak === null) localStorage.removeItem(STATS_KEY); else localStorage.setItem(STATS_KEY, bak);
    }
  });
  await t('N8：予想 JSON の成績欄も検査する（率が 1 を超えると止める）', () => {
    const d2 = JSON.parse(demoText); d2.backtest.conf_place_rate = 3;
    eq(validatePredictionText(JSON.stringify(d2)).path, '$.backtest.conf_place_rate');
  });
  await t('M2・R1：取り込んだ成績ファイルがあれば「取り込んだ実データ」として 2026 年・オッズだけ・三連複・注記を出す', () => {
    state.stats = statsObj;
    location.hash = '#/stats';
    render();
    const txt = document.getElementById('main').textContent;
    for (const w of ['取り込んだ実データ', '2026年の検証', 'オッズだけで選んだ場合との比較', '三連複', '購入を勧めるものではありません', '検証に回す組み方', 'ほぼ1番人気', '34通り', '77.8%', '85.2%']) ok(txt.includes(w), w);
    ok(!txt.includes('デモの数字です'));
    for (const w of ['買い', 'おすすめ']) ok(!txt.includes(w), w);
    state.stats = null;
  });
  await t('上位5頭：一覧と詳細に出る・JSON の top5 は horses と一致しないと止める', () => {
    state.demo = demo; state.files = []; state.useDemo = true;
    const r0 = demo.races[0];
    eq(r0.top5.length, Math.min(5, r0.horses.length));
    location.hash = '#/races'; state.onlyHigh = false; state.dateSel = r0.date;
    render();
    ok(document.getElementById('main').textContent.includes('上位5頭'));
    location.hash = '#/race/' + r0.race_id;
    render();
    const main = document.getElementById('main');
    eq(main.querySelectorAll('.top5 li').length, r0.top5.length);
    ok(main.textContent.includes(r0.top5[0].name));
    const d2 = JSON.parse(demoText); d2.races[0].top5[1].umaban = d2.races[0].top5[0].umaban;
    eq(validatePredictionText(JSON.stringify(d2)).path, '$.races[0].top5[1].umaban');
    const d3 = JSON.parse(demoText); d3.races[0].is_conf = !d3.races[0].is_conf;
    eq(validatePredictionText(JSON.stringify(d3)).code, 'E_CONSIST');
    const d4 = JSON.parse(demoText); for (const r of d4.races) { delete r.top5; delete r.is_conf; }
    ok(validatePredictionText(JSON.stringify(d4)).ok);   // 古いファイル（top5 なし）も受け付ける
  });
  await t('N9：デモのレースは 2099 年（実在しうる番号にしない）', () => { ok(demo.races.every((r) => r.race_id.startsWith('2099') && r.date.startsWith('2099'))); });
  await t('L21：デモの model_version は凍結版に合わせてある', () => { eq(demo.model_version, 'm1-20261119'); });
  await t('L20：アイコンは any 用と maskable 用を分けている', async () => {
    const m = await (await fetch('./manifest.webmanifest', { cache: 'no-cache' })).json();
    ok(m.icons.every((i) => i.purpose === 'any' || i.purpose === 'maskable'));
    ok(m.icons.some((i) => i.purpose === 'maskable') && m.icons.some((i) => i.purpose === 'any'));
    for (const i of m.icons) eq((await fetch('./' + i.src, { cache: 'no-cache' })).status, 200);
  });
  await t('一覧画面：日付と自信度の段階が出る', () => {
    location.hash = '#/races';
    render();
    const main = document.getElementById('main');
    ok(main.querySelectorAll('.racecard').length > 0);
    ok(main.textContent.includes('デモ'));
  });

  // 6. 5つ星・組み合わせ・券種ごとの成績（2026-11-20）
  await t('星：境目 4 つで ★1〜★5（下限を含む）', () => {
    const c = [0.2, 0.4, 0.6, 0.8];
    eq([0.1, 0.2, 0.39, 0.4, 0.6, 0.79, 0.8, 0.99].map((s) => starsOf(s, c)), [1, 2, 2, 3, 4, 4, 5, 5]);
    eq(starsOf(null, c), null);
  });
  await t('星：デモは ★1〜★5 がそろい、JSON の星と確率が合わないと止める', () => {
    eq([...new Set(demo.races.map((r) => r.stars))].sort(), [1, 2, 3, 4, 5]);
    const d2 = JSON.parse(demoText); d2.races[0].stars = d2.races[0].stars === 5 ? 1 : 5;
    eq(validatePredictionText(JSON.stringify(d2)).path, '$.races[0].stars');
    const d3 = JSON.parse(demoText); d3.stars_cuts = [0.9, 0.1, 0.2, 0.3];
    eq(validatePredictionText(JSON.stringify(d3)).path, '$.stars_cuts');
    const d4 = JSON.parse(demoText); delete d4.stars_cuts; for (const r of d4.races) delete r.stars;
    ok(validatePredictionText(JSON.stringify(d4)).ok);   // 星のない古いファイルも受け付ける
    // 境目ちょうど（丸めで同じ値）なら両側を認める（N12）
    const d5 = JSON.parse(demoText); const r5 = d5.races[0]; const tp = r5.horses.find((h) => h.rank === 1).p_place;
    d5.races = [r5]; d5.stars_cuts = [0.01, 0.02, 0.03, tp]; r5.stars = 4;
    ok(validatePredictionText(JSON.stringify(d5)).ok);
  });
  await t('星：一覧に星が出て「★4以上だけ」で絞れる・「自信：高」の文字は出ない', () => {
    state.demo = demo; state.files = []; state.useDemo = true; state.dateSel = demo.races[0].date;
    location.hash = '#/races'; state.onlyHigh = false; render();
    let main = document.getElementById('main');
    eq(main.querySelectorAll('.racecard .stars').length, demo.races.length);
    ok(!main.textContent.includes('自信：高'));
    state.onlyHigh = true; render(); main = document.getElementById('main');
    eq(main.querySelectorAll('.racecard').length, demo.races.filter((r) => r.stars >= 4).length);
    state.onlyHigh = false;
  });
  await t('組み合わせの数え方（点数）', () => {
    const n = (ty, m, s) => combos(ty, m, s).combos.length;
    eq(n('tan', 'single', { picks: [1, 2, 3] }), 3);
    eq(n('umaren', 'box', { picks: [1, 2, 3, 4, 5] }), 10);       // 5C2
    eq(n('wide', 'box', { picks: [1, 2, 3] }), 3);
    eq(n('umatan', 'box', { picks: [1, 2, 3] }), 6);              // 3P2
    eq(n('trio', 'box', { picks: [1, 2, 3, 4, 5] }), 10);         // 5C3
    eq(n('tri', 'box', { picks: [1, 2, 3, 4] }), 24);             // 4P3
    eq(n('tri', 'box', { picks: Array.from({ length: 18 }, (_, i) => i + 1) }), 4896);
    eq(n('umaren', 'nagashi', { axis: [1], partners: [1, 2, 3, 4] }), 3);   // 軸と同じ馬は相手に数えない
    eq(n('umatan', 'nagashi', { axis: [1], partners: [2, 3, 4] }), 3);
    eq(n('trio', 'nagashi', { axis: [1], partners: [2, 3, 4, 5, 6] }), 10); // 5C2
    eq(n('trio', 'nagashi', { axis: [1, 2], partners: [3, 4, 5, 6] }), 4);
    eq(n('tri', 'nagashi', { axis: [1], partners: [2, 3, 4, 5, 6] }), 20);  // 5P2
    eq(n('tri', 'nagashi', { axis: [1, 2], partners: [3, 4, 5] }), 3);
    eq(combos('umaren', 'nagashi', { axis: [1, 2], partners: [3] }).ok, false);   // 2頭の券種の軸は1頭まで
    eq(n('tri', 'formation', { cols: [[1, 2], [1, 2, 3], [1, 2, 3, 4]] }), 8);    // 1-2-3,1-2-4,1-3-2,1-3-4,2-1-3,2-1-4,2-3-1,2-3-4
    eq(n('trio', 'formation', { cols: [[1], [2, 3], [2, 3, 4]] }), 3);            // 1-2-3 と 1-3-2 は同じ 1 点
    eq(n('umatan', 'formation', { cols: [[1, 2], [1, 2]] }), 2);
    eq(combos('umatan', 'nagashi', { axis: [3], partners: [1, 2] }).combos, [[3, 1], [3, 2]]);   // 着順の順のまま
    eq(combos('trio', 'box', { picks: [5, 1, 3] }).combos, [[1, 3, 5]]);
    eq(combos('tan', 'box', { picks: [1] }).ok, false);
  });
  await t('組み合わせ画面：詳細から開き、選ぶと点数と一覧・モデル順位が出る。購入・外部リンクなし、免責あり', () => {
    state.demo = demo; state.files = []; state.useDemo = true;
    const r0 = demo.races[0];
    location.hash = '#/race/' + r0.race_id; render();
    ok(document.querySelector(`a[href="#/build/${r0.race_id}"]`), '詳細に入口');
    location.hash = '#/build/' + r0.race_id; render();
    let main = document.getElementById('main');
    ok(main.textContent.includes('購入を勧めるものではありません'));
    const boxes = [...main.querySelectorAll('table.pick input[type=checkbox]')];
    eq(boxes.length, r0.horses.length);                          // 馬連・ボックス：1 列
    for (const b of boxes.slice(0, 3)) { b.checked = true; b.dispatchEvent(new Event('change')); }
    main = document.getElementById('main');
    ok(main.textContent.includes('馬連・ボックス：3 点'), main.querySelector('.points') && main.querySelector('.points').textContent);
    eq(main.querySelectorAll('.combos li').length, 3);
    ok(main.querySelector('.combos li').textContent.includes('モデル'));
    ok([...main.querySelectorAll('a')].every((a) => (a.getAttribute('href') || '').startsWith('#')), '外部リンクなし');
    for (const w of ['買い', 'おすすめ', '購入する']) ok(!main.textContent.includes(w), w);
    ok(main.textContent.includes('20歳未満'));
    state.build = null;
  });
  await t('成績：デモは ★5・★4・合算 × 券種の表（架空の数字）と「デモの数字です」', () => {
    state.demo = demo; state.stats = null;
    location.hash = '#/stats'; render();
    const main = document.getElementById('main');
    const txt = main.textContent;
    for (const w of ['デモの数字です', '★5のみ', '★4のみ', '★4＋★5', '参考：旧しきい値', '単勝：本命', '三連単', 'オッズ順で同じ形', '購入を勧めるものではありません']) ok(txt.includes(w), w);
    eq(main.querySelectorAll('table.bets').length, 8);   // 券種の表 4 区分 ＋ 資金配分の表 4 区分
    for (const w of ['買い', 'おすすめ']) ok(!txt.includes(w), w);
  });
  await t('N11：取り込み画面に成績ファイルが出て、それだけを消せる', () => {
    const bak = localStorage.getItem(STATS_KEY);
    try {
      saveStats(JSON.stringify(statsObj)); state.stats = loadStats().stats;
      location.hash = '#/import'; render();
      const main = document.getElementById('main');
      ok(main.textContent.includes('実データの成績'));
      const orig = window.confirm; window.confirm = () => true;
      try {
        const btn = [...main.querySelectorAll('.files button')].find((b) => b.closest('ul').previousElementSibling.textContent.includes('成績ファイル'));
        btn.click();
      } finally { window.confirm = orig; }
      eq(state.stats, null);
      eq(localStorage.getItem(STATS_KEY), null);
    } finally {
      if (bak === null) localStorage.removeItem(STATS_KEY); else localStorage.setItem(STATS_KEY, bak);
      state.stats = null;
    }
  });
  await t('N8：成績欄の券種の表も検査する', () => {
    const d2 = JSON.parse(demoText); d2.backtest.bets[0].segments[0].rows[0].roi = -1;
    eq(validatePredictionText(JSON.stringify(d2)).path, '$.backtest.bets[0].segments[0].rows[0].roi');
    eq(validateStatsText(JSON.stringify({ ...statsObj, bets: [{ period: 'x', segments: [{ key: 'zz', label: 'x', rows: [] }] }] })).path, '$.bets[0].segments[0]');
  });
  await t('資金配分：口数の計算（pipeline/stake.py と同じ規則）', () => {
    eq(allocate([2.0, 5.0, 10.0], 3000).units, [15, 6, 3]);
    eq(allocate([2.0, 5.0, 10.0], 3000, true).units, [17, 8, 5]);
    eq(allocate([1.5, 1.8, 2.0], 3000), { units: [0, 0, 0], ok: false });
    eq(allocate([1.5, 1.8, 2.0], 3000, false, 'drop').units, [0, 0, 15]);
    eq(allocate([1.5, 1.8, 2.0], 3000, true, 'drop').units, [0, 0, 30]);
    eq(allocate([null, 10.0, 20.0], 3000, true).units, [0, 16, 14]);
    eq(allocate([null], 3000).units, [30]);
    const od = [3.3, 3.4, 3.5, 9.9, 12.0, 80.0];
    const u = allocate(od, 3000).units;
    ok(u.every((n, i) => !n || od[i] * 100 * n >= 3000) && 100 * u.reduce((a, b) => a + b, 0) <= 3000);
  });
  await t('資金配分：組み合わせ画面でオッズを入れると口数と合計が出る（購入・リンクなし）', () => {
    state.demo = demo; state.useDemo = true; state.build = null;
    const r0 = demo.races[0];
    location.hash = '#/build/' + r0.race_id; render();
    let boxes = [...document.querySelectorAll('table.pick input[type=checkbox]')];
    for (const b of boxes.slice(0, 3)) { b.checked = true; b.dispatchEvent(new Event('change')); }
    let main = document.getElementById('main');
    ok(main.textContent.includes('予算とオッズから口数を計算する'));
    ok(main.textContent.includes('トリガミ') && main.textContent.includes('購入を勧めるものではありません'));
    const vals = [2.0, 5.0, 10.0];
    for (let i = 0; i < 3; i++) {
      const inp = document.querySelectorAll('table.stake input')[i];
      inp.value = String(vals[i]); inp.dispatchEvent(new Event('change'));
    }
    main = document.getElementById('main');
    const cells = [...main.querySelectorAll('table.stake tbody tr')].map((tr) => tr.children[2].textContent);
    eq(cells, ['17口', '8口', '5口']);                       // W3：初期設定は L1（残りを足す）
    ok(main.textContent.includes('合計 3,000円'));
    ok([...main.querySelectorAll('a')].every((a) => (a.getAttribute('href') || '').startsWith('#')));
    state.build = null;
  });
  await t('W1：「当たったとき」は整数で計算（1.2倍×3口＝360円）。1.0〜200.0倍×1〜300口で 1 円もずれない', () => {
    eq(payoutYen(1.2, 3), 360);
    eq(payoutYen(12.3, 3), 3690);
    let bad = 0;
    for (let t = 10; t <= 2000; t++) for (let u = 1; u <= 300; u++) if (payoutYen(t / 10, u) !== t * u * 10) bad++;
    eq(bad, 0);
    state.demo = demo; state.useDemo = true; state.build = null;
    const r0 = demo.races[0];
    location.hash = '#/build/' + r0.race_id; render();
    [...document.querySelectorAll('.chips button')].find((x) => x.textContent === '単勝').click();
    const pk = document.querySelector('table.pick tbody input[type=checkbox]');
    pk.checked = true; pk.dispatchEvent(new Event('change'));
    const bi = document.querySelector('.stakebox input[type=number]');
    bi.value = '300'; bi.dispatchEvent(new Event('change'));
    const oi = document.querySelector('table.stake input');
    oi.value = '1.2'; oi.dispatchEvent(new Event('change'));
    const tr = document.querySelector('table.stake tbody tr');
    eq([tr.children[2].textContent, tr.children[4].textContent], ['3口', '360円']);   // 以前は 359円
    state.build = null;
  });
  await t('W2：予算の範囲外・空欄・端数は知らせる（範囲外は前の予算のまま）', () => {
    eq(budgetOf('5000', 3000), { budget: 5000, msg: '' });
    for (const raw of ['50', '20000000', '', 'abc', '-100']) {
      const r = budgetOf(raw, 3000);
      eq(r.budget, 3000); ok(r.msg.includes('前の 3,000円 のまま'), raw);
    }
    const f = budgetOf('3050', 3000); eq(f.budget, 3000); ok(f.msg.includes('切り捨て'));
    state.demo = demo; state.useDemo = true; state.build = null;
    const r0 = demo.races[0];
    location.hash = '#/build/' + r0.race_id; render();
    for (const b of [...document.querySelectorAll('table.pick input[type=checkbox]')].slice(0, 3)) { b.checked = true; b.dispatchEvent(new Event('change')); }
    const bi = document.querySelector('.stakebox input[type=number]');
    bi.value = '50'; bi.dispatchEvent(new Event('change'));
    const msg = document.querySelector('.budgetmsg');
    ok(msg && msg.textContent.includes('範囲外'));
    eq(state.build.budget, 3000);
    state.build = null;
  });
  await t('V1：三連複の流しで軸が2頭そろうと、ほかの馬の軸は選べず、説明が出る（知らせなしに外さない）', () => {
    state.demo = demo; state.useDemo = true; state.build = null;
    const r0 = demo.races[0];
    location.hash = '#/build/' + r0.race_id; render();
    [...document.querySelectorAll('.chips button')].find((x) => x.textContent === '三連複').click();
    [...document.querySelectorAll('.chips button')].find((x) => x.textContent === '流し').click();
    const axisBox = (i) => document.querySelectorAll('table.pick tbody tr')[i].children[1].querySelector('input');
    for (const i of [0, 1]) { const b = axisBox(i); b.checked = true; b.dispatchEvent(new Event('change')); }
    eq(state.build.axis.length, 2);
    const third = axisBox(2);
    ok(third.disabled, '3頭目の軸は選べない');
    third.dispatchEvent(new Event('change'));               // 無理に押しても外れない
    eq(state.build.axis.length, 2);
    ok(document.querySelector('.axisnote').textContent.includes('軸は 2 頭まで'));
    state.build = null;
  });
  await t('V2：デモの架空の数字は互いに合う（単勝の的中率＝本命の1着率、複勝＝複勝率、合算＝★5＋★4、単勝・複勝はトリガミ0、購入額＝買ったレース×3,000円）', () => {
    const bl = demo.backtest.bets[0].segments; const sk = demo.backtest.stake[0].segments;
    const seg = (a, k) => a.find((s) => s.key === k);
    const row = (s, b, basis) => s.rows.find((r) => r.bet === b && (!basis || r.basis === basis));
    for (const s of bl) {
      eq(row(s, 'tan', 'model').hit_rate, s.honmei_win_rate);
      eq(row(s, 'fuku', 'model').hit_rate, s.honmei_place_rate);
      for (const r of s.rows) ok(r.roi_ci_low <= r.roi && r.roi <= r.roi_ci_high && r.n_races === s.n_races, s.key + r.bet);
    }
    eq(seg(bl, 's45').n_races, seg(bl, 's5').n_races + seg(bl, 's4').n_races);
    for (const s of sk) {
      for (const r of s.rows) {
        ok(Math.abs(r.pay_yen / r.cost_yen - r.roi) < 1e-4, s.key + r.bet);
        if (r.bet === 'tan' || r.bet === 'fuku') { eq(r.n_trigami, 0); eq(r.cost_yen, (r.n_races - r.n_skipped) * 3000); }
        ok(r.cost_yen <= (r.n_races - r.n_skipped) * 3000);
        const b = row(seg(bl, s.key), r.bet, 'model');
        eq(r.n_races, b.n_races);
        if (r.bet === 'tan' || r.bet === 'fuku') eq(r.hit_rate, b.hit_rate);
      }
      for (const b of ['tan', 'fuku', 'umaren', 'umatan', 'trio', 'tri']) {
        eq(row(seg(sk, 's45'), b).cost_yen, row(seg(sk, 's5'), b).cost_yen + row(seg(sk, 's4'), b).cost_yen);
        eq(row(seg(sk, 's45'), b).pay_yen, row(seg(sk, 's5'), b).pay_yen + row(seg(sk, 's4'), b).pay_yen);
      }
    }
  });
  await t('資金配分：成績画面に表（デモは架空）・トリガミの注記', () => {
    state.stats = null; location.hash = '#/stats'; render();
    const txt = document.getElementById('main').textContent;
    for (const w of ['資金配分の成績', '架空データ', 'トリガミ', '見送り']) ok(txt.includes(w), w);
    const d2 = JSON.parse(demoText); d2.backtest.stake[0].budget = 10;
    eq(validatePredictionText(JSON.stringify(d2)).path, '$.backtest.stake[0].budget');
  });
  await t('N14：入口は読み込みに失敗したとき案内を出す（動的 import と catch）', async () => {
    const src = await (await fetch('./js/main.js', { cache: 'no-store' })).text();
    ok(src.includes("import('./app.js')") && src.includes('.catch('));
  });

  // 5b. 04_test_report の指摘の再現テスト
  await t('B3：generated_at が数値の保存データは起動時に消す', async () => {
    const id = await sha256Hex(demoText);
    localStorage.setItem(KEY, JSON.stringify([{ id, imported_at: 'x', generated_at: 123, dates: ['2026-11-22'], data: demo }]));
    const r = loadFiles();
    eq([r.files.length, r.removed], [0, 1]);
  });
  await t('B3：壊れた保存データが画面に届いても、取り込み画面に「消す」ボタンと免責が出る', () => {
    state.files = [{ id: 'z'.repeat(64), imported_at: 'x', generated_at: 123, dates: null, data: { races: null } }];
    state.useDemo = true;
    location.hash = '#/import';
    render();
    const main = document.getElementById('main');
    ok([...main.querySelectorAll('button')].some((b) => b.textContent.includes('すべての予想と成績ファイルを端末から消す')), '全部消すボタン');
    ok(main.textContent.includes('20歳未満'), '免責');
    state.files = [];
  });
  await t('L1：top_reasons が配列でない JSON は E_FIELD', () => {
    const o = JSON.parse(demoText); o.races[0].horses[0].top_reasons = 1;
    const r = validatePredictionText(JSON.stringify(o));
    eq([r.ok, r.code, r.path], [false, 'E_FIELD', '$.races[0].horses[0].top_reasons']);
    const o2 = JSON.parse(demoText); o2.races[0].horses[0].extras = { x: 3 };
    eq(validatePredictionText(JSON.stringify(o2)).code, 'E_FIELD');
  });
  await t('L2：壊れた URL でも「見つかりません」と免責が出る', () => {
    state.demo = demo; state.useDemo = true;
    location.hash = '#/race/%E0%A4%A';
    render();
    const txt = document.getElementById('main').textContent;
    ok(txt.includes('レースが見つかりません'));
    ok(txt.includes('的中を保証するものではありません'));
  });
  await t('L3：取り込み成功のメッセージが画面の作り直しのあとも出る', () => {
    state.flash = '取り込みました（テスト）。';
    location.hash = '#/import';
    render();
    ok(document.getElementById('main').textContent.includes('取り込みました（テスト）。'));
    eq(state.flash, '');
  });

  // 5c. 実戦の記録（keiba-record/v1、2026-11-21）
  const savedRec = (() => { try { return localStorage.getItem(RECORD_KEY); } catch (e) { return null; } })();
  const demoRec = demo.demo_record;
  const recText = JSON.stringify(demoRec);
  const realRec = () => { const o = JSON.parse(recText); o.kind = 'record'; o.source = 'テスト（実戦の記録）'; return o; };
  await t('記録：デモ JSON に架空の記録（kind=demo・2099年・馬名はデモ）があり、検査に通る', () => {
    ok(demoRec && demoRec.kind === 'demo', 'demo_record');
    const r = validateRecordText(recText); ok(r.ok, `${r.code} ${r.path}`);
    ok(demoRec.races.every((x) => x.date.startsWith('2099') && x.honmei_name.startsWith('デモ')));
    ok(!('summary' in demoRec), 'デモに集計は入れない（明細から計算）');
  });
  await t('記録の検査：形・範囲・食い違い・後出し・並び・大きさを止める', () => {
    const bad = (fn) => { const o = JSON.parse(recText); fn(o); return validateRecordText(JSON.stringify(o)); };
    eq(bad((o) => { o.schema = 'x'; }).code, 'E_SCHEMA');
    eq(bad((o) => { o.races[0].stars = 6; }).path, '$.races[0].stars');
    const i = demoRec.races.findIndex((x) => x.bets.tri);
    eq(bad((o) => { o.races[i].bets.tri.cost = 700; }).path, `$.races[${i}].bets.tri.cost`);
    const j = demoRec.races.findIndex((x) => x.status === 'ok' && x.honmei_finish !== 1 && x.bets.tan);
    eq(bad((o) => { o.races[j].bets.tan.pay = 500; }).path, `$.races[${j}].bets.tan`);
    eq(bad((o) => { o.days[0].pred_generated_at = o.days[0].date + 'T10:00:00+09:00'; }).code, 'E_LATE');
    eq(bad((o) => { o.races.reverse(); }).code, 'E_ORDER');
    eq(bad((o) => { o.races.pop(); }).path, `$.days[${demoRec.days.length - 1}].n_recorded`);
    const k = demoRec.races.findIndex((x) => x.status === 'ok');
    eq(bad((o) => { o.races[k].status = 'refund'; }).code, 'E_CONSIST');
    eq(bad((o) => { o.races[0].honmei_name = 'あ'.repeat(21); }).path, '$.races[0].honmei_name');
    eq(validateRecordText('{"schema":').code, 'E_PARSE');
    eq(validateRecordText(' '.repeat(5000001)).code, 'E_SIZE');
    eq(validateRecordText(null).ok, false);
  });
  await t('記録の集計：明細から計算し直す（返還・払戻なしは数えない、★4＋★5＝★5＋★4）', () => {
    const base = { date: '2099-01-01', venue_code: '05', post_time: '10:00', partners: [2, 3, 4], honmei_umaban: 1, honmei_name: 'デモ', n_starters: 10 };
    const B = (tan, fuku) => ({ tan, fuku, umaren: { cost: 300, pay: 0 }, umatan: null, trio: { cost: 300, pay: 900 }, tri: { cost: 600, pay: 0 } });
    const rs = [
      { ...base, race_id: '209901010501', race_no: 1, stars: 5, status: 'ok', honmei_status: '完走', honmei_finish: 1, bets: B({ cost: 100, pay: 250 }, { cost: 100, pay: 120 }) },
      { ...base, race_id: '209901010502', race_no: 2, stars: 4, status: 'ok', honmei_status: '完走', honmei_finish: 3, bets: B({ cost: 100, pay: 0 }, { cost: 100, pay: 180 }) },
      { ...base, race_id: '209901010503', race_no: 3, stars: 5, status: 'refund', honmei_status: '取消', honmei_finish: null, bets: { tan: null, fuku: null, umaren: null, umatan: null, trio: null, tri: null } },
      { ...base, race_id: '209901010504', race_no: 4, stars: 2, status: 'ok', honmei_status: '中止', honmei_finish: null, bets: B({ cost: 100, pay: 0 }, { cost: 100, pay: 0 }) },
    ];
    const s = summarizeRecord(rs);
    eq([s.s5.n_races, s.s5.n_refund, s.s4.n_races, s.s45.n_races, s.all.n_races], [1, 1, 1, 2, 3]);
    eq([s.all.n_win, s.all.n_place], [1, 2]);
    eq(s.all.bets.tan, { n_races: 3, n_hit: 1, hit_rate: 1 / 3, cost_yen: 300, pay_yen: 250, roi: 250 / 300 });
    eq(s.all.bets.umatan.n_races, 0); eq(s.all.bets.umatan.roi, null);
    eq(s.s45.bets.fuku.pay_yen, 300);
    eq(inPlace({ honmei_finish: 3, n_starters: 7 }), false);   // 7 頭以下は 2 着まで
    const d = summarizeRecord(demoRec.races);
    for (const b of ['tan', 'fuku', 'umaren', 'umatan', 'trio', 'tri']) {
      eq(d.s45.bets[b].cost_yen, d.s5.bets[b].cost_yen + d.s4.bets[b].cost_yen, b);
      eq(d.s45.bets[b].n_hit, d.s5.bets[b].n_hit + d.s4.bets[b].n_hit, b);
    }
    eq(d.all.bets.tan.n_hit, d.all.n_win);
    eq(d.all.bets.fuku.n_hit, d.all.n_place);
  });
  await t('記録の保存：実データの記録は保存・読み込みでき、デモの記録・壊れたものは保存しない／起動時に消す', () => {
    try {
      eq(isRecordText(recText), true); eq(isRecordText(demoText), false);
      eq(saveRecord(recText).ok, false);                        // kind=demo は取り込まない
      const r = saveRecord(JSON.stringify(realRec()));
      ok(r.ok); eq(loadRecord().record.races.length, demoRec.races.length);
      eq(saveRecord('{"schema":"keiba-record/v1"}').ok, false);
      eq(loadRecord().record.races.length, demoRec.races.length);  // 壊れたファイルでは今の記録を上書きしない
      localStorage.setItem(RECORD_KEY, '{"schema":"keiba-record/v1","kind":"record"}');
      eq(loadRecord(), { record: null, removed: 1 });
      eq(localStorage.getItem(RECORD_KEY), null);
    } finally {
      if (savedRec === null) localStorage.removeItem(RECORD_KEY); else localStorage.setItem(RECORD_KEY, savedRec);
    }
  });
  await t('記録の画面：デモの記録が成績画面に出る（区分・券種・期間・日ごと→明細・少ないときの注意・免責）', () => {
    state.demo = demo; state.demoRecord = demoRec; state.record = null; state.stats = null; state.recSeg = 's45';
    location.hash = '#/stats'; render();
    const main = document.getElementById('main');
    const txt = main.textContent;
    for (const w of ['実戦の記録', 'デモの記録', '★4＋★5', '全体', '1着率', '3着以内率', '回収率', '三連単（6点）', '期間：2099-11-01〜2099-11-16',
      'レース数が少なく、偶然で大きく上下します', '購入を勧めるものでもありません', '20歳未満']) ok(txt.includes(w), w);
    ok(!txt.includes('2026年検証'), '成績ファイルなしでは 2026 年を並べない');
    eq(main.querySelectorAll('details.recday').length, demoRec.days.length);
    eq(main.querySelectorAll('details.recrace').length, demoRec.races.length);
    ok(txt.includes('取消（返還）'));
    eq(main.querySelectorAll('table.bets').length, 8);
    for (const w of ['買い', 'おすすめ']) ok(!txt.includes(w), w);
    ok([...main.querySelectorAll('a')].every((a) => (a.getAttribute('href') || '').startsWith('#')), '外部リンクなし');
    const S = summarizeRecord(demoRec.races);
    ok(txt.includes(`${S.s45.bets.tan.n_hit}/${S.s45.bets.tan.n_races}`));
    [...main.querySelectorAll('.recbox .chips button')].find((b) => b.textContent === '全体').click();
    eq(state.recSeg, 'all');
    ok(document.getElementById('main').textContent.includes(`全体：${S.all.n_races} レース`));
    state.recSeg = 's45';
  });
  await t('記録の画面：取り込んだ記録は「取り込んだ実戦の記録」。成績ファイル（実データ）があるときだけ 2026 年の検証を並べる', () => {
    const rec = realRec(); rec.races[0].honmei_name = '<img src=x>';
    state.record = rec;
    location.hash = '#/stats'; render();
    let main = document.getElementById('main');
    ok(main.textContent.includes('取り込んだ実戦の記録')); ok(!main.textContent.includes('デモの記録（架空'));
    eq(main.querySelectorAll('img').length, 0); ok(main.textContent.includes('<img src=x>'));
    ok(!main.textContent.includes('2026年検証'));
    const seg = (key, rate) => ({ key, label: key, n_races: 50, honmei_win_rate: 0.3, honmei_place_rate: rate, rows: [{ bet: 'tan', basis: 'model', n_races: 50, hit_rate: 0.3, roi: 0.777 }] });
    state.stats = { ...statsObj, bets: [{ period: '2026年の検証（テスト）', segments: [seg('s5', 0.6111), seg('s4', 0.5222), seg('s45', 0.5666)] }] };
    render(); main = document.getElementById('main');
    for (const w of ['参考：2026年検証の3着以内率', '56.7%', '参考：2026年検証の回収率', '77.7%', '2026年の検証（テスト）']) ok(main.textContent.includes(w), w);
    state.stats = { ...state.stats, kind: 'demo' };
    render();
    ok(!document.getElementById('main').textContent.includes('参考：2026年検証'), 'デモの成績ファイルでは並べない');
    state.stats = null; state.record = null;
  });
  await t('記録の取り込み画面：記録が出て、それだけを消せる（予想・成績ファイルは残る）', () => {
    try {
      saveRecord(JSON.stringify(realRec())); state.record = loadRecord().record;
      location.hash = '#/import'; render();
      const main = document.getElementById('main');
      ok(main.textContent.includes('実戦の記録（record.json）'));
      ok(main.textContent.includes(`${demoRec.days.length}日・${demoRec.races.length}レース`));
      const orig = window.confirm; window.confirm = () => true;
      try {
        const btn = [...main.querySelectorAll('.files button')].find((b) => b.closest('ul').previousElementSibling.textContent.includes('実戦の記録'));
        btn.click();
      } finally { window.confirm = orig; }
      eq(state.record, null); eq(localStorage.getItem(RECORD_KEY), null);
      eq(demoRecordOf({ demo_record: { ...demoRec, races: 'x' } }), null);   // 壊れたデモの記録は使わない
    } finally {
      if (savedRec === null) localStorage.removeItem(RECORD_KEY); else localStorage.setItem(RECORD_KEY, savedRec);
      state.record = null;
    }
  });

  // 6. ソースの約束
  const appSrc = await (await fetch('./js/app.js', { cache: 'no-cache' })).text();
  const storeSrc = await (await fetch('./js/store.js', { cache: 'no-cache' })).text();
  await t('innerHTML / insertAdjacentHTML を使っていない', () => ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(appSrc + storeSrc)));
  await t('予想をどこにも送信しない（fetch はデモの読み込みだけ・送信系の API なし）', () => {
    const fetches = appSrc.match(/fetch\(/g) || [];
    eq(fetches.length, 1);
    ok(appSrc.includes("fetch('./data/demo.json'"));
    ok(!/XMLHttpRequest|sendBeacon|WebSocket/.test(appSrc + storeSrc));
  });

  // 7. サービスワーカーの VERSION（tools/update_sw_version.py と同じ計算）
  await t('sw.js の VERSION がファイルの中身と一致（上げ忘れ防止）', async () => {
    const sw = await (await fetch('./sw.js', { cache: 'no-cache' })).text();
    const ver = sw.match(/const VERSION = '([^']*)';/)[1];
    const block = sw.match(/const ASSETS = \[([\s\S]*?)\];/)[1];
    const assets = [...block.matchAll(/'\.\/([^']*)'/g)].map((m) => m[1]).filter((a) => a).sort();
    let s = '';
    for (const a of assets) {
      const buf = await (await fetch('./' + a, { cache: 'no-cache' })).arrayBuffer();
      const h = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf))).map((b) => b.toString(16).padStart(2, '0')).join('');
      s += `${a}\n${h}\n`;
    }
    const want = 'kyp-' + (await sha256Hex(s)).slice(0, 12);
    eq(ver, want);
  });
  await t('サービスワーカーは予想ファイル（yosou_）をキャッシュしない', async () => {
    const sw = await (await fetch('./sw.js', { cache: 'no-cache' })).text();
    ok(!sw.includes('yosou'));
    ok(!sw.includes('localStorage'));
  });

  // 後片付け（元の保存データに戻す）
  try { if (saved === null) localStorage.removeItem(KEY); else localStorage.setItem(KEY, saved); } catch (e) { /* 何もしない */ }
  location.hash = '';

  const pass = results.filter((r) => r[0]).length;
  const fail = results.length - pass;
  const sum = document.getElementById('summary');
  sum.textContent = `合格 ${pass} 件 / 不合格 ${fail} 件（全 ${results.length} 件）`;
  sum.className = 'res ' + (fail ? 'fail' : 'pass');
  const log = document.getElementById('log');
  for (const [p, name] of results) log.append(el('li', { class: p ? 'pass' : 'fail' }, (p ? '合格：' : '不合格：') + name));
  window.__testResult = { pass, fail, total: results.length, failures: results.filter((r) => !r[0]).map((r) => r[1]) };
}

main().catch((e) => {
  document.getElementById('summary').textContent = 'テストの実行に失敗：' + e.message;
  window.__testResult = { pass: 0, fail: 1, total: 1, failures: [String(e)] };
});
