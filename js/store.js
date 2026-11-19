// 端末の中（localStorage）だけに予想を保存する。どこにも送信しない。
import { validatePredictionText, validateStatsText } from './validate.js';

export const KEY = 'kyp.v1.files';
export const MAX_FILES = 8;
const RE_ID = /^[0-9a-f]{64}$/;
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;

function ls() {
  try { return window.localStorage; } catch (e) { return null; }
}

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 保存済みデータを1件ずつ検査する。壊れていたものは消し、消した件数を返す（黙って消さない：呼び出し側で表示）
export function loadFiles() {
  const s = ls();
  if (!s) return { files: [], removed: 0, unavailable: true };
  let raw;
  try { raw = s.getItem(KEY); } catch (e) { return { files: [], removed: 0, unavailable: true }; }
  if (raw === null) return { files: [], removed: 0 };
  let arr;
  try { arr = JSON.parse(raw); } catch (e) { arr = null; }
  if (!Array.isArray(arr)) {
    try { s.removeItem(KEY); } catch (e) { /* 何もしない */ }
    return { files: [], removed: 1 };
  }
  const ok = [];
  let removed = 0;
  for (const f of arr) {
    // 画面で使う欄はすべて型を確かめる（1件の型違いで画面が止まらないように）
    const good = f && typeof f === 'object' && !Array.isArray(f) && typeof f.id === 'string' && RE_ID.test(f.id)
      && typeof f.imported_at === 'string' && typeof f.generated_at === 'string'
      && Array.isArray(f.dates) && f.dates.length > 0 && f.dates.every((d) => typeof d === 'string' && RE_DATE.test(d))
      && f.data && typeof f.data === 'object' && validatePredictionText(JSON.stringify(f.data)).ok
      && f.generated_at === f.data.generated_at;
    if (good) ok.push(f); else removed++;
  }
  if (removed) saveFiles(ok);
  return { files: ok, removed };
}

export function saveFiles(files) {
  const s = ls();
  if (!s) throw new Error('この端末ではデータを保存できません（プライベートモードなど）');
  s.setItem(KEY, JSON.stringify(files));
}

export function clearAll() {
  const s = ls();
  if (s) { s.removeItem(KEY); s.removeItem(STATS_KEY); }
}

// --- 成績 JSON（keiba-stats/v1）。最新の 1 件だけを端末の中に保存する ---
export const STATS_KEY = 'kyp.v1.stats';

export function loadStats() {
  const s = ls();
  if (!s) return { stats: null, removed: 0 };
  let raw;
  try { raw = s.getItem(STATS_KEY); } catch (e) { return { stats: null, removed: 0 }; }
  if (raw === null) return { stats: null, removed: 0 };
  if (!validateStatsText(raw).ok) {
    try { s.removeItem(STATS_KEY); } catch (e) { /* 何もしない */ }
    return { stats: null, removed: 1 };
  }
  return { stats: JSON.parse(raw), removed: 0 };
}

export function clearStats() {
  const s = ls();
  if (s) s.removeItem(STATS_KEY);
}

export function saveStats(text) {
  const v = validateStatsText(text);
  if (!v.ok) return v;
  const s = ls();
  if (!s) throw new Error('この端末ではデータを保存できません（プライベートモードなど）');
  s.setItem(STATS_KEY, text);
  return { ok: true, stats: JSON.parse(text) };
}

// 取り込むファイルが成績 JSON か（schema だけを見る。中身の検査は saveStats で行う）
export function isStatsText(text) {
  try { const o = JSON.parse(text); return !!o && typeof o === 'object' && o.schema === 'keiba-stats/v1'; } catch (e) { return false; }
}

// 取り込みの準備：検査して、重複・置き換え・上限超えを調べる（まだ保存しない）
export async function prepareImport(text, files) {
  const v = validatePredictionText(text);
  if (!v.ok) return { status: 'invalid', ...v };
  const data = JSON.parse(text);
  const id = await sha256Hex(text);
  if (files.some((f) => f.id === id)) return { status: 'duplicate', id };
  const dates = [...new Set(data.races.map((r) => r.date))].sort();
  const sameDates = files.filter((f) => f.dates.some((d) => dates.includes(d)));
  const entry = { id, imported_at: new Date().toISOString(), generated_at: data.generated_at, dates, data };
  return { status: 'ready', entry, replaces: sameDates.map((f) => f.id), overLimit: files.length - sameDates.length + 1 > MAX_FILES };
}

export function commitImport(files, prep) {
  let next = files.filter((f) => !prep.replaces.includes(f.id));
  next.push(prep.entry);
  next.sort((a, b) => (a.dates[0] < b.dates[0] ? -1 : 1));
  while (next.length > MAX_FILES) next.shift();   // 古い日付から消す（確認のあとだけ呼ぶ）
  saveFiles(next);
  return next;
}
