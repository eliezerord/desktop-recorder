// Bubble toolbar: sends the clicked action. Showing and hiding the bar is decided by the main process.
document.querySelector('.bar').addEventListener('click', (e) => {
  const button = e.target.closest('button');
  if (button) window.api.toolbarAction(button.dataset.action);
});

window.api.onToolbarState(({ size }) => {
  const full = size === 'full';
  document.body.classList.toggle('full', full);
  for (const b of document.querySelectorAll('button')) b.classList.toggle('on', b.dataset.action === size);
  const fullButton = document.getElementById('full');
  fullButton.title = full ? 'Salir de pantalla completa (Esc)' : 'Pantalla completa';
  fullButton.setAttribute('aria-label', fullButton.title);
});
