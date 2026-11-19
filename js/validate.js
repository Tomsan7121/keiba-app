// 予想 JSON の検査（pipeline/export.py の validate_prediction_text と同じ規則）。
// 最初に見つけた誤り1つを {ok, code, path} で返す。1か所でも誤りがあればファイル全体を受け付けない。
export const MAX_BYTES = 5000000;
const RE_RACE_ID = /^\d{12}$/;
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RE_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const RE_GEN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/;
const VENUES = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10'];
const ITEM_KEYS = Array.from({ length: 11 }, (_, i) => 'f' + String(i + 1).padStart(2, '0'));

export function places(n) { return n >= 8 ? 3 : (n >= 5 ? 2 : 1); }

export function levelOf(score, th) {
  if (score === null || score === undefined) return 'none';
  if (score >= th) return 'high';
  if (score >= th - 0.10) return 'mid';
  return 'low';
}

// ★1〜★5（cuts＝★2〜★5 の下限 4 つ。pipeline/stars.py と同じ）
export function starsOf(score, cuts) {
  if (score === null || score === undefined || !Array.isArray(cuts)) return null;
  return 1 + cuts.filter((c) => score >= c).length;
}
const TOL = 1e-6;   // 確率は小数 6 桁に丸めて書かれるので、境目の判定はこの幅だけ両側を認める（N12）

class Bad extends Error { constructor(code, path) { super(code); this.code = code; this.path = path; } }
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const num = (x) => typeof x === 'number' && Number.isFinite(x);
const int = (x) => typeof x === 'number' && Number.isInteger(x);
const str = (x, mx) => typeof x === 'string' && [...x].length <= mx;
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
function need(c, code, path) { if (!c) throw new Bad(code, path); }

function utf8Len(text) { return new TextEncoder().encode(text).length; }

// --- 成績の欄の検査（pipeline/export.py の check_backtest_block・validate_stats_text と同じ規則。N8） ---
const RATE_KEYS = ['conf_place_rate', 'conf_ci_low', 'conf_ci_high', 'all_place_rate', 'all_win_rate',
  'fav1_place_rate_all', 'fav1_place_rate_conf', 'kijun1_place_rate_all'];
const RET_KEYS = ['conf_place_return', 'all_place_return'];
const COUNT_KEYS = ['n_races', 'n_conf'];
const opt = (o, k, ok) => !has(o, k) || o[k] === null || ok(o[k]);
const rate01 = (x) => num(x) && x >= 0 && x <= 1;
const cnt = (x) => int(x) && x >= 0 && x <= 100000;

function checkMetrics(m, path) {
  need(isObj(m), 'E_FIELD', path);
  need(opt(m, 'period', (x) => str(x, 80)), 'E_FIELD', path + '.period');
  for (const k of RATE_KEYS) need(opt(m, k, rate01), 'E_RANGE', `${path}.${k}`);
  for (const k of RET_KEYS) need(opt(m, k, (x) => num(x) && x >= 0 && x <= 100), 'E_RANGE', `${path}.${k}`);
  for (const k of COUNT_KEYS) need(opt(m, k, cnt), 'E_RANGE', `${path}.${k}`);
}

function checkOddsOnly(o, path) {
  need(isObj(o), 'E_FIELD', path);
  need(opt(o, 'method', (x) => str(x, 120)) && opt(o, 'source', (x) => str(x, 160)), 'E_FIELD', path);
  need(Array.isArray(o.rows) && o.rows.length <= 6, 'E_FIELD', path + '.rows');
  o.rows.forEach((r, i) => {
    const q = `${path}.rows[${i}]`;
    need(isObj(r) && str(r.label, 40), 'E_FIELD', q);
    need(opt(r, 'n', cnt), 'E_RANGE', q + '.n');
    for (const k of ['rate', 'ci_low', 'ci_high']) need(opt(r, k, rate01), 'E_RANGE', `${q}.${k}`);
    need(opt(r, 'ret', (x) => num(x) && x >= 0 && x <= 100), 'E_RANGE', q + '.ret');
  });
}

const TRIO_RET = ['roi', 'roi_ci_low', 'roi_ci_high', 'roi_without_max', 'monthly_roi_min', 'monthly_roi_max'];
function checkTrio(t, path) {
  need(isObj(t), 'E_FIELD', path);
  need(opt(t, 'scheme', (x) => ['a', 'b', 'c'].includes(x)), 'E_FIELD', path + '.scheme');
  need(Array.isArray(t.rows) && t.rows.length <= 10, 'E_FIELD', path + '.rows');
  t.rows.forEach((r, i) => {
    const q = `${path}.rows[${i}]`;
    need(isObj(r) && ['a', 'b', 'c', 'd', 'e'].includes(r.key) && str(r.label, 60) && str(r.period, 40), 'E_FIELD', q);
    need(opt(r, 'n_races', cnt), 'E_RANGE', q + '.n_races');
    need(opt(r, 'hit_rate', rate01), 'E_RANGE', q + '.hit_rate');
    for (const k of TRIO_RET) need(opt(r, k, (x) => num(x) && x >= 0 && x <= 1000), 'E_RANGE', `${q}.${k}`);
    for (const k of ['avg_pay_when_hit', 'max_pay']) need(opt(r, k, (x) => num(x) && x >= 0 && x <= 1e8), 'E_RANGE', `${q}.${k}`);
  });
}

export const BET_KEYS = ['tan', 'fuku', 'umaren', 'umatan', 'trio', 'tri'];
const SEG_KEYS = ['s5', 's4', 's45', 'old'];
function checkBets(bl, path) {
  need(Array.isArray(bl) && bl.length <= 2, 'E_FIELD', path);
  bl.forEach((b, i) => {
    const q = `${path}[${i}]`;
    need(isObj(b) && str(b.period, 60), 'E_FIELD', q);
    need(Array.isArray(b.segments) && b.segments.length <= 4, 'E_FIELD', q + '.segments');
    b.segments.forEach((s, j) => {
      const qs = `${q}.segments[${j}]`;
      need(isObj(s) && SEG_KEYS.includes(s.key) && str(s.label, 40), 'E_FIELD', qs);
      need(opt(s, 'n_races', cnt), 'E_RANGE', qs + '.n_races');
      for (const k of ['honmei_win_rate', 'honmei_place_rate']) need(opt(s, k, rate01), 'E_RANGE', `${qs}.${k}`);
      need(Array.isArray(s.rows) && s.rows.length <= 12, 'E_FIELD', qs + '.rows');
      s.rows.forEach((r, m) => {
        const qr = `${qs}.rows[${m}]`;
        need(isObj(r) && BET_KEYS.includes(r.bet) && (r.basis === 'model' || r.basis === 'odds'), 'E_FIELD', qr);
        need(opt(r, 'n_races', cnt), 'E_RANGE', qr + '.n_races');
        need(opt(r, 'hit_rate', rate01), 'E_RANGE', qr + '.hit_rate');
        for (const k of ['roi', 'roi_ci_low', 'roi_ci_high', 'roi_without_max']) need(opt(r, k, (x) => num(x) && x >= 0 && x <= 1000), 'E_RANGE', `${qr}.${k}`);
        need(opt(r, 'max_pay', (x) => num(x) && x >= 0 && x <= 1e9), 'E_RANGE', qr + '.max_pay');
      });
    });
  });
}

function checkStake(bl, path) {
  need(Array.isArray(bl) && bl.length <= 2, 'E_FIELD', path);
  bl.forEach((b, i) => {
    const q = `${path}[${i}]`;
    need(isObj(b) && str(b.period, 60) && str(b.rule, 80), 'E_FIELD', q);
    need(int(b.budget) && b.budget >= 100 && b.budget <= 1000000, 'E_RANGE', q + '.budget');
    need(Array.isArray(b.segments) && b.segments.length <= 4, 'E_FIELD', q + '.segments');
    b.segments.forEach((s, j) => {
      const qs = `${q}.segments[${j}]`;
      need(isObj(s) && SEG_KEYS.includes(s.key) && str(s.label, 40), 'E_FIELD', qs);
      need(Array.isArray(s.rows) && s.rows.length <= 6, 'E_FIELD', qs + '.rows');
      s.rows.forEach((r, m) => {
        const qr = `${qs}.rows[${m}]`;
        need(isObj(r) && BET_KEYS.includes(r.bet), 'E_FIELD', qr);
        for (const k of ['n_races', 'n_skipped', 'n_trigami']) need(opt(r, k, cnt), 'E_RANGE', `${qr}.${k}`);
        for (const k of ['cost_yen', 'pay_yen']) need(opt(r, k, (x) => int(x) && x >= 0 && x <= 1e11), 'E_RANGE', `${qr}.${k}`);
        need(opt(r, 'hit_rate', rate01), 'E_RANGE', qr + '.hit_rate');
        for (const k of ['roi', 'roi_ci_low', 'roi_ci_high', 'roi_without_max']) need(opt(r, k, (x) => num(x) && x >= 0 && x <= 1000), 'E_RANGE', `${qr}.${k}`);
      });
    });
  });
}

function checkNotes(n, path) {
  need(Array.isArray(n) && n.length <= 10 && n.every((x) => str(x, 200)), 'E_FIELD', path);
}

function checkBacktestBlock(b, path) {
  if (b === null || b === undefined) return;
  checkMetrics(b, path);
  need(opt(b, 'stats_source', (x) => x === 'real' || x === 'synthetic'), 'E_FIELD', path + '.stats_source');
  if (b.validation_2026 !== null && b.validation_2026 !== undefined) checkMetrics(b.validation_2026, path + '.validation_2026');
  if (b.odds_only !== null && b.odds_only !== undefined) checkOddsOnly(b.odds_only, path + '.odds_only');
  if (b.notes !== null && b.notes !== undefined) checkNotes(b.notes, path + '.notes');
  if (b.bets !== null && b.bets !== undefined) checkBets(b.bets, path + '.bets');
  if (b.stake !== null && b.stake !== undefined) checkStake(b.stake, path + '.stake');
}

// 成績 JSON（schema keiba-stats/v1）。pipeline の `cli stats` が出す。端末に取り込んで使う
export function validateStatsText(text) {
  try {
    if (typeof text !== 'string') throw new Bad('E_PARSE', '$');
    if (utf8Len(text) > 1000000) throw new Bad('E_SIZE', '$');
    let o;
    try { o = JSON.parse(text); } catch (e) { throw new Bad('E_PARSE', '$'); }
    need(isObj(o), 'E_SCHEMA', '$');
    need(o.schema === 'keiba-stats/v1', 'E_SCHEMA', '$.schema');
    need(o.kind === 'stats' || o.kind === 'demo', 'E_FIELD', '$.kind');
    need(typeof o.generated_at === 'string' && RE_GEN.test(o.generated_at), 'E_FIELD', '$.generated_at');
    need(str(o.model_version, 40) && str(o.source, 60), 'E_FIELD', '$.model_version');
    checkMetrics(o.backtest_2025, '$.backtest_2025');
    if (o.validation_2026 !== null && o.validation_2026 !== undefined) checkMetrics(o.validation_2026, '$.validation_2026');
    if (o.odds_only !== null && o.odds_only !== undefined) checkOddsOnly(o.odds_only, '$.odds_only');
    if (o.trio !== null && o.trio !== undefined) checkTrio(o.trio, '$.trio');
    if (o.bets !== null && o.bets !== undefined) checkBets(o.bets, '$.bets');
    if (o.stake !== null && o.stake !== undefined) checkStake(o.stake, '$.stake');
    checkNotes(has(o, 'notes') ? o.notes : [], '$.notes');
    return { ok: true, code: null, path: null };
  } catch (e) {
    if (e instanceof Bad) return { ok: false, code: e.code, path: e.path };
    return { ok: false, code: 'E_FIELD', path: '$' };
  }
}

export function validatePredictionText(text) {
  try {
    if (typeof text !== 'string') throw new Bad('E_PARSE', '$');
    if (utf8Len(text) > MAX_BYTES) throw new Bad('E_SIZE', '$');
    let o;
    try { o = JSON.parse(text); } catch (e) { throw new Bad('E_PARSE', '$'); }
    need(isObj(o), 'E_SCHEMA', '$');
    need(o.schema === 'keiba-yosou/v1', 'E_SCHEMA', '$.schema');
    need(o.kind === 'predictions' || o.kind === 'demo', 'E_FIELD', '$.kind');
    need(typeof o.generated_at === 'string' && RE_GEN.test(o.generated_at), 'E_FIELD', '$.generated_at');
    need(o.asof === 'eve', 'E_FIELD', '$.asof');
    need(str(o.model_version, 40), 'E_FIELD', '$.model_version');
    const th = o.threshold;
    need(num(th) && th > 0 && th < 1, 'E_RANGE', '$.threshold');
    checkBacktestBlock(o.backtest, '$.backtest');
    const cuts = has(o, 'stars_cuts') ? o.stars_cuts : null;
    if (cuts !== null) {
      need(Array.isArray(cuts) && cuts.length === 4 && cuts.every((x) => num(x) && x > 0 && x < 1)
        && cuts.every((x, i) => i === 0 || cuts[i - 1] < x), 'E_FIELD', '$.stars_cuts');
    }
    const races = o.races;
    need(Array.isArray(races) && races.length >= 1 && races.length <= 500, 'E_FIELD', '$.races');
    const seen = new Set();
    races.forEach((r, i) => {
      const p = `$.races[${i}]`;
      need(isObj(r), 'E_FIELD', p);
      need(typeof r.race_id === 'string' && RE_RACE_ID.test(r.race_id), 'E_FIELD', p + '.race_id');
      need(!seen.has(r.race_id), 'E_DUP', p + '.race_id');
      seen.add(r.race_id);
      need(typeof r.date === 'string' && RE_DATE.test(r.date), 'E_FIELD', p + '.date');
      need(r.race_id.slice(0, 8) === r.date.replace(/-/g, ''), 'E_CONSIST', p + '.date');
      need(VENUES.includes(r.venue_code), 'E_FIELD', p + '.venue_code');
      need(r.race_id.slice(8, 10) === r.venue_code, 'E_CONSIST', p + '.venue_code');
      need(int(r.race_no) && r.race_no >= 1 && r.race_no <= 12, 'E_RANGE', p + '.race_no');
      need(parseInt(r.race_id.slice(10, 12), 10) === r.race_no, 'E_CONSIST', p + '.race_no');
      need(str(r.race_name, 40), 'E_FIELD', p + '.race_name');
      need(typeof r.post_time === 'string' && RE_TIME.test(r.post_time), 'E_FIELD', p + '.post_time');
      need(r.surface === '芝' || r.surface === 'ダ', 'E_FIELD', p + '.surface');
      need(int(r.distance_m) && r.distance_m >= 1000 && r.distance_m <= 3600, 'E_RANGE', p + '.distance_m');
      need(['右', '左', '直'].includes(r.turn), 'E_FIELD', p + '.turn');
      need(r.going_outlook === null || r.going_outlook === undefined || ['良', '稍重', '重', '不良'].includes(r.going_outlook), 'E_FIELD', p + '.going_outlook');
      const hs = r.horses;
      need(Array.isArray(hs) && hs.length >= 1 && hs.length <= 18, 'E_FIELD', p + '.horses');
      need(int(r.n_declared) && r.n_declared === hs.length, 'E_CONSIST', p + '.n_declared');
      const c = r.confidence;
      need(isObj(c), 'E_FIELD', p + '.confidence');
      const sc = has(c, 'score') ? c.score : null;
      need(sc === null || (num(sc) && sc >= 0 && sc <= 1), 'E_RANGE', p + '.confidence.score');
      need(['high', 'mid', 'low', 'none'].includes(c.level), 'E_FIELD', p + '.confidence.level');
      // 段階は丸める前の確率で決めるので、境目から 100 万分の 1 以内なら両側を認める（N12）
      need(sc === null ? c.level === 'none' : [levelOf(sc - TOL, th), levelOf(sc + TOL, th)].includes(c.level), 'E_CONSIST', p + '.confidence.level');
      const ums = new Set(), ranks = new Set();
      let psum = 0, best = null;
      hs.forEach((h, j) => {
        const q = `${p}.horses[${j}]`;
        need(isObj(h), 'E_FIELD', q);
        need(int(h.umaban) && h.umaban >= 1 && h.umaban <= 18, 'E_RANGE', q + '.umaban');
        need(!ums.has(h.umaban), 'E_DUP', q + '.umaban');
        ums.add(h.umaban);
        need(int(h.wakuban) && h.wakuban >= 1 && h.wakuban <= 8, 'E_RANGE', q + '.wakuban');
        for (const [key, mx] of [['name', 20], ['jockey', 20]]) need(str(h[key], mx), 'E_FIELD', q + '.' + key);
        need(['牡', '牝', 'セ'].includes(h.sex), 'E_FIELD', q + '.sex');
        need(int(h.age) && h.age >= 2 && h.age <= 15, 'E_RANGE', q + '.age');
        need(num(h.carried_kg) && h.carried_kg >= 40 && h.carried_kg <= 70, 'E_RANGE', q + '.carried_kg');
        const pp = has(h, 'p_place') ? h.p_place : null;
        need(pp === null || (num(pp) && pp >= 0 && pp <= 1), 'E_RANGE', q + '.p_place');
        need(int(h.rank) && h.rank >= 1 && h.rank <= hs.length && !ranks.has(h.rank), 'E_CONSIST', q + '.rank');
        ranks.add(h.rank);
        need(isObj(h.items), 'E_FIELD', q + '.items');
        for (const fk of ITEM_KEYS) {
          const it = h.items[fk];
          need(isObj(it), 'E_FIELD', `${q}.items.${fk}`);
          need(it.v === null || it.v === undefined || num(it.v), 'E_RANGE', `${q}.items.${fk}.v`);
          need(it.n === null || it.n === undefined || (int(it.n) && it.n >= 0), 'E_RANGE', `${q}.items.${fk}.n`);
          need(str(it.t, 80), 'E_FIELD', `${q}.items.${fk}.t`);
        }
        // 任意の欄も、あるなら形を確かめる（画面が壊れないように）
        if (h.top_reasons !== null && h.top_reasons !== undefined) {
          const tr = h.top_reasons;
          need(Array.isArray(tr) && tr.length <= 5 && tr.every((x) => str(x, 20)), 'E_FIELD', q + '.top_reasons');
        }
        if (h.extras !== null && h.extras !== undefined) {
          need(isObj(h.extras) && Object.keys(h.extras).length <= 20, 'E_FIELD', q + '.extras');
          for (const [ek, ev] of Object.entries(h.extras)) need(isObj(ev) && str(ev.t, 80), 'E_FIELD', `${q}.extras.${ek}`);
        }
        if (sc !== null) {
          need(pp !== null, 'E_CONSIST', q + '.p_place');
          psum += pp;
          if (h.rank === 1) best = h;
        }
      });
      const hon = has(r, 'honmei_umaban') ? r.honmei_umaban : null;
      if (sc === null) {
        need(hon === null, 'E_CONSIST', p + '.honmei_umaban');
      } else {
        need(best !== null && hon === best.umaban, 'E_CONSIST', p + '.honmei_umaban');
        need(hs.every((h) => h.p_place <= best.p_place), 'E_CONSIST', p + '.horses.rank');
        need(Math.abs(sc - best.p_place) <= 1e-6, 'E_CONSIST', p + '.confidence.score');
        const expect = hs.length >= 5 ? places(hs.length) : 1;
        need(Math.abs(psum - expect) <= 0.05, 'E_CONSIST', p + '.horses.p_place');
      }
      // 星（stars_cuts があるファイルだけ。本命＝順位 1 位の確率で決める。境目の近くは両側を認める）
      if (cuts !== null) {
        const top = hs.find((h) => h.rank === 1);
        const tp = top && num(top.p_place) ? top.p_place : null;
        const st = has(r, 'stars') ? r.stars : null;
        if (tp === null) need(st === null, 'E_CONSIST', p + '.stars');
        else need(int(st) && st >= starsOf(tp - TOL, cuts) && st <= starsOf(tp + TOL, cuts), 'E_CONSIST', p + '.stars');
      } else {
        need(!has(r, 'stars'), 'E_FIELD', p + '.stars');
      }
      // 上位5頭（無い古いファイルも受け付ける）。あれば horses の順位・確率と一致すること
      if (has(r, 'is_conf')) need(r.is_conf === (c.level === 'high'), 'E_CONSIST', p + '.is_conf');
      if (has(r, 'top5')) {
        const t5 = r.top5;
        need(Array.isArray(t5) && t5.length === Math.min(5, hs.length), 'E_FIELD', p + '.top5');
        const byRank = new Map(hs.map((h) => [h.rank, h]));
        t5.forEach((t, j) => {
          const q = `${p}.top5[${j}]`;
          need(isObj(t), 'E_FIELD', q);
          need(t.rank === j + 1, 'E_CONSIST', q + '.rank');
          const hh = byRank.get(j + 1);
          need(hh !== undefined && t.umaban === hh.umaban, 'E_CONSIST', q + '.umaban');
          need(str(t.name, 20) && t.name === hh.name, 'E_CONSIST', q + '.name');
          need(t.p_place === hh.p_place, 'E_CONSIST', q + '.p_place');
          const o = has(t, 'odds_rank') ? t.odds_rank : null;
          need(o === null || (int(o) && o >= 1 && o <= 18), 'E_RANGE', q + '.odds_rank');
        });
      }
    });
    return { ok: true, code: null, path: null };
  } catch (e) {
    if (e instanceof Bad) return { ok: false, code: e.code, path: e.path };
    return { ok: false, code: 'E_FIELD', path: '$' };
  }
}
