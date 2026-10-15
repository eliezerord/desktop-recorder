// Camera pipeline: opens a camera and draws every frame onto a canvas, with an optional background
// effect (blur, a color or an image). The bubble, camera-only recordings and window recordings all
// use it, so the effect looks the same everywhere.
// The person is found with MediaPipe's selfie segmenter, bundled with the app so it works offline.
import { FilesetResolver, ImageSegmenter } from '../node_modules/@mediapipe/tasks-vision/vision_bundle.mjs';

const WASM_DIR = new URL('../node_modules/@mediapipe/tasks-vision/wasm', import.meta.url).href;
const MODEL = new URL('./models/selfie_segmenter.tflite', import.meta.url).href;
const MASK_WIDTH = 256; // the model works on a small copy of the frame; the mask is scaled back up
const BLUR_PX = 16; // how much the background is blurred
const EDGE_SOFTEN_PX = 2; // softens the cut-out edge so hair does not look jagged

let segmenterPromise = null;

// One segmenter per window, created the first time an effect is turned on.
function getSegmenter() {
  if (!segmenterPromise) {
    segmenterPromise = (async () => {
      const files = await FilesetResolver.forVisionTasks(WASM_DIR);
      const options = (delegate) => ({
        baseOptions: { modelAssetPath: MODEL, delegate },
        runningMode: 'VIDEO',
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      });
      try {
        return await ImageSegmenter.createFromOptions(files, options('GPU'));
      } catch (err) {
        console.warn(`GPU segmentation is not available, using the CPU: ${err.message}`);
        return ImageSegmenter.createFromOptions(files, options('CPU'));
      }
    })();
    segmenterPromise.catch(() => { segmenterPromise = null; }); // lets a later attempt retry
  }
  return segmenterPromise;
}

export function createCameraPipeline(canvas, { idealWidth = 1280, idealHeight = 720 } = {}) {
  const ctx = canvas.getContext('2d');
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  const small = document.createElement('canvas');
  const smallCtx = small.getContext('2d', { willReadFrequently: true });
  const mask = document.createElement('canvas');
  const maskCtx = mask.getContext('2d');
  const person = document.createElement('canvas');
  const personCtx = person.getContext('2d');

  let stream = null;
  let deviceId = null;
  let request = 0;
  let effect = { background: 'none', color: '#2f5bff', image: null };
  let backgroundImage = null;
  let segmenter = null;
  let running = false;
  let lastError = null;

  function setEffect(next) {
    effect = { ...effect, ...next };
    if (effect.background === 'image' && effect.image) {
      const img = new Image();
      img.onload = () => { backgroundImage = img; };
      img.src = effect.image;
    } else {
      backgroundImage = null;
    }
    if (effect.background !== 'none' && !segmenter) {
      getSegmenter().then((s) => { segmenter = s; }).catch((err) => {
        lastError = `The effect could not load: ${err.message}`;
        console.error(lastError);
      });
    }
  }

  async function setCamera(id) {
    if (id === deviceId && stream) return;
    deviceId = id;
    const mine = ++request;
    stopStream();
    if (!id) { ctx.clearRect(0, 0, canvas.width, canvas.height); return; }
    try {
      const next = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: id }, width: { ideal: idealWidth }, height: { ideal: idealHeight }, frameRate: { ideal: 30 } },
        audio: false,
      });
      // A newer camera choice arrived while this one was opening: drop this one.
      if (mine !== request) { next.getTracks().forEach((t) => t.stop()); return; }
      stream = next;
      video.srcObject = stream;
      await video.play();
      lastError = null;
      start();
    } catch (err) {
      deviceId = null; // lets the same camera be tried again
      lastError = `The camera could not open: ${err.name} ${err.message}`;
      console.error(lastError);
    }
  }

  function stopStream() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
  }

  function sizeTo(w, h) {
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    if (person.width !== w || person.height !== h) { person.width = w; person.height = h; }
    const sw = MASK_WIDTH;
    const sh = Math.max(1, Math.round((MASK_WIDTH * h) / w));
    if (small.width !== sw || small.height !== sh) {
      small.width = sw; small.height = sh;
      mask.width = sw; mask.height = sh;
    }
  }

  function drawBackground(w, h) {
    if (effect.background === 'blur') {
      // Drawn a little larger than the canvas so the blur does not darken the edges.
      const pad = BLUR_PX * 2;
      ctx.filter = `blur(${BLUR_PX}px)`;
      ctx.drawImage(video, -pad, -pad, w + pad * 2, h + pad * 2);
      ctx.filter = 'none';
    } else if (effect.background === 'image' && backgroundImage) {
      const s = Math.max(w / backgroundImage.width, h / backgroundImage.height); // cover
      const iw = backgroundImage.width * s;
      const ih = backgroundImage.height * s;
      ctx.drawImage(backgroundImage, (w - iw) / 2, (h - ih) / 2, iw, ih);
    } else {
      ctx.fillStyle = effect.color;
      ctx.fillRect(0, 0, w, h);
    }
  }

  function drawFrame(now) {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return;
    sizeTo(w, h);
    if (effect.background === 'none' || !segmenter) {
      ctx.drawImage(video, 0, 0, w, h);
      return;
    }
    smallCtx.drawImage(video, 0, 0, small.width, small.height);
    let result;
    try {
      result = segmenter.segmentForVideo(small, now);
    } catch (err) {
      ctx.drawImage(video, 0, 0, w, h);
      return;
    }
    const masks = result.confidenceMasks || [];
    // The selfie model gives one mask: how likely each pixel is the person.
    const confidence = masks[masks.length - 1].getAsFloat32Array();
    const pixels = maskCtx.createImageData(small.width, small.height);
    for (let i = 0; i < confidence.length; i++) pixels.data[i * 4 + 3] = confidence[i] * 255;
    maskCtx.putImageData(pixels, 0, 0);
    result.close();

    drawBackground(w, h);
    personCtx.globalCompositeOperation = 'source-over';
    personCtx.clearRect(0, 0, w, h);
    personCtx.drawImage(video, 0, 0, w, h);
    personCtx.globalCompositeOperation = 'destination-in';
    personCtx.filter = `blur(${EDGE_SOFTEN_PX}px)`;
    personCtx.drawImage(mask, 0, 0, w, h);
    personCtx.filter = 'none';
    ctx.drawImage(person, 0, 0);
  }

  // One draw per camera frame. requestVideoFrameCallback keeps going in hidden windows too.
  function start() {
    if (running) return;
    running = true;
    const loop = (now) => {
      if (!running || !stream) { running = false; return; }
      drawFrame(now);
      video.requestVideoFrameCallback(loop);
    };
    video.requestVideoFrameCallback(loop);
  }

  return {
    setCamera,
    setEffect,
    stream: (fps = 30) => canvas.captureStream(fps),
    hasCamera: () => Boolean(stream),
    effectReady: () => effect.background === 'none' || Boolean(segmenter),
    lastError: () => lastError,
    stop: () => { running = false; deviceId = null; stopStream(); },
  };
}
