// 競馬予想（分析の補助）— 画面。外部から来た文字はすべて textContent で表示する（HTML として解釈させない）。
import { validatePredictionText } from './validate.js';
import { loadFiles, clearAll, prepareImport, commitImport, saveFiles, MAX_FILES, loadStats, saveStats, isStatsText, clearStats } from './store.js';
import { BET_TYPES, METHODS, methodsFor, maxAxis, combos, allocate, payoutYen } from './bets.js';

export const VENUE = { '01': '札幌', '02': '函館', '03': '福島', '04': '新潟', '05': '東京', '06': '中山', '07': '中京', '08': '京都', '09': '阪神', '10': '小倉' };
export const ITEM_LABEL = {
  f01: 'コースの状態（芝ダ・馬場）', f02: '同じ競馬場・近い距離の成績', f03: '血統（父・母父）', f04: '同じ競馬場への適性',
  f05: 'コース（芝ダ・距離・回り）', f06: '同じコースの馬場状態ごと', f07: '騎手との相性', f08: '騎手の同コース成績',
  f09: '騎手の全成績', f10: '直近7走の成績', f11: '直近7走の馬体重',
};
export const EXTRA_LABEL = {
  x_mkt_p: '前日の基準オッズ', x_speed_best3: '走破タイム指数', x_days_since: '前走からの間隔', x_class_change: 'クラスの上げ下げ',
  x_early_pos: '脚質（位置取り）', x_hc_best4f: '調教（坂路）',
};
export const LEVEL_LABEL = { high: '自信：高', mid: '自信：中', low: '自信：低', none: '対象外' };

export const state = { files: [], demo: null, useDemo: false, notice: '', flash: '', dateSel: null, onlyHigh: false, stats: null, build: null, keepScroll: false };

// 星（★1〜★5）。古いファイル（stars なし）は null
export function starsOfRace(r) { return Number.isInteger(r.stars) && r.stars >= 1 && r.stars <= 5 ? r.stars : null; }

function starBadge(r) {
  const s = starsOfRace(r);
  if (s === null) return badge(r.confidence.level);
  return el('span', { class: 'stars s' + s, role: 'img', 'aria-label': `星${s}つ（5段階）` },
    el('span', { class: 'on', 'aria-hidden': 'true' }, '★'.repeat(s)), el('span', { class: 'off', 'aria-hidden': 'true' }, '★'.repeat(5 - s)));
}

export function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) {
    if (c === null || c === undefined || c === false) continue;
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}

export function pct(x, d = 1) {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  return (x * 100).toFixed(d) + '%';
}

function activeData() {
  if (!state.useDemo && state.files.length) {
    const races = [];
    let latest = null;
    for (const f of state.files) {
      for (const r of f.data.races) races.push({ ...r, _th: f.data.threshold, _file: f });
      if (!latest || f.data.generated_at > latest.data.generated_at) latest = f;
    }
    return { kind: 'predictions', races, backtest: latest.data.backtest, generated_at: latest.data.generated_at, model_version: latest.data.model_version, threshold: latest.data.threshold };
  }
  if (state.demo) {
    return { kind: 'demo', races: state.demo.races.map((r) => ({ ...r, _th: state.demo.threshold })), backtest: state.demo.backtest,
      generated_at: state.demo.generated_at, model_version: state.demo.model_version, threshold: state.demo.threshold };
  }
  return null;
}

function sourceBar(d) {
  if (!d) return el('div', { class: 'srcbar warn' }, 'データがありません。「取り込み」から予想ファイルを入れてください。');
  if (d.kind === 'demo') {
    return el('div', { class: 'srcbar demo' }, '表示中：デモ（架空のデータ。実在のレース・馬ではありません）');
  }
  return el('div', { class: 'srcbar' }, `表示中：取り込んだ予想（作成 ${d.generated_at.replace('T', ' ').slice(0, 16)}）・この端末の中だけに保存`);
}

function badge(level) { return el('span', { class: 'badge lv-' + level }, LEVEL_LABEL[level] || level); }

function horseName(r, um) {
  const h = r.horses.find((x) => x.umaban === um);
  return h ? h.name : '';
}

// モデルの上位5頭（JSON の top5。古いファイルで無いときは horses の順位から作る）
export function top5Of(r) {
  if (Array.isArray(r.top5)) return r.top5;
  return [...r.horses].sort((a, b) => a.rank - b.rank).slice(0, 5)
    .map((h) => ({ rank: h.rank, umaban: h.umaban, name: h.name, p_place: h.p_place, odds_rank: null }));
}

function top5Block(r) {
  const t5 = top5Of(r);
  const rows = t5.map((t) => el('li', { class: 't5' + (t.rank === 1 ? ' first' : '') },
    el('span', { class: 't5-r' }, `${t.rank}位`),
    el('span', { class: 't5-u' }, `${t.umaban}番`),
    el('span', { class: 't5-n' }, t.name),
    el('span', { class: 't5-p' }, pct(t.p_place)),
    el('span', { class: 't5-o' }, t.odds_rank ? `オッズ${t.odds_rank}番手` : 'オッズ順位なし')));
  return el('div', { class: 'top5box' },
    el('h3', {}, 'モデルの上位5頭'),
    el('ol', { class: 'top5' }, rows),
    el('p', { class: 'small' }, '3着以内に入る確率の見積もりが高い順です。「オッズ◯番手」は前日の基準オッズの人気順。分析の補助で、購入を勧めるものではありません。'));
}

function topHorse(r) { return r.horses.find((h) => h.rank === 1) || null; }

function honmeiLine(r) {
  const hon = r.honmei_umaban;
  if (hon !== null) return `本命 ${hon}番 ${horseName(r, hon)}　3着以内の確率 ${pct(r.confidence.score)}`;
  const t = topHorse(r);
  if (starsOfRace(r) !== null && t) return `モデル1位 ${t.umaban}番 ${t.name}　${pct(t.p_place)}（新馬戦・少頭数など。見積もりがぶれやすい）`;
  return '自信度なし（新馬戦・少頭数など）';
}

function viewRaces(root) {
  const d = activeData();
  root.append(sourceBar(d));
  if (!d) return;
  const dates = [...new Set(d.races.map((r) => r.date))].sort();
  if (!dates.includes(state.dateSel)) state.dateSel = dates[dates.length - 1];
  const chips = el('div', { class: 'chips', role: 'tablist', 'aria-label': '日付' },
    dates.map((dt) => el('button', { class: 'chip' + (dt === state.dateSel ? ' on' : ''), type: 'button', 'aria-pressed': dt === state.dateSel ? 'true' : 'false',
      onclick: () => { state.dateSel = dt; render(); } }, dt.slice(5).replace('-', '/'))));
  const day = d.races.filter((r) => r.date === state.dateSel);
  const hasStars = day.some((r) => starsOfRace(r) !== null);
  // 星があるファイルは「★4以上」、古いファイル（星なし）は従来の「自信：高」で絞る
  const isTop = (r) => (hasStars ? (starsOfRace(r) || 0) >= 4 : r.confidence.level === 'high');
  const filt = el('label', { class: 'toggle' },
    el('input', { type: 'checkbox', checked: state.onlyHigh, onchange: (e) => { state.onlyHigh = e.target.checked; render(); } }),
    hasStars ? ' ★4以上のレースだけ' : ' 自信：高のレースだけ');
  root.append(chips, filt);
  let races = day.slice();
  if (state.onlyHigh) races = races.filter(isTop);
  races.sort((a, b) => (a.post_time + a.race_id < b.post_time + b.race_id ? -1 : 1));
  const nTop = day.filter(isTop).length;
  root.append(el('p', { class: 'muted' }, hasStars
    ? `この日 ${day.length} レース、うち★4以上 ${nTop} レース。星は本命が3着以内に入る確率の見積もりを5段階にしたもの（2025年のレースを同じ数ずつ5つに分けた境目）です。`
    : `この日 ${day.length} レース、うち自信：高 ${nTop} レース（しきい値 ${pct(d.threshold)}）`));
  if (!races.length) root.append(el('p', { class: 'empty' }, '該当するレースはありません。'));
  const list = el('ul', { class: 'racelist' });
  for (const r of races) {
    const hon = r.honmei_umaban;
    list.append(el('li', {},
      el('a', { class: 'racecard', href: '#/race/' + r.race_id },
        el('div', { class: 'rc-top' },
          el('span', { class: 'rc-venue' }, `${VENUE[r.venue_code] || ''}${r.race_no}R`),
          el('span', { class: 'rc-time' }, r.post_time), starBadge(r)),
        el('div', { class: 'rc-name' }, r.race_name || '（レース名なし）'),
        el('div', { class: 'rc-sub' }, `${r.surface}${r.distance_m}m ${r.turn}回り・${r.n_declared}頭`),
        el('div', { class: 'rc-hon' }, honmeiLine(r)),
        el('div', { class: 'rc-top5' }, '上位5頭（馬番）：' + top5Of(r).map((t) => t.umaban).join('・')))));
  }
  root.append(list);
}

function barOf(p) {
  const s = el('span');
  s.style.width = Math.round(Math.min(1, Math.max(0, p || 0)) * 100) + '%';   // CSP の都合で style 属性ではなく CSSOM で
  return el('div', { class: 'bar', role: 'img', 'aria-label': `3着以内の確率 ${pct(p)}` }, s);
}

function itemRow(key, it, label, top) {
  return el('div', { class: 'item' + (top ? ' top' : '') },
    el('div', { class: 'item-h' }, el('span', { class: 'item-k' }, label), top ? el('span', { class: 'tag' }, '根拠の上位') : null,
      el('span', { class: 'item-n' }, it.n === null || it.n === undefined ? '' : `${it.n}件`)),
    el('div', { class: 'item-t' }, it.t));
}

function viewRace(root, id) {
  const d = activeData();
  root.append(sourceBar(d));
  const r = d && d.races.find((x) => x.race_id === id);
  root.append(el('a', { class: 'back', href: '#/races' }, '← レース一覧'));
  if (!r) { root.append(el('p', { class: 'empty' }, 'レースが見つかりません。')); return; }
  root.append(el('h2', {}, `${VENUE[r.venue_code] || ''}${r.race_no}R ${r.race_name}`),
    el('p', { class: 'muted' }, `${r.date} ${r.post_time}発走・${r.surface}${r.distance_m}m ${r.turn}回り・${r.n_declared}頭`),
    el('div', { class: 'confbox ' + (starsOfRace(r) !== null ? 'st' + starsOfRace(r) : 'lv-' + r.confidence.level) },
      el('div', {}, starBadge(r), starsOfRace(r) !== null ? el('span', { class: 'stxt' }, ` ★${starsOfRace(r)}（5段階）`) : null),
      el('p', {}, honmeiLine(r)),
      r.confidence.score === null && r.confidence.note ? el('p', { class: 'small' }, r.confidence.note) : null,
      starsOfRace(r) !== null && r.is_conf ? el('p', { class: 'small' }, '旧しきい値（上位約9%、複勝80%の目標を測った範囲）にも入っています。') : null,
      el('p', { class: 'small' }, '星は過去のデータから計算した見積もりで、当たることを約束するものではありません。')),
    top5Block(r),
    el('a', { class: 'filebtn buildlink', href: '#/build/' + r.race_id }, '組み合わせを作る（点数を数える）'));
  const hs = [...r.horses].sort((a, b) => a.rank - b.rank);
  const list = el('div', { class: 'horses' });
  for (const h of hs) {
    const tops = new Set(Array.isArray(h.top_reasons) ? h.top_reasons : []);
    const det = el('details', { class: 'horse' + (h.umaban === r.honmei_umaban ? ' honmei' : '') },
      el('summary', {},
        el('span', { class: 'um w' + h.wakuban }, String(h.umaban)),
        el('span', { class: 'hn' }, h.name),
        el('span', { class: 'hp' }, pct(h.p_place)),
        el('span', { class: 'hj' }, `${h.jockey} ${h.carried_kg}kg・${h.sex}${h.age}`)),
      el('div', { class: 'items' },
        barOf(h.p_place),
        Object.keys(ITEM_LABEL).map((k) => itemRow(k, h.items[k], ITEM_LABEL[k], tops.has(k))),
        Object.entries(h.extras || {}).filter(([k, v]) => v && typeof v.t === 'string')
          .map(([k, v]) => itemRow(k, v, EXTRA_LABEL[k] || '追加の項目', tops.has(k)))));
    list.append(det);
  }
  root.append(el('p', { class: 'muted' }, '確率の高い順。馬をタップすると11項目の根拠が開きます。'), list);
}

// --- 組み合わせを作る画面（点数を数えるだけ。購入・外部サイトへのリンクは作らない） ---
const SHOW_MAX = 200;

function newBuild(id) {
  return { race_id: id, type: 'umaren', method: 'box', picks: [], axis: [], partners: [], cols: [[], [], []] };
}

function colNames(b) {
  const t = BET_TYPES[b.type];
  if (b.method === 'single' || b.method === 'box') return [['picks', '選ぶ']];
  if (b.method === 'nagashi') return [['axis', t.ordered ? (maxAxis(b.type) === 2 ? '軸（1着→2着）' : '軸（1着）') : '軸'], ['partners', '相手']];
  const names = t.ordered ? ['1着', '2着', '3着'] : ['1列目', '2列目', '3列目'];
  return names.slice(0, t.n).map((nm, i) => ['col' + i, nm]);
}

function getSet(b, key) { return key.startsWith('col') ? b.cols[Number(key.slice(3))] : b[key]; }

function toggle(b, key, u) {
  const arr = getSet(b, key);
  const i = arr.indexOf(u);
  if (i >= 0) arr.splice(i, 1);
  else {
    if (key === 'axis' && arr.length >= maxAxis(b.type)) return;   // V1：軸が上限なら選ばない（知らせなしに外さない。画面で選べなくし、説明を出す）
    arr.push(u);
  }
}

function axisFull(b) { return b.method === 'nagashi' && b.axis.length >= maxAxis(b.type); }

export function buildSelection(b) { return { picks: b.picks, axis: b.axis, partners: b.partners, cols: b.cols }; }

function viewBuild(root, id) {
  const d = activeData();
  root.append(sourceBar(d));
  const r = d && d.races.find((x) => x.race_id === id);
  root.append(el('a', { class: 'back', href: '#/race/' + id }, '← レースの詳細'));
  if (!r) { root.append(el('p', { class: 'empty' }, 'レースが見つかりません。')); return; }
  if (!state.build || state.build.race_id !== id) state.build = newBuild(id);
  const b = state.build;
  const redo = () => { state.keepScroll = true; render(); };
  root.append(el('h2', {}, `組み合わせを作る：${VENUE[r.venue_code] || ''}${r.race_no}R`),
    el('div', { class: 'muted' }, starBadge(r), ` ${r.race_name}・${r.n_declared}頭`),
    el('p', { class: 'warnbox' }, '選んだ馬から組み合わせと点数を数えるだけの道具です。分析の補助で、購入を勧めるものではありません。購入や外部サイトへのリンクはありません。'));
  // 券種
  root.append(el('h3', {}, '券種'), el('div', { class: 'chips wrap', role: 'group', 'aria-label': '券種' },
    Object.entries(BET_TYPES).map(([k, t]) => el('button', { type: 'button', class: 'chip' + (k === b.type ? ' on' : ''), 'aria-pressed': k === b.type ? 'true' : 'false',
      onclick: () => { b.type = k; if (!methodsFor(k).includes(b.method)) b.method = methodsFor(k)[0]; if (b.axis.length > maxAxis(k)) { b.axis = b.axis.slice(0, maxAxis(k)); b.note = `${t.label}の軸は ${maxAxis(k)} 頭までなので、軸を ${b.axis.join('・')}番だけにしました。`; } redo(); } }, t.label))));
  if (b.note) { root.append(el('p', { class: 'small axisnote', role: 'status' }, b.note)); b.note = ''; }
  // 組み方
  root.append(el('h3', {}, '組み方'), el('div', { class: 'chips wrap', role: 'group', 'aria-label': '組み方' },
    methodsFor(b.type).map((m) => el('button', { type: 'button', class: 'chip' + (m === b.method ? ' on' : ''), 'aria-pressed': m === b.method ? 'true' : 'false',
      onclick: () => { b.method = m; redo(); } }, METHODS[m]))));
  const help = {
    single: '選んだ馬 1 頭ずつが 1 点です。',
    box: '選んだ馬の中のすべての組み合わせです。',
    nagashi: BET_TYPES[b.type].ordered ? '軸の馬を上の着順に固定し、相手を残りの着順に入れます。' : `軸（${maxAxis(b.type)}頭まで）と相手を組み合わせます。`,
    formation: '各列から 1 頭ずつ選んだ組み合わせです（同じ馬は 2 回入りません）。',
  }[b.method];
  root.append(el('p', { class: 'small' }, help));
  if (axisFull(b)) {
    root.append(el('p', { class: 'small axisnote', role: 'status' },
      `軸は ${maxAxis(b.type)} 頭まで選べます（いま ${b.axis.join('・')}番）。軸を替えるときは、先に選んだ軸のチェックを外してください。`));
  }
  // 馬の表（馬番順。モデルの順位と確率は参考）
  const cols = colNames(b);
  const tbl = el('table', { class: 'pick' },
    el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, '馬'), cols.map(([, nm]) => el('th', { scope: 'col' }, nm)))));
  const tb = el('tbody');
  for (const h of [...r.horses].sort((a, x) => a.umaban - x.umaban)) {
    tb.append(el('tr', {},
      el('th', { scope: 'row' }, el('span', { class: 'um w' + h.wakuban }, String(h.umaban)),
        el('span', { class: 'pk-n' }, h.name), el('span', { class: 'pk-r' }, `モデル${h.rank}位・${pct(h.p_place)}`)),
      cols.map(([key, nm]) => {
        const on = getSet(b, key).includes(h.umaban);
        return el('td', {}, el('input', { type: 'checkbox', 'aria-label': `${h.umaban}番 ${nm}`, checked: on,
          disabled: key === 'axis' && !on && axisFull(b),
          onchange: () => { toggle(b, key, h.umaban); redo(); } }));
      })));
  }
  tbl.append(tb);
  root.append(el('div', { class: 'tblwrap' }, tbl));
  root.append(el('button', { type: 'button', class: 'small-btn', onclick: () => { state.build = newBuild(id); state.build.type = b.type; state.build.method = b.method; redo(); } }, '選んだ馬を消す'));
  // 結果
  const res = combos(b.type, b.method, buildSelection(b));
  const rankOf = new Map(r.horses.map((h) => [h.umaban, h.rank]));
  const out = el('div', { class: 'result', role: 'status', 'aria-live': 'polite' });
  if (!res.ok) out.append(el('p', { class: 'warnbox' }, res.error));
  else {
    out.append(el('p', { class: 'points' }, `${BET_TYPES[b.type].label}・${METHODS[b.method]}：${res.combos.length} 点`));
    const sep = BET_TYPES[b.type].ordered ? ' → ' : ' - ';
    const ul = el('ul', { class: 'combos' });
    for (const c of res.combos.slice(0, SHOW_MAX)) {
      ul.append(el('li', {}, el('span', { class: 'cb' }, c.join(sep)), el('span', { class: 'cr' }, '（モデル ' + c.map((u) => `${rankOf.get(u)}位`).join('・') + '）')));
    }
    if (res.combos.length > SHOW_MAX) ul.append(el('li', { class: 'muted' }, `ほか ${res.combos.length - SHOW_MAX} 点（表示は ${SHOW_MAX} 点まで）`));
    if (!res.combos.length) ul.append(el('li', { class: 'muted' }, '馬を選ぶと、ここに組み合わせが出ます。'));
    out.append(ul);
  }
  root.append(el('h3', {}, '組み合わせ'), out);
  if (res.ok && res.combos.length) root.append(stakeBox(b, res.combos, BET_TYPES[b.type].ordered ? ' → ' : ' - '));
}

// 予算と、自分で入れたオッズから口数を計算する（計算の補助だけ。購入・リンクなし）
const STAKE_MAX = 60;
export const BUDGET_MIN = 100;
export const BUDGET_MAX = 10000000;

// W2：予算の入力を確かめる。範囲外・空欄は前の予算のまま、端数は 100 円単位に切り捨て。どちらも知らせる文を返す
export function budgetOf(raw, prev) {
  const s = String(raw ?? '').trim();
  const v = Number(s);
  if (s === '' || !Number.isFinite(v)) return { budget: prev, msg: `予算が空欄か数字ではありません。前の ${yen(prev)} のまま計算しています。` };
  if (v < BUDGET_MIN || v > BUDGET_MAX) {
    return { budget: prev, msg: `予算は ${yen(BUDGET_MIN)}〜${yen(BUDGET_MAX)} の範囲で入れてください（${yen(v)} は範囲外です）。前の ${yen(prev)} のまま計算しています。` };
  }
  const fl = Math.floor(v / 100) * 100;
  if (fl !== v) return { budget: fl, msg: `馬券は100円単位なので、予算 ${yen(v)} を ${yen(fl)} に切り捨てて計算しています。` };
  return { budget: fl, msg: '' };
}
function stakeBox(b, list, sep) {
  if (!b.odds) b.odds = {};
  if (!Number.isFinite(b.budget)) b.budget = 3000;
  if (b.fill === undefined) b.fill = true;   // W3：初期設定は成績の表と同じ決まり（L1：残りはオッズの低い組から足す）
  const redo = () => { state.keepScroll = true; render(); };
  const box = el('div', { class: 'stakebox' });
  box.append(el('h3', {}, '予算とオッズから口数を計算する'),
    el('p', { class: 'warnbox' }, 'どの組が当たっても払戻が予算を下回らないように、100円単位で口数を数えるだけの計算の補助です。オッズは自分で入れた数字で、発走までに変わります（最終オッズが下がると、当たっても払戻が予算を下回る「トリガミ」になります）。購入を勧めるものではありません。'));
  if (list.length > STAKE_MAX) { box.append(el('p', { class: 'muted' }, `オッズを入れられるのは ${STAKE_MAX} 点までです（いま ${list.length} 点）。`)); return box; }
  const budgetIn = el('input', { type: 'number', inputmode: 'numeric', min: String(BUDGET_MIN), max: String(BUDGET_MAX), step: '100', value: String(b.budget), 'aria-label': '予算（円）',
    onchange: (e) => { const r = budgetOf(e.target.value, b.budget); b.budget = r.budget; b.budgetMsg = r.msg; redo(); } });
  const fillIn = el('input', { type: 'checkbox', checked: !!b.fill, onchange: (e) => { b.fill = e.target.checked; redo(); } });
  const dropIn = el('input', { type: 'checkbox', checked: !!b.drop, onchange: (e) => { b.drop = e.target.checked; redo(); } });
  box.append(el('label', { class: 'toggle' }, '予算（円）', budgetIn));
  if (b.budgetMsg) box.append(el('p', { class: 'warnbox budgetmsg', role: 'alert' }, b.budgetMsg));
  box.append(
    el('label', { class: 'toggle' }, fillIn, ' 残りはオッズの低い組から足す（成績の表と同じ決まり）'),
    el('label', { class: 'toggle' }, dropIn, ' 予算で足りないときは、オッズの低い組から外す'));
  const keys = list.map((c) => c.join('-'));
  const odds = keys.map((k) => (Number.isFinite(b.odds[k]) && b.odds[k] > 0 ? b.odds[k] : null));
  const al = allocate(odds, b.budget, !!b.fill, b.drop ? 'drop' : 'skip');
  const tb = el('tbody');
  keys.forEach((k, i) => {
    const u = al.units[i];
    tb.append(el('tr', {},
      el('th', { scope: 'row' }, list[i].join(sep)),
      el('td', {}, el('input', { type: 'number', inputmode: 'decimal', min: '1', step: '0.1', value: odds[i] ?? '', 'aria-label': `${list[i].join(sep)} のオッズ`,
        onchange: (e) => { const v = Number(e.target.value); if (v >= 1 && v < 100000) b.odds[k] = Math.round(v * 10) / 10; else delete b.odds[k]; redo(); } })),
      el('td', {}, u ? `${u}口` : '—'),
      el('td', {}, u ? yen(u * 100) : '—'),
      el('td', {}, u && odds[i] ? yen(payoutYen(odds[i], u)) : '—')));
  });
  box.append(el('div', { class: 'tblwrap' }, el('table', { class: 'stake' },
    el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, '組'), el('th', { scope: 'col' }, 'オッズ'), el('th', { scope: 'col' }, '口数'),
      el('th', { scope: 'col' }, '金額'), el('th', { scope: 'col' }, '当たったとき'))), tb)));
  const total = 100 * al.units.reduce((a, x) => a + x, 0);
  const nOdds = odds.filter((o) => o !== null).length;
  if (list.length > 1 && nOdds === 0) box.append(el('p', { class: 'muted' }, 'オッズを入れると口数が出ます（1点の券種は予算をそのまま1点に）。'));
  else if (!al.ok) box.append(el('p', { class: 'warnbox' }, `この予算（${yen(b.budget)}）では、どの組が当たっても予算以上になる分け方ができません。`));
  else box.append(el('p', { class: 'points' }, `合計 ${yen(total)}（予算 ${yen(b.budget)}）`));
  return box;
}

function tile(label, value, sub) {
  return el('div', { class: 'tile' }, el('div', { class: 'tl' }, label), el('div', { class: 'tv' }, value), el('div', { class: 'ts' }, sub || ''));
}

function ciText(o) {
  return `95%区間 ${pct(o.conf_ci_low ?? o.ci_low)}〜${pct(o.conf_ci_high ?? o.ci_high)}`;
}

function metricTiles(m) {
  return el('div', { class: 'tiles' },
    tile('旧しきい値（上位約9%）の本命の複勝的中率', pct(m.conf_place_rate), ciText(m)),
    tile('旧しきい値のレース数', String(m.n_conf ?? '—'), '少ないほど率はぶれやすい'),
    tile('旧しきい値の複勝回収率', pct(m.conf_place_return), '100%未満なら損'),
    tile('全レースの本命の複勝率', pct(m.all_place_rate), `単勝率 ${pct(m.all_win_rate)}`),
    tile('全レースの複勝回収率', pct(m.all_place_return), '新馬戦なども含む'),
    tile('1番人気の複勝率（比べる基準）', pct(m.fav1_place_rate_all), `旧しきい値のレースでは ${pct(m.fav1_place_rate_conf)}`),
    tile('前日の基準オッズ1番手の複勝率', pct(m.kijun1_place_rate_all), '参考の基準'));
}

function yen(x) { return Number.isFinite(x) ? Math.round(x).toLocaleString('ja-JP') + '円' : '—'; }

function trioBlock(t) {
  const box = el('div', {});
  box.append(el('h3', {}, '三連複（本命を軸に流した場合）の過去の成績'));
  box.append(el('p', { class: 'warnbox' }, '過去のレースで、決めた組み方で買っていたら、という計算です。分析の補助で、購入を勧めるものではありません。回収率は大きな当たり1回で大きく変わります。'));
  const rows = Array.isArray(t.rows) ? t.rows : [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const mark = r.key === t.scheme ? '（検証に回す組み方）' : '';
    box.append(el('div', { class: 'trio' },
      el('div', { class: 'trio-h' }, `${r.key}　${r.label}${mark}`),
      el('div', { class: 'muted small' }, `${r.period}・${r.n_races ?? '—'}レース`),
      el('div', { class: 'tiles' },
        tile('回収率', pct(r.roi), `95%区間 ${pct(r.roi_ci_low)}〜${pct(r.roi_ci_high)}`),
        tile('的中率', pct(r.hit_rate), `当たり時の平均払戻 ${yen(r.avg_pay_when_hit)}`),
        tile('最大の当たり1回を除いた回収率', pct(r.roi_without_max), `最大の当たり ${yen(r.max_pay)}`),
        tile('月ごとの回収率', `${pct(r.monthly_roi_min)}〜${pct(r.monthly_roi_max)}`, '最低〜最高'))));
  }
  return box;
}

const BET_LABEL = { tan: '単勝：本命', fuku: '複勝：本命', umaren: '馬連：本命−2〜4位（3点）', umatan: '馬単：本命1着→2〜4位（3点）',
  trio: '三連複：本命軸−2〜4位（3点）', tri: '三連単：本命1着→2〜4位（6点）' };

// ★5・★4・★4＋★5（と参考の旧しきい値）× 券種の表。モデルの順位で組んだ行と、同じ形を前日オッズの人気順で組んだ行を並べる
export function betsBlock(bl) {
  const box = el('div', { class: 'betsbox' });
  box.append(el('h3', {}, `券種ごとの成績：${bl.period || ''}`));
  for (const s of Array.isArray(bl.segments) ? bl.segments : []) {
    if (!s || typeof s !== 'object') continue;
    box.append(el('h4', {}, `${s.label}（${s.n_races ?? '—'}レース）`),
      el('p', { class: 'small' }, `本命の1着率 ${pct(s.honmei_win_rate)}・複勝率（3着以内）${pct(s.honmei_place_rate)}`));
    const tb = el('tbody');
    const rows = Array.isArray(s.rows) ? s.rows : [];
    for (const bk of Object.keys(BET_LABEL)) {
      for (const basis of ['model', 'odds']) {
        const r = rows.find((x) => x && x.bet === bk && x.basis === basis);
        if (!r) continue;
        tb.append(el('tr', { class: basis === 'odds' ? 'odds' : '' },
          el('th', { scope: 'row' }, basis === 'model' ? BET_LABEL[bk] : '└ オッズ順で同じ形'),
          el('td', {}, pct(r.hit_rate)),
          el('td', {}, pct(r.roi), el('span', { class: 'ci' }, `${pct(r.roi_ci_low, 0)}〜${pct(r.roi_ci_high, 0)}`)),
          el('td', {}, pct(r.roi_without_max))));
      }
    }
    box.append(el('div', { class: 'tblwrap' }, el('table', { class: 'bets' },
      el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, '券種'), el('th', { scope: 'col' }, '的中率'),
        el('th', { scope: 'col' }, '回収率（95%区間）'), el('th', { scope: 'col' }, '最大の当たりを除く'))), tb)));
  }
  box.append(el('p', { class: 'small' }, '1点100円で、先に決めた組み方を過去のレースに当てはめた計算です。回収率100%未満は損。分析の補助で、購入を勧めるものではありません。'));
  return box;
}

// 資金配分（予算・トリガミを避ける分け方）の成績表
export function stakeBlock(bl) {
  const box = el('div', { class: 'betsbox' });
  box.append(el('h3', {}, `資金配分の成績：${bl.period || ''}`),
    el('p', { class: 'small' }, `決まり：${bl.rule || ''}。どの組が当たっても払戻が予算を下回らないよう、前日オッズで口数を決めた計算です。`));
  for (const s of Array.isArray(bl.segments) ? bl.segments : []) {
    if (!s || typeof s !== 'object') continue;
    box.append(el('h4', {}, s.label));
    const tb = el('tbody');
    for (const bk of Object.keys(BET_LABEL)) {
      const r = (Array.isArray(s.rows) ? s.rows : []).find((x) => x && x.bet === bk);
      if (!r) continue;
      tb.append(el('tr', {},
        el('th', { scope: 'row' }, BET_LABEL[bk], el('span', { class: 'ci' }, `${r.n_races ?? '—'}レース・見送り${r.n_skipped ?? '—'}`)),
        el('td', {}, pct(r.roi), el('span', { class: 'ci' }, `${pct(r.roi_ci_low, 0)}〜${pct(r.roi_ci_high, 0)}`)),
        el('td', {}, pct(r.hit_rate), el('span', { class: 'ci' }, `最大除く ${pct(r.roi_without_max)}`)),
        el('td', {}, String(r.n_trigami ?? '—')),
        el('td', {}, yen(r.cost_yen), el('span', { class: 'ci' }, `払戻 ${yen(r.pay_yen)}`))));
    }
    box.append(el('div', { class: 'tblwrap' }, el('table', { class: 'bets' },
      el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, '券種'), el('th', { scope: 'col' }, '回収率（95%区間）'),
        el('th', { scope: 'col' }, '的中率'), el('th', { scope: 'col' }, 'トリガミ'), el('th', { scope: 'col' }, '購入総額'))), tb)));
  }
  box.append(el('p', { class: 'small' }, '前日オッズと最終オッズはずれるので、当たっても払戻が購入額を下回る「トリガミ」が起きます（表の回数）。分析の補助で、購入を勧めるものではありません。'));
  return box;
}

// 成績画面に出す中身を 1 つの形にそろえる。実際の成績は取り込んだ成績ファイル（keiba-stats/v1）からだけ（R1）
function statsSource() {
  if (state.stats) {
    const s = state.stats;
    return { real: s.kind === 'stats', label: s.kind === 'stats'
      ? `取り込んだ実データの成績（作成 ${s.generated_at.replace('T', ' ').slice(0, 16)}）・この端末の中だけに保存`
      : 'デモの成績ファイル（架空の数字）', b25: s.backtest_2025, v26: s.validation_2026, odds: s.odds_only, trio: s.trio, bets: s.bets, stake: s.stake, notes: s.notes };
  }
  const b = state.demo && state.demo.backtest;
  if (!b) return null;
  return { real: false, label: 'デモの数字です（架空のデータで計算した動作確認用。意味はありません）', b25: b, v26: null, odds: null, trio: null, bets: b.bets, stake: b.stake, notes: b.notes };
}

function viewStats(root) {
  root.append(el('h2', {}, '成績'));
  const S = statsSource();
  if (!S) { root.append(el('p', { class: 'empty' }, '成績のデータがありません。')); return; }
  root.append(el('div', { class: 'srcbar' + (S.real ? '' : ' demo') }, '表示中：' + S.label));
  if (!S.real) {
    root.append(el('p', { class: 'warnbox' }, 'これはデモの数字です。実際の成績は、パソコンで作った成績ファイル（stats_….json）を「取り込み」から入れると表示されます。'));
  }
  if (S.real) root.append(el('p', { class: 'small' }, '成績ファイルは「取り込み」の画面で消せます。'));
  if (Array.isArray(S.bets) && S.bets.length) {
    for (const bl of S.bets) if (bl && typeof bl === 'object') root.append(betsBlock(bl));
  } else {
    root.append(el('p', { class: 'muted' }, '券種ごとの成績（★5・★4・合算）は、成績ファイルにあるときだけ表示します。'));
  }
  if (Array.isArray(S.stake) && S.stake.length) {
    for (const bl of S.stake) if (bl && typeof bl === 'object') root.append(stakeBlock(bl));
  }
  const b = S.b25 || {};
  const v = S.v26;
  if (v && typeof v === 'object') {
    root.append(el('h3', {}, '2026年の検証（目標を測った成績）'));
    root.append(el('p', { class: 'muted' }, `${v.period || ''}　全 ${v.n_races ?? '—'} レース`));
    root.append(metricTiles(v));
  }
  const oo = S.odds;
  if (oo && Array.isArray(oo.rows) && oo.rows.length) {
    root.append(el('h3', {}, 'オッズだけで選んだ場合との比較'));
    root.append(el('p', { class: 'muted' }, `${oo.method || ''}${oo.source ? `（出典：${oo.source}）` : ''}`));
    const tl = [];
    if (v) tl.push(tile('モデル（2026年・自信：高）', pct(v.conf_place_rate), `${v.n_conf ?? '—'}レース・${ciText(v)}`));
    for (const r of oo.rows) {
      if (!r || typeof r !== 'object') continue;
      tl.push(tile(`オッズだけ（${r.label || ''}）`, pct(r.rate), `${r.n ?? '—'}レース・${ciText(r)}${r.ret != null ? `・回収率 ${pct(r.ret)}` : ''}`));
    }
    root.append(el('div', { class: 'tiles' }, ...tl));
  }
  root.append(el('h3', {}, '2025年の前向き検証（しきい値を決めた期間）'));
  root.append(el('p', { class: 'muted' }, `${b.period || ''}　全 ${b.n_races ?? '—'} レース`));
  root.append(metricTiles(b));
  if (S.trio && typeof S.trio === 'object') root.append(trioBlock(S.trio));
  else root.append(el('p', { class: 'muted' }, '三連複の成績は、取り込んだ成績ファイルにあるときだけ表示します。'));
  if (Array.isArray(S.notes) && S.notes.length) {
    root.append(el('h3', {}, '読むときの注意'));
    root.append(el('ul', { class: 'notes' }, ...S.notes.filter((n) => typeof n === 'string').map((n) => el('li', {}, n))));
  }
  root.append(el('div', { class: 'explain' },
    el('p', {}, '星（★1〜★5）は、本命が3着以内に入る確率の見積もりで2025年の全レースを同じ数ずつ5つに分けたものです。★4以上は上位およそ40%。旧しきい値（上位約9%）は、複勝80%の目標を測った範囲として残しています。'),
    el('p', {}, '「複勝的中率」は本命が3着以内（7頭以下は2着以内）に入った割合です。「95%区間」は本当の率がたぶんこの範囲という幅です。'),
    el('p', {}, '的中率が高くても、払戻が少ないと回収率は100%を下回ります。的中率だけで判断しないでください。')));
}

function viewImport(root) {
  root.append(el('h2', {}, '予想を取り込む'));
  root.append(el('p', { class: 'warnbox' }, 'この予想はあなたの端末の中だけに保存されます。他人に見せたり公開したりしないでください（データ提供元の規約）。アプリは予想をどこにも送信しません。'));
  const msg = el('div', { class: 'msg', role: 'status', 'aria-live': 'polite' }, state.flash || '');
  state.flash = '';
  const input = el('input', { type: 'file', accept: '.json,application/json', id: 'file' });
  input.addEventListener('change', async () => {
    const f = input.files && input.files[0];
    if (!f) return;
    msg.textContent = '';
    if (f.size > 5000000) { msg.textContent = '受け付けませんでした：E_SIZE（ファイルが大きすぎます）'; return; }
    const text = await f.text();
    if (isStatsText(text)) {
      // 成績 JSON（pipeline の `cli stats` が出すもの）。最新の 1 件だけを端末に保存する
      try {
        const r = saveStats(text);
        if (!r.ok) { msg.textContent = `受け付けませんでした：${r.code}（場所 ${r.path}）。成績ファイルを取り込んでいません。`; return; }
        state.stats = r.stats;
        state.flash = `成績ファイルを取り込みました（作成 ${r.stats.generated_at.replace('T', ' ').slice(0, 16)}）。「成績」で見られます。`;
        render();
      } catch (e) {
        msg.textContent = '保存できませんでした：' + e.message;
      }
      return;
    }
    const prep = await prepareImport(text, state.files);
    if (prep.status === 'invalid') {
      msg.textContent = `受け付けませんでした：${prep.code}（場所 ${prep.path}）。ファイル全体を取り込んでいません。`;
      return;
    }
    if (prep.status === 'duplicate') { msg.textContent = 'このファイルはすでに取り込まれています。'; return; }
    if (prep.replaces.length && !window.confirm('同じ日付の予想がすでにあります。新しいファイルで置き換えますか？')) { msg.textContent = '取り込みをやめました。'; return; }
    if (prep.overLimit && !window.confirm(`保存できるのは ${MAX_FILES} ファイルまでです。いちばん古い日付のものを消して取り込みますか？`)) { msg.textContent = '取り込みをやめました。'; return; }
    try {
      state.files = commitImport(state.files, prep);
      state.useDemo = false;
      // 画面を作り直してもメッセージが消えないように、次の描画で出す
      state.flash = `取り込みました（${prep.entry.dates.join('、')}・${prep.entry.data.races.length} レース）。`;
      render();
      return;
    } catch (e) {
      msg.textContent = '保存できませんでした：' + e.message;
    }
    input.value = '';
  });
  root.append(el('label', { class: 'filebtn', for: 'file' }, 'ファイルを選ぶ（yosou_….json または stats_….json）'), input, msg);
  root.append(el('h3', {}, `保存済み（${state.files.length} / ${MAX_FILES}）`));
  const ul = el('ul', { class: 'files' });
  for (const f of state.files) {
    let label;
    try {
      label = `${f.dates.join('、')}（${f.data.races.length} レース・作成 ${String(f.generated_at).slice(0, 16).replace('T', ' ')}）`;
    } catch (e) {
      label = '（読めない予想ファイル）';
    }
    ul.append(el('li', {}, el('span', {}, label),
      el('button', { type: 'button', class: 'small-btn', onclick: () => {
        if (!window.confirm('この予想を端末から消しますか？')) return;
        state.files = state.files.filter((x) => x.id !== f.id);
        saveFiles(state.files);
        render();
      } }, '消す')));
  }
  if (!state.files.length) ul.append(el('li', { class: 'muted' }, 'まだありません。'));
  root.append(ul);
  // 成績ファイル（N11：取り込んだものが見えて、それだけを消せる）
  root.append(el('h3', {}, '成績ファイル（stats_….json）'));
  const us = el('ul', { class: 'files' });
  if (state.stats) {
    us.append(el('li', {}, el('span', {}, `${state.stats.kind === 'stats' ? '実データの成績' : 'デモの成績'}（作成 ${String(state.stats.generated_at).slice(0, 16).replace('T', ' ')}）`),
      el('button', { type: 'button', class: 'small-btn', onclick: () => {
        if (!window.confirm('成績ファイルを端末から消しますか？（予想は消えません）')) return;
        clearStats();
        state.stats = null;
        render();
      } }, '消す')));
  } else {
    us.append(el('li', { class: 'muted' }, 'まだありません（成績の画面はデモの数字を表示します）。'));
  }
  root.append(us);
  root.append(el('label', { class: 'toggle' },
    el('input', { type: 'checkbox', checked: state.useDemo || !state.files.length, disabled: !state.files.length,
      onchange: (e) => { state.useDemo = e.target.checked; render(); } }), ' デモ（架空データ）のレースを表示する（成績ファイルの表示は変わりません）'));
  root.append(el('button', { type: 'button', class: 'danger', onclick: () => {
    if (!window.confirm('すべての予想と成績ファイルを端末から消します。元に戻せません。よろしいですか？')) return;
    clearAll();
    state.files = [];
    state.stats = null;
    render();
  } }, 'すべての予想と成績ファイルを端末から消す'));
}

const DISCLAIMER = 'このアプリは分析の補助です。的中を保証するものではありません。馬券の購入は自己責任で。20歳未満は馬券を購入できません。';

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch (e) { return ''; }   // 壊れた URL は「見つかりません」にする
}

function emergencyBox(main, err) {
  // 画面の途中で問題が起きても、消す手段と説明は必ず出す
  main.append(el('div', { class: 'warnbox', role: 'alert' }, 'この画面を表示できませんでした。保存データが壊れている可能性があります。（' + String(err && err.message ? err.message : err) + '）'),
    el('button', { type: 'button', class: 'danger', onclick: () => {
      if (!window.confirm('すべての予想を端末から消します。元に戻せません。よろしいですか？')) return;
      clearAll(); state.files = []; state.stats = null; state.useDemo = false; location.hash = '#/races'; render();
    } }, 'すべての予想と成績ファイルを端末から消す'));
}

export function render() {
  const main = document.getElementById('main');
  if (!main) return;
  main.replaceChildren();
  try {
    if (state.notice) main.append(el('div', { class: 'warnbox', role: 'alert' }, state.notice));
    const h = location.hash || '#/races';
    document.querySelectorAll('nav a').forEach((a) => a.setAttribute('aria-current', h.startsWith(a.getAttribute('href')) || ((h.startsWith('#/race/') || h.startsWith('#/build/')) && a.getAttribute('href') === '#/races') ? 'page' : 'false'));
    const view = el('div');
    main.append(view);
    try {
      if (h.startsWith('#/race/')) viewRace(view, safeDecode(h.slice(7)));
      else if (h.startsWith('#/build/')) viewBuild(view, safeDecode(h.slice(8)));
      else if (h.startsWith('#/stats')) viewStats(view);
      else if (h.startsWith('#/import')) viewImport(view);
      else viewRaces(view);
    } catch (err) {
      emergencyBox(main, err);
    }
  } finally {
    main.append(el('p', { class: 'disclaimer' }, DISCLAIMER));
    if (!state.keepScroll) window.scrollTo(0, 0);   // 組み合わせ画面で馬を選ぶたびに上へ戻らないように
    state.keepScroll = false;
  }
}

async function loadDemo() {
  try {
    const res = await fetch('./data/demo.json', { cache: 'no-cache' });
    const text = await res.text();
    const v = validatePredictionText(text);
    if (!v.ok) { state.notice = `デモデータが検査に通りません（${v.code} ${v.path}）`; return; }
    state.demo = JSON.parse(text);
  } catch (e) {
    state.notice = 'デモデータを読み込めませんでした（通信なしで初めて開いた場合など）。';
  }
}

function setupSW() {
  if (!('serviceWorker' in navigator)) return;
  let asked = false;
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    const offer = (w) => {
      const bar = document.getElementById('updatebar');
      if (!bar) return;
      bar.hidden = false;
      bar.querySelector('button').onclick = () => { asked = true; w.postMessage({ type: 'SKIP_WAITING' }); };
    };
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (!w) return;
      w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w); });
    });
  }).catch(() => { /* 内蔵ブラウザなどでは登録できない */ });
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (asked) location.reload(); });
}

export async function start() {
  const loaded = loadFiles();
  state.files = loaded.files;
  if (loaded.removed) state.notice = `保存されていた予想のうち ${loaded.removed} 件が壊れていたので消しました。もう一度取り込んでください。`;
  if (loaded.unavailable) state.notice = 'この端末ではデータを保存できません（プライベートモードなど）。デモだけ表示します。';
  const st = loadStats();
  state.stats = st.stats;
  if (st.removed) state.notice = (state.notice ? state.notice + ' ' : '') + '保存されていた成績ファイルが壊れていたので消しました。';
  await loadDemo();
  window.addEventListener('hashchange', render);
  render();
  setupSW();
}
