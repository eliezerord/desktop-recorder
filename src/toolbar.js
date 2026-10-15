// Bubble toolbar: sends the clicked action. Showing and hiding the bar is decided by the main process.
const { t, DEFAULT } = window.DrecI18n;
let lang = DEFAULT;
let size = 'small';

document.querySelector('.bar').addEventListener('click', (e) => {
  const button = e.target.closest('button');
  if (button) window.api.toolbarAction(button.dataset.action);
});

const KEYS = { close: 'toolbar.close', small: 'toolbar.small', medium: 'toolbar.medium' };

function draw() {
  const full = size === 'full';
  document.body.classList.toggle('full', full);
  document.documentElement.lang = lang;
  for (const b of document.querySelectorAll('button')) {
    b.classList.toggle('on', b.dataset.action === size);
    const key = b.dataset.action === 'full' ? (full ? 'toolbar.exitFull' : 'toolbar.full') : KEYS[b.dataset.action];
    b.title = t(lang, key);
    b.setAttribute('aria-label', b.title);
  }
}

window.api.onToolbarState((s) => { size = s.size; draw(); });
window.api.onLanguage((next) => { lang = next; draw(); });
draw();
