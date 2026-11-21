// 実戦の記録（keiba-record/v1）の集計。ファイルの summary は使わず、明細（races）から計算し直す。
// pipeline/record.py の summarize と同じ計算（返還のレースは数えない・払戻の無い券種は数えない）。
import { places } from './validate.js';

export const REC_BETS = ['tan', 'fuku', 'umaren', 'umatan', 'trio', 'tri'];
export const REC_SEGMENTS = [['s5', '★5'], ['s4', '★4'], ['s45', '★4＋★5'], ['all', '全体']];
export const FEW_RACES = 100;   // これより少ないと「偶然で大きく上下します」と出す

export function inPlace(r) {
  const f = r.honmei_finish;
  return Number.isInteger(f) && f <= places(r.n_starters);
}

export function segOf(key, r) {
  return { s5: r.stars === 5, s4: r.stars === 4, s45: r.stars >= 4, all: true }[key];
}

export function summarizeRecord(races) {
  const out = {};
  for (const [key, label] of REC_SEGMENTS) {
    const rs = races.filter((r) => segOf(key, r));
    const ok = rs.filter((r) => r.status === 'ok');
    const n = ok.length;
    const nw = ok.filter((r) => r.honmei_finish === 1).length;
    const np = ok.filter(inPlace).length;
    const bets = {};
    for (const b of REC_BETS) {
      const xs = ok.map((r) => r.bets[b]).filter((x) => x);
      const cost = xs.reduce((a, x) => a + x.cost, 0);
      const pay = xs.reduce((a, x) => a + x.pay, 0);
      const hit = xs.filter((x) => x.pay > 0).length;
      bets[b] = { n_races: xs.length, n_hit: hit, hit_rate: xs.length ? hit / xs.length : null, cost_yen: cost, pay_yen: pay, roi: cost ? pay / cost : null };
    }
    out[key] = { label, n_races: n, n_refund: rs.length - n, n_win: nw, n_place: np,
      win_rate: n ? nw / n : null, place_rate: n ? np / n : null, bets };
  }
  return out;
}

// 日ごとの小計（一覧用）
export function byDay(doc) {
  return doc.days.map((d) => {
    const rs = doc.races.filter((r) => r.date === d.date);
    return { day: d, races: rs, sum: summarizeRecord(rs).all };
  });
}
