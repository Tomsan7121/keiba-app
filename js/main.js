// 入口。読み込みに失敗したとき（古いファイルと新しいファイルが混ざったときなど。N14）は、空の画面にせず案内を出す。
const FILES = ['./js/app.js', './js/validate.js', './js/store.js', './js/bets.js', './css/style.css', './index.html'];

function showError() {
  const main = document.getElementById('main');
  if (!main) return;
  const p = document.createElement('p');
  p.className = 'warnbox';
  p.setAttribute('role', 'alert');
  p.textContent = 'アプリを読み込めませんでした。古いファイルが端末に残っている可能性があります。下のボタンで読み込み直してください（取り込んだ予想は消えません）。';
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'filebtn';
  b.textContent = '読み込み直す';
  b.addEventListener('click', async () => {
    try {
      if ('caches' in window) for (const k of await caches.keys()) if (k.startsWith('kyp-')) await caches.delete(k);
      await Promise.all(FILES.map((f) => fetch(f, { cache: 'reload' }).catch(() => null)));
    } finally {
      location.reload();
    }
  });
  main.replaceChildren(p, b);
}

import('./app.js').then((m) => m.start()).catch(showError);
