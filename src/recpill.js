// Recording pill next to the bubble: record or stop, elapsed time, pause or resume.
// The recording itself runs in the control panel; this only sends the same actions as the shortcuts.
const ICONS = {
  record: '<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="6.5"/></svg>',
  stop: '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="2.5" y="2.5" width="11" height="11" rx="2"/></svg>',
  pause: '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="2" width="3.5" height="12" rx="1"/><rect x="9.5" y="2" width="3.5" height="12" rx="1"/></svg>',
  resume: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5v11l9.5-5.5z"/></svg>',
  saving: '<span class="count">…</span>',
};

const mainButton = document.getElementById('main');
const pauseButton = document.getElementById('pause');
const time = document.getElementById('time');

mainButton.addEventListener('click', () => window.api.recAction('toggle'));
pauseButton.addEventListener('click', () => window.api.recAction('pause'));

// The time arrives 4 times a second. Replacing a button's icon between press and release makes
// the browser drop the click, so the icon is only replaced when it really changes.
function setIcon(button, key, html) {
  if (button.dataset.icon === key) return;
  button.dataset.icon = key;
  button.innerHTML = html;
}

function label(button, text) {
  if (button.title === text) return;
  button.title = text;
  button.setAttribute('aria-label', text);
}

window.api.onRecState(({ phase, time: t, count }) => {
  const live = phase === 'recording' || phase === 'paused';
  document.body.classList.toggle('live', phase === 'recording');
  document.body.classList.toggle('paused', phase === 'paused');
  time.textContent = t || '00:00';

  if (phase === 'countdown') {
    const n = Number(count) || '';
    setIcon(mainButton, `count-${n}`, `<span class="count">${n}</span>`);
    mainButton.disabled = true;
  } else if (phase === 'saving') {
    setIcon(mainButton, 'saving', ICONS.saving);
    mainButton.disabled = true;
    label(mainButton, 'Guardando');
  } else if (live) {
    setIcon(mainButton, 'stop', ICONS.stop);
    mainButton.disabled = false;
    label(mainButton, 'Parar (Ctrl+Shift+R)');
  } else {
    setIcon(mainButton, 'record', ICONS.record);
    mainButton.disabled = false;
    label(mainButton, 'Grabar (Ctrl+Shift+R)');
  }

  pauseButton.disabled = !live;
  setIcon(pauseButton, phase === 'paused' ? 'resume' : 'pause', phase === 'paused' ? ICONS.resume : ICONS.pause);
  label(pauseButton, phase === 'paused' ? 'Reanudar (Ctrl+Shift+P)' : 'Pausar (Ctrl+Shift+P)');
});
