// Draws a soft circle that grows and fades where a click happened.
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const RIPPLE_MS = 550; // long enough to see in a video, short enough not to cover the next click
const START_RADIUS = 10;
const END_RADIUS = 34;
const COLOR = '255, 214, 10'; // warm yellow, visible on light and dark screens
const ripples = [];
let animating = false;

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();

function frame(now) {
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  for (let i = ripples.length - 1; i >= 0; i--) {
    const t = (now - ripples[i].start) / RIPPLE_MS;
    if (t >= 1) { ripples.splice(i, 1); continue; }
    const r = START_RADIUS + (END_RADIUS - START_RADIUS) * t;
    const fade = 1 - t;
    ctx.beginPath();
    ctx.arc(ripples[i].x, ripples[i].y, r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${COLOR}, ${0.35 * fade})`;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = `rgba(${COLOR}, ${0.9 * fade})`;
    ctx.stroke();
  }
  if (ripples.length) requestAnimationFrame(frame);
  else animating = false;
}

window.api.onClickAt(({ x, y }) => {
  ripples.push({ x, y, start: performance.now() });
  if (!animating) {
    animating = true;
    requestAnimationFrame(frame);
  }
});

// For the smoke test: how many circles are on screen right now.
window.rippleCount = () => ripples.length;
