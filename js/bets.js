// 組み合わせ（点数）の数え方。画面に依らない計算だけを置く（tests.js で確かめる）。
// 分析の補助：組み合わせを数えて並べるだけで、購入を勧めるものではない。

export const BET_TYPES = {
  tan: { label: '単勝', n: 1, ordered: false },
  fuku: { label: '複勝', n: 1, ordered: false },
  umaren: { label: '馬連', n: 2, ordered: false },
  wide: { label: 'ワイド', n: 2, ordered: false },
  umatan: { label: '馬単', n: 2, ordered: true },
  trio: { label: '三連複', n: 3, ordered: false },
  tri: { label: '三連単', n: 3, ordered: true },
};

export const METHODS = { single: '通常', box: 'ボックス', nagashi: '流し', formation: 'フォーメーション' };

// その券種で使える組み方
export function methodsFor(type) {
  return BET_TYPES[type].n === 1 ? ['single'] : ['box', 'nagashi', 'formation'];
}

// 流しの軸の頭数の上限（2頭の券種は1頭、3頭の券種は2頭まで）
export function maxAxis(type) { return BET_TYPES[type].n - 1; }

const uniq = (a) => [...new Set(a)].filter((x) => Number.isInteger(x));

function kComb(arr, k) {
  const out = [];
  const rec = (start, cur) => {
    if (cur.length === k) { out.push(cur.slice()); return; }
    for (let i = start; i < arr.length; i++) { cur.push(arr[i]); rec(i + 1, cur); cur.pop(); }
  };
  rec(0, []);
  return out;
}

function kPerm(arr, k) {
  const out = [];
  const rec = (cur, used) => {
    if (cur.length === k) { out.push(cur.slice()); return; }
    arr.forEach((x, i) => { if (!used[i]) { used[i] = true; cur.push(x); rec(cur, used); cur.pop(); used[i] = false; } });
  };
  rec([], []);
  return out;
}

function finish(list, ordered) {
  const seen = new Set();
  const out = [];
  for (const c of list) {
    const k = ordered ? c : [...c].sort((a, b) => a - b);
    if (new Set(k).size !== k.length) continue;           // 同じ馬が 2 回入る組はない
    const key = k.join('-');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(k);
  }
  out.sort((a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; });
  return out;
}

/**
 * 予算の分け方（pipeline/stake.py の allocate と同じ規則）。計算の補助だけで、購入を勧めるものではない。
 * odds：組ごとのオッズ（倍。無い・0 以下は null）。各組の「オッズ × 口数 × 100 円 ≥ 予算」となる最小の口数を求める。
 * fill：true なら残りをオッズの低い組から 1 口ずつ足す。over：'skip'（満たせなければ全部 0）か 'drop'（低い組から外す）。
 * 戻り値：{ units: [口数…], ok: 予算内で満たせたか }
 */
// オッズを 0.1 倍単位の整数にする（5.0 → 50）。小数の誤差を避けるため、口数と払戻はこの整数で計算する（W1）
export function oddsTenths(o) { return Number.isFinite(o) && o > 0 ? Math.round(o * 10) : 0; }

// 当たったときの払戻（円）＝オッズ × 口数 × 100 円。整数だけで計算する（1.2 倍 × 3 口 → 360 円）
export function payoutYen(o, units) { return oddsTenths(o) * units * 10; }

export function allocate(odds, budget, fill = false, over = 'skip') {
  const n = odds.length;
  const unit = 100;
  if (n === 0 || !(budget >= unit)) return { units: odds.map(() => 0), ok: false };
  if (n === 1) return { units: [Math.floor(budget / unit)], ok: true };
  let alive = odds.map((o, i) => (oddsTenths(o) > 0 ? i : -1)).filter((i) => i >= 0);
  let units;
  for (;;) {
    units = odds.map(() => 0);
    for (const i of alive) { const t10 = oddsTenths(odds[i]) * 10; units[i] = Math.floor((budget + t10 - 1) / t10); }   // t×口数×10 ≥ 予算 の最小
    const cost = unit * units.reduce((a, b) => a + b, 0);
    if (alive.length && cost <= budget) break;
    if (over !== 'drop' || !alive.length) return { units: odds.map(() => 0), ok: false };
    const low = alive.reduce((m, i) => (odds[i] < odds[m] || (odds[i] === odds[m] && i < m) ? i : m), alive[0]);
    alive = alive.filter((i) => i !== low);
    if (!alive.length) return { units: odds.map(() => 0), ok: false };
  }
  if (fill) {
    let left = Math.floor((budget - unit * units.reduce((a, b) => a + b, 0)) / unit);
    const order = [...alive].sort((a, b) => odds[a] - odds[b] || a - b);
    for (let k = 0; left > 0; k++, left--) units[order[k % order.length]] += 1;
  }
  return { units, ok: true };
}

/**
 * 組み合わせの一覧を返す。
 * sel: { picks: [馬番] (通常・ボックス), axis: [馬番] (流しの軸。馬単・三連単は 1着〔・2着〕の順), partners: [馬番] (流しの相手),
 *        cols: [[馬番], [馬番], [馬番]] (フォーメーションの 1列目・2列目・3列目。馬単・三連単は 1着・2着・3着) }
 * 戻り値: { ok: true, combos: [[馬番…]…] } または { ok: false, error: '説明' }
 */
export function combos(type, method, sel) {
  const t = BET_TYPES[type];
  if (!t) return { ok: false, error: '券種が違います' };
  if (!methodsFor(type).includes(method)) return { ok: false, error: 'この券種では使えない組み方です' };
  const s = sel || {};
  if (method === 'single') return { ok: true, combos: finish(uniq(s.picks || []).map((u) => [u]), false) };
  if (method === 'box') {
    const p = uniq(s.picks || []);
    return { ok: true, combos: finish(t.ordered ? kPerm(p, t.n) : kComb(p, t.n), t.ordered) };
  }
  if (method === 'nagashi') {
    const ax = uniq(s.axis || []);
    if (ax.length < 1) return { ok: true, combos: [] };
    if (ax.length > maxAxis(type)) return { ok: false, error: `軸は ${maxAxis(type)} 頭までです` };
    const pt = uniq(s.partners || []).filter((u) => !ax.includes(u));
    const rest = t.n - ax.length;
    const tails = t.ordered ? kPerm(pt, rest) : kComb(pt, rest);
    return { ok: true, combos: finish(tails.map((tl) => [...ax, ...tl]), t.ordered) };
  }
  // フォーメーション：各列から 1 頭ずつ選ぶ（同じ馬は 2 回使わない。順不同の券種は重なりを 1 点にまとめる）
  const cols = (s.cols || []).slice(0, t.n).map(uniq);
  while (cols.length < t.n) cols.push([]);
  let acc = [[]];
  for (const c of cols) acc = acc.flatMap((a) => c.map((u) => [...a, u]));
  return { ok: true, combos: finish(acc, t.ordered) };
}
