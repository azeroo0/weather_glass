import './style.css';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

const canvas = document.querySelector<HTMLCanvasElement>('#flowCanvas')!;
const slider = document.querySelector<HTMLInputElement>('#timeSlider')!;
const timeDisplay = document.querySelector<HTMLSpanElement>('#currentTime')!;
const weatherLabel = document.querySelector<HTMLSpanElement>('#weatherLabel')!;
const cityLabel = document.querySelector<HTMLSpanElement>('#cityLabel')!;
const lastUpdatedEl = document.querySelector<HTMLParagraphElement>('#lastUpdated')!;
const playButton = document.querySelector<HTMLButtonElement>('#playButton')!;
const ctx = canvas.getContext('2d')!;

const MAX_DEVICE_PIXEL_RATIO = 2;
const MOBILE_VIEWPORT_MAX_WIDTH = 480; // matches the site's existing mobile breakpoint
const MOBILE_PARTICLE_RATIO = 0.6;

// All particle/flow-field math below works in CSS-pixel space
// (0..viewWidth, 0..viewHeight). The canvas's backing store can be denser
// (up to MAX_DEVICE_PIXEL_RATIO) for crispness on high-DPI screens, but is
// capped so a 3x phone doesn't silently push 2.25x more pixels through
// every fill/stroke than a capped-at-2x display would.
let viewWidth = window.innerWidth;
let viewHeight = window.innerHeight;
let particleCountRatio = 1;

function resizeCanvas() {
  viewWidth = window.innerWidth;
  viewHeight = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO);

  canvas.width = viewWidth * dpr;
  canvas.height = viewHeight * dpr;
  canvas.style.width = `${viewWidth}px`;
  canvas.style.height = `${viewHeight}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  particleCountRatio = viewWidth <= MOBILE_VIEWPORT_MAX_WIDTH ? MOBILE_PARTICLE_RATIO : 1;
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

function getCurrentLocalHour(): number {
  const now = new Date();
  const hour = now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
  return Math.round(hour * 10) / 10;
}
slider.value = String(getCurrentLocalHour());

const PARTICLE_COUNT = 300;

interface Particle {
  x: number;
  y: number;
  seed: number;
  // Transient outward "ripple" velocity from a click/tap, added on top of
  // whatever the flow field says this frame. Decays to 0 each frame so the
  // particle settles back into its normal flow-field motion on its own.
  rvx: number;
  rvy: number;
}

const particles: Particle[] = Array.from({ length: PARTICLE_COUNT }, () => ({
  x: Math.random() * viewWidth,
  y: Math.random() * viewHeight,
  seed: Math.random(),
  rvx: 0,
  rvy: 0,
}));

type ColorKeyframe = {
  hour: number;
  color: [number, number, number];
};

const PARTICLE_KEYFRAMES: ColorKeyframe[] = [
  { hour: 0, color: [10, 10, 40] },
  { hour: 6, color: [255, 183, 178] },
  { hour: 12, color: [135, 206, 235] },
  { hour: 18, color: [255, 140, 66] },
  { hour: 24, color: [10, 10, 40] },
];

const BACKGROUND_KEYFRAMES: ColorKeyframe[] = [
  { hour: 0, color: [6, 8, 20] },
  { hour: 6, color: [76, 74, 110] },
  { hour: 12, color: [176, 214, 235] },
  { hour: 18, color: [92, 60, 66] },
  { hour: 24, color: [6, 8, 20] },
];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function interpolateKeyframes(keyframes: ColorKeyframe[], hour: number): [number, number, number] {
  let i = 0;
  while (i < keyframes.length - 2 && hour > keyframes[i + 1].hour) {
    i++;
  }
  const from = keyframes[i];
  const to = keyframes[i + 1];
  const t = (hour - from.hour) / (to.hour - from.hour);
  return [
    lerp(from.color[0], to.color[0], t),
    lerp(from.color[1], to.color[1], t),
    lerp(from.color[2], to.color[2], t),
  ];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function mixColor(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

function rgbString([r, g, b]: [number, number, number]): string {
  return `rgb(${r}, ${g}, ${b})`;
}

function labelForTime(hour: number): string {
  if (hour < 3 || hour >= 21) return '밤';
  if (hour < 9) return '새벽';
  if (hour < 15) return '정오';
  return '황혼';
}

function formatTime(hour: number): string {
  const totalMinutes = Math.round(hour * 60);
  const hh = Math.floor(totalMinutes / 60);
  const mm = totalMinutes % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Role split: the time slider only drives day/night ambient brightness
// (particle hue + background color keyframes above). Flow *dynamics* -
// speed, direction bias, turbulence - come entirely from the selected
// city's live weather, applied below.
interface CityWeather {
  name: string;
  temperature: number;
  windspeed: number; // km/h
  winddirection: number; // degrees, direction the wind is blowing FROM
  precipitation: number; // mm, last hour
  cloudcover: number; // %
  weathercode: number;
}

const cityWeatherByName = new Map<string, CityWeather>();
let selectedCityName: string | null = null;

// WMO weathercode -> which rendering mode the flow field uses. Each mode
// has its own particle shape AND motion logic (see drawSunnyParticle /
// drawCloudyParticle / drawRainParticle below) - this isn't just a
// parameter tweak, it's a different visual language per weather type.
type WeatherMode = 'sunny' | 'cloudy' | 'rainy';

function weatherModeFromCode(code: number): WeatherMode {
  if (code <= 1) return 'sunny';
  if (code === 2 || code === 3 || code === 45 || code === 48) return 'cloudy';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 99)) return 'rainy';
  return 'cloudy';
}

// Small decorative glyphs for the "Right now" list, independent of the
// hero canvas's currently-selected city - each reflects that row's own
// weathercode-derived mode.
const MODE_ICON: Record<WeatherMode, string> = {
  sunny: `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
    <circle cx="8" cy="8" r="3.2" fill="#ffd23c" />
    <g stroke="#ffd23c" stroke-width="1.2" stroke-linecap="round">
      <line x1="8" y1="0.8" x2="8" y2="2.4" />
      <line x1="8" y1="13.6" x2="8" y2="15.2" />
      <line x1="0.8" y1="8" x2="2.4" y2="8" />
      <line x1="13.6" y1="8" x2="15.2" y2="8" />
      <line x1="2.7" y1="2.7" x2="3.8" y2="3.8" />
      <line x1="12.2" y1="12.2" x2="13.3" y2="13.3" />
      <line x1="2.7" y1="13.3" x2="3.8" y2="12.2" />
      <line x1="12.2" y1="3.8" x2="13.3" y2="2.7" />
    </g>
  </svg>`,
  cloudy: `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
    <path d="M4.6 11.5a3 3 0 0 1-.5-5.95 3.5 3.5 0 0 1 6.7-1.3A3 3 0 0 1 12.4 11.5z" fill="#aab0ba" />
  </svg>`,
  rainy: `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
    <path d="M4.1 8.6a2.5 2.5 0 0 1-.4-4.97A3 3 0 0 1 9.2 2.2 2.5 2.5 0 0 1 12 4.5 2.5 2.5 0 0 1 11.5 9.5H4.1z" fill="#5b7ca3" />
    <g stroke="#5b7ca3" stroke-width="1.2" stroke-linecap="round">
      <line x1="5" y1="11" x2="4.3" y2="13.2" />
      <line x1="8" y1="11" x2="7.3" y2="13.2" />
      <line x1="11" y1="11" x2="10.3" y2="13.2" />
    </g>
  </svg>`,
};

function weatherModeIcon(mode: WeatherMode): string {
  return MODE_ICON[mode];
}

const MODE_PARTICLE_COUNT: Record<WeatherMode, number> = {
  sunny: 110,
  cloudy: PARTICLE_COUNT,
  rainy: 260,
};

// How fast each frame's fade-to-background overlay erases the previous
// frame. Sunny/cloudy need a quick wipe so particles read as discrete
// dots/blobs; rain keeps a slow wipe so its streaks accumulate into
// visible sheets of rain. Declared early: reduced-motion calls drawFrame()
// synchronously during the initial updateFromSlider(), before the bottom
// of this module has executed.
const TRAIL_FADE_ALPHA: Record<WeatherMode, number> = {
  sunny: 0.3,
  cloudy: 0.18,
  rainy: 0.05,
};

// Brightness always comes from the time-of-day color (PARTICLE_KEYFRAMES
// above) - weathercode only lays a light tint on top of it, so e.g. rainy
// at noon still reads as clearly brighter than rainy at midnight. Keep
// `strength` low; a high mix ratio would wash out the day/night signal
// entirely, which is exactly the bug this fixes.
const MODE_TINT: Record<WeatherMode, { color: [number, number, number]; strength: number }> = {
  sunny: { color: [255, 210, 60], strength: 0.4 },
  cloudy: { color: [150, 155, 165], strength: 0.4 },
  rainy: { color: [15, 20, 50], strength: 0.35 },
};

function resolveParticleColor(mode: WeatherMode, base: [number, number, number]): [number, number, number] {
  const tint = MODE_TINT[mode];
  return mixColor(base, tint.color, tint.strength);
}

let currentWeatherMode: WeatherMode = 'cloudy';
let flowSpeed = 1.5;
let flowBias = { x: 0, y: 0 };
let flowTurbulence = 0;
let cloudDarkenFactor = 1;

function applyWeatherToFlowField(weather: CityWeather | undefined) {
  if (!weather) {
    currentWeatherMode = 'cloudy';
    flowSpeed = 1.5;
    flowBias = { x: 0, y: 0 };
    flowTurbulence = 0;
    cloudDarkenFactor = 1;
    updateCursorColor();
    return;
  }

  currentWeatherMode = weatherModeFromCode(weather.weathercode);
  flowSpeed = clamp(0.4 + weather.windspeed * 0.06, 0.4, 4.5);

  const biasStrength = clamp(weather.windspeed / 20, 0.15, 1.5);
  const flowBearing = (weather.winddirection + 180) % 360; // wind blows TOWARD this bearing
  const biasAngle = ((flowBearing - 90) * Math.PI) / 180; // meteorological bearing -> canvas angle
  flowBias = { x: Math.cos(biasAngle) * biasStrength, y: Math.sin(biasAngle) * biasStrength };

  flowTurbulence = clamp(weather.precipitation * 0.15, 0, 1.2);
  cloudDarkenFactor = 1 - clamp(weather.cloudcover / 100, 0, 1) * 0.35;
  updateCursorColor();
}

function effectiveBackgroundRGB(hour: number): [number, number, number] {
  const [r, g, b] = interpolateKeyframes(BACKGROUND_KEYFRAMES, hour);
  return [r * cloudDarkenFactor, g * cloudDarkenFactor, b * cloudDarkenFactor];
}

let particleColorRGB = interpolateKeyframes(PARTICLE_KEYFRAMES, Number(slider.value));
let backgroundRGB = effectiveBackgroundRGB(Number(slider.value));

function srgbChannelToLinear(channel: number): number {
  const s = channel / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

// WCAG relative luminance (not a naive weighted average) so the
// black/white text switch happens exactly where contrast against white
// and against black cross over (~0.179), guaranteeing the higher-contrast
// choice is picked at every background color, not just most of them.
function relativeLuminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * srgbChannelToLinear(r) + 0.7152 * srgbChannelToLinear(g) + 0.0722 * srgbChannelToLinear(b);
}

const CONTRAST_CROSSOVER_LUMINANCE = Math.sqrt(1.05 * 0.05) - 0.05;

function applyAmbient(hour: number) {
  backgroundRGB = effectiveBackgroundRGB(hour);
  const [br, bg, bb] = backgroundRGB.map(Math.round);
  document.body.style.backgroundColor = `rgb(${br}, ${bg}, ${bb})`;
  document.body.classList.toggle('is-light', relativeLuminance(backgroundRGB) > CONTRAST_CROSSOVER_LUMINANCE);
}

function updateFromSlider() {
  const hour = Number(slider.value);
  particleColorRGB = interpolateKeyframes(PARTICLE_KEYFRAMES, hour);
  applyAmbient(hour);
  timeDisplay.textContent = formatTime(hour);
  weatherLabel.textContent = labelForTime(hour);
  slider.setAttribute('aria-valuetext', `${formatTime(hour)}, ${labelForTime(hour)}`);
  if (prefersReducedMotion) {
    drawFrame(0);
  }
}

const PLAYBACK_DURATION_MS = 12000;
let isPlayingDay = false;
let playbackStartTime = 0;

function stopDayPlayback() {
  isPlayingDay = false;
  playButton.textContent = '▶ 하루 흐름 보기';
  playButton.setAttribute('aria-pressed', 'false');
}

function playDayStep(now: number) {
  if (!isPlayingDay) return;
  const progress = Math.min((now - playbackStartTime) / PLAYBACK_DURATION_MS, 1);
  slider.value = String(progress * 24);
  updateFromSlider();
  if (progress >= 1) {
    stopDayPlayback();
    return;
  }
  requestAnimationFrame(playDayStep);
}

function startDayPlayback() {
  isPlayingDay = true;
  playButton.textContent = '■ 정지';
  playButton.setAttribute('aria-pressed', 'true');
  playbackStartTime = performance.now();
  requestAnimationFrame(playDayStep);
}

playButton.addEventListener('click', () => {
  if (isPlayingDay) {
    stopDayPlayback();
  } else {
    startDayPlayback();
  }
});

slider.addEventListener('input', () => {
  if (isPlayingDay) {
    stopDayPlayback();
  }
  updateFromSlider();
});
updateFromSlider();

const fadeUpSections = document.querySelectorAll<HTMLElement>('.fade-up');
if (prefersReducedMotion) {
  gsap.set(fadeUpSections, { opacity: 1, y: 0 });
} else {
  fadeUpSections.forEach((section) => {
    gsap.from(section, {
      opacity: 0,
      y: 40,
      duration: 0.8,
      ease: 'power2.out',
      clearProps: 'transform',
      scrollTrigger: {
        trigger: section,
        start: 'top 80%',
      },
    });
  });
}

function fieldAngle(x: number, y: number, time: number): number {
  return Math.sin(x * 0.01 + time) + Math.cos(y * 0.01 + time);
}

function wrapParticle(p: Particle) {
  if (p.x < 0) p.x = viewWidth;
  if (p.x > viewWidth) p.x = 0;
  if (p.y < 0) p.y = viewHeight;
  if (p.y > viewHeight) p.y = 0;
}

// Click/tap ripple: nearby particles get a momentary outward kick, then
// decay back to whatever the flow field is already telling them to do.
// Disabled entirely under prefers-reduced-motion.
const RIPPLE_RADIUS_RATIO = 0.175; // 15-20% of the smaller viewport dimension
const RIPPLE_MAX_IMPULSE = 14;
const RIPPLE_DECAY = 0.93;

function triggerRipple(originX: number, originY: number) {
  const radius = Math.min(viewWidth, viewHeight) * RIPPLE_RADIUS_RATIO;
  for (const p of particles) {
    const dx = p.x - originX;
    const dy = p.y - originY;
    const dist = Math.hypot(dx, dy);
    if (dist >= radius) continue;
    const falloff = 1 - dist / radius;
    const nx = dist > 0.0001 ? dx / dist : Math.random() * 2 - 1;
    const ny = dist > 0.0001 ? dy / dist : Math.random() * 2 - 1;
    p.rvx += nx * falloff * RIPPLE_MAX_IMPULSE;
    p.rvy += ny * falloff * RIPPLE_MAX_IMPULSE;
  }
}

function applyRipple(p: Particle) {
  if (p.rvx === 0 && p.rvy === 0) return;
  p.x += p.rvx;
  p.y += p.rvy;
  p.rvx *= RIPPLE_DECAY;
  p.rvy *= RIPPLE_DECAY;
  if (Math.abs(p.rvx) < 0.02) p.rvx = 0;
  if (Math.abs(p.rvy) < 0.02) p.rvy = 0;
}

if (!prefersReducedMotion) {
  canvas.addEventListener('pointerdown', (event) => {
    const rect = canvas.getBoundingClientRect();
    triggerRipple(event.clientX - rect.left, event.clientY - rect.top);
  });
}

// Continuous cursor distortion field: unlike the click ripple above, this
// has no decay state of its own - every frame it just reads the pointer's
// current position and pushes nearby particles outward in proportion to
// how close they are. Move the cursor away and the push term shrinks back
// toward 0 on its own (pure function of live distance), so particles drift
// back into their normal flow without any bounce/spring to overshoot.
const CURSOR_FIELD_RADIUS_RATIO = 0.12;
const CURSOR_FIELD_STRENGTH = 1.1;
let cursorFieldX = -Infinity;
let cursorFieldY = -Infinity;

function applyCursorField(p: Particle) {
  const radius = Math.min(viewWidth, viewHeight) * CURSOR_FIELD_RADIUS_RATIO;
  const dx = p.x - cursorFieldX;
  const dy = p.y - cursorFieldY;
  const dist = Math.hypot(dx, dy);
  if (dist >= radius || dist < 0.0001) return;
  const falloff = 1 - dist / radius;
  p.x += (dx / dist) * falloff * CURSOR_FIELD_STRENGTH;
  p.y += (dy / dist) * falloff * CURSOR_FIELD_STRENGTH;
}

if (!prefersReducedMotion) {
  window.addEventListener('mousemove', (event) => {
    const rect = canvas.getBoundingClientRect();
    cursorFieldX = event.clientX - rect.left;
    cursorFieldY = event.clientY - rect.top;
  });
  window.addEventListener('mouseleave', () => {
    cursorFieldX = -Infinity;
    cursorFieldY = -Infinity;
  });
}

// Depth layers: each mode's particle budget is split across back/mid/front
// so the flow field reads as layers of depth rather than one flat plane -
// back is smaller/slower/faintest, front is bigger/faster/most opaque.
type ParticleLayer = 'back' | 'mid' | 'front';
const PARTICLE_LAYERS: ParticleLayer[] = ['back', 'mid', 'front'];

const LAYER_CONFIG: Record<
  ParticleLayer,
  { countRatio: number; speedMul: number; turbulenceMul: number; sizeMul: number; alpha: number }
> = {
  back: { countRatio: 0.45, speedMul: 0.55, turbulenceMul: 0.6, sizeMul: 0.65, alpha: 0.35 },
  mid: { countRatio: 0.35, speedMul: 1, turbulenceMul: 1, sizeMul: 1, alpha: 0.7 },
  front: { countRatio: 0.2, speedMul: 1.7, turbulenceMul: 1.5, sizeMul: 1.45, alpha: 1 },
};

function layerForIndex(index: number, count: number): ParticleLayer {
  const backEnd = count * LAYER_CONFIG.back.countRatio;
  const midEnd = backEnd + count * LAYER_CONFIG.mid.countRatio;
  if (index < backEnd) return 'back';
  if (index < midEnd) return 'mid';
  return 'front';
}

// Cloudy's directional field, precomputed on a coarse grid once per frame
// instead of re-running the sin/cos formula for every particle - each
// particle then just reads its direction back with a cheap bilinear
// lookup, which stays cheap even as the particle budget grows.
const NOISE_GRID_SIZE = 40;
const noiseGrid = new Float32Array(NOISE_GRID_SIZE * NOISE_GRID_SIZE);

function computeNoiseGrid(time: number) {
  for (let gy = 0; gy < NOISE_GRID_SIZE; gy++) {
    const y = (gy / (NOISE_GRID_SIZE - 1)) * viewHeight;
    for (let gx = 0; gx < NOISE_GRID_SIZE; gx++) {
      const x = (gx / (NOISE_GRID_SIZE - 1)) * viewWidth;
      noiseGrid[gy * NOISE_GRID_SIZE + gx] = fieldAngle(x, y, time);
    }
  }
}

function sampleNoiseGrid(x: number, y: number): number {
  const gx = clamp((x / viewWidth) * (NOISE_GRID_SIZE - 1), 0, NOISE_GRID_SIZE - 1);
  const gy = clamp((y / viewHeight) * (NOISE_GRID_SIZE - 1), 0, NOISE_GRID_SIZE - 1);
  const x0 = Math.floor(gx);
  const x1 = Math.min(x0 + 1, NOISE_GRID_SIZE - 1);
  const y0 = Math.floor(gy);
  const y1 = Math.min(y0 + 1, NOISE_GRID_SIZE - 1);
  const tx = gx - x0;
  const ty = gy - y0;
  const v00 = noiseGrid[y0 * NOISE_GRID_SIZE + x0];
  const v10 = noiseGrid[y0 * NOISE_GRID_SIZE + x1];
  const v01 = noiseGrid[y1 * NOISE_GRID_SIZE + x0];
  const v11 = noiseGrid[y1 * NOISE_GRID_SIZE + x1];
  return lerp(lerp(v00, v10, tx), lerp(v01, v11, tx), ty);
}

// Sunny: sparse, small, bright motes drifting slowly upward with an
// occasional brightness twinkle - not following the curl field at all.
function updateSunnyParticle(p: Particle, time: number, layer: ParticleLayer) {
  const cfg = LAYER_CONFIG[layer];
  p.x += (Math.sin(time + p.seed * Math.PI * 2) * 0.4 + flowBias.x * 0.5) * cfg.speedMul;
  p.y += (-0.5 - flowSpeed * 0.15) * cfg.speedMul;
}

// Cloudy: large, soft, high-density blobs drifting together slowly with
// the ambient wind.
function updateCloudyParticle(p: Particle, layer: ParticleLayer) {
  const cfg = LAYER_CONFIG[layer];
  const angle = sampleNoiseGrid(p.x, p.y);
  let vx = Math.cos(angle) * 0.5 + flowBias.x;
  let vy = Math.sin(angle) * 0.5 + flowBias.y;

  if (flowTurbulence > 0) {
    vx += (Math.random() - 0.5) * flowTurbulence * 0.5 * cfg.turbulenceMul;
    vy += (Math.random() - 0.5) * flowTurbulence * 0.5 * cfg.turbulenceMul;
  }

  const len = Math.hypot(vx, vy) || 1;
  p.x += (vx / len) * flowSpeed * 0.6 * cfg.speedMul;
  p.y += (vy / len) * flowSpeed * 0.6 * cfg.speedMul;
}

// Rainy: thin, fast-falling streaks slanted by wind, plus a subtle
// vertical noise overlay across the whole screen.
function updateRainParticle(p: Particle, layer: ParticleLayer) {
  const cfg = LAYER_CONFIG[layer];
  p.x += flowBias.x * 1.5 + (Math.random() - 0.5) * flowTurbulence * 2 * cfg.turbulenceMul;
  p.y += (6 + flowSpeed * 1.5) * cfg.speedMul;
}

function drawRainNoiseOverlay() {
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 40; i++) {
    const x = Math.random() * viewWidth;
    const y = Math.random() * viewHeight;
    const streakLength = 10 + Math.random() * 30;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y + streakLength);
    ctx.stroke();
  }
  ctx.restore();
}

// Batching: every particle of a given depth layer is added as a subpath of
// that layer's single Path2D, then filled/stroked exactly once - instead
// of a beginPath/fill (or stroke) per particle, it's one draw call per
// layer (at most 3) no matter how many particles are on screen.
function addCircleToPath(path: Path2D, x: number, y: number, radius: number) {
  path.moveTo(x + radius, y);
  path.arc(x, y, radius, 0, Math.PI * 2);
}

function fillParticlePath(path: Path2D, color: [number, number, number], alpha: number) {
  ctx.fillStyle = rgbString(color);
  ctx.globalAlpha = alpha;
  ctx.fill(path);
  ctx.globalAlpha = 1;
}

function strokeRainPath(path: Path2D, color: [number, number, number], alpha: number, lineWidth: number) {
  ctx.strokeStyle = rgbString(color);
  ctx.globalAlpha = alpha;
  ctx.lineWidth = lineWidth;
  ctx.stroke(path);
  ctx.globalAlpha = 1;
}

function drawFrame(time: number) {
  const [br, bg, bb] = backgroundRGB;
  ctx.fillStyle = `rgba(${br}, ${bg}, ${bb}, ${TRAIL_FADE_ALPHA[currentWeatherMode]})`;
  ctx.fillRect(0, 0, viewWidth, viewHeight);

  if (currentWeatherMode === 'rainy') {
    drawRainNoiseOverlay();
  }
  if (currentWeatherMode === 'cloudy') {
    computeNoiseGrid(time * 0.5);
  }

  const renderColor = resolveParticleColor(currentWeatherMode, particleColorRGB);
  const count = Math.round(MODE_PARTICLE_COUNT[currentWeatherMode] * particleCountRatio);

  const layerPaths: Record<ParticleLayer, Path2D> = {
    back: new Path2D(),
    mid: new Path2D(),
    front: new Path2D(),
  };

  for (let i = 0; i < count; i++) {
    const p = particles[i];
    const layer = layerForIndex(i, count);
    const cfg = LAYER_CONFIG[layer];
    const path = layerPaths[layer];

    if (currentWeatherMode === 'sunny') {
      updateSunnyParticle(p, time, layer);
      applyCursorField(p);
      applyRipple(p);
      wrapParticle(p);
      const twinkle = 0.5 + 0.5 * Math.sin(time * 4 + p.seed * 30);
      addCircleToPath(path, p.x, p.y, (1 + twinkle * 0.8) * cfg.sizeMul);
    } else if (currentWeatherMode === 'cloudy') {
      updateCloudyParticle(p, layer);
      applyCursorField(p);
      applyRipple(p);
      wrapParticle(p);
      const radius = 5 + Math.sin(p.seed * 10 + time) * 1.5 + 3;
      addCircleToPath(path, p.x, p.y, radius * cfg.sizeMul);
    } else {
      updateRainParticle(p, layer);
      applyCursorField(p);
      applyRipple(p);
      wrapParticle(p);
      const length = (8 + Math.abs(flowBias.x) * 4) * cfg.sizeMul;
      const slantX = flowBias.x * 3;
      path.moveTo(p.x, p.y);
      path.lineTo(p.x - slantX, p.y - length);
    }
  }

  for (const layer of PARTICLE_LAYERS) {
    const cfg = LAYER_CONFIG[layer];
    if (currentWeatherMode === 'rainy') {
      strokeRainPath(layerPaths[layer], renderColor, cfg.alpha, cfg.sizeMul);
    } else {
      fillParticlePath(layerPaths[layer], renderColor, cfg.alpha);
    }
  }
}

function step() {
  drawFrame(performance.now() * 0.0005);
  requestAnimationFrame(step);
}

if (prefersReducedMotion) {
  drawFrame(0);
} else {
  requestAnimationFrame(step);
}

function weatherLabelFromCode(code: number): string {
  if (code === 0) return 'Clear';
  if (code === 1 || code === 2) return 'Partly Cloudy';
  if (code === 3) return 'Overcast';
  if (code === 45 || code === 48) return 'Fog';
  if (code >= 51 && code <= 55) return 'Drizzle';
  if (code >= 61 && code <= 65) return 'Rain';
  if (code >= 71 && code <= 75) return 'Snow';
  if (code >= 80 && code <= 82) return 'Rain Showers';
  if (code >= 95) return 'Thunderstorm';
  return 'Unknown';
}

let lastFetchTime: Date | null = null;

function formatRelativeUpdate(date: Date): string {
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return '방금 전';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.round(minutes / 60);
  return `${hours}시간 전`;
}

function renderLastUpdated() {
  if (!lastFetchTime) return;
  lastUpdatedEl.textContent = `마지막 업데이트: ${formatRelativeUpdate(lastFetchTime)}`;
}

setInterval(renderLastUpdated, 30000);

const cityListEl = document.querySelector<HTMLUListElement>('#cityList')!;
const citySearchInput = document.querySelector<HTMLInputElement>('#citySearchInput')!;
const citySearchResults = document.querySelector<HTMLUListElement>('#citySearchResults')!;
const citySearchHint = document.querySelector<HTMLParagraphElement>('#citySearchHint')!;

const MAX_CITIES = 8;

function getCityButtons(): HTMLButtonElement[] {
  return Array.from(cityListEl.querySelectorAll<HTMLButtonElement>('.city-button'));
}

function updateCitySelectionUI() {
  getCityButtons().forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.name === selectedCityName));
  });
}

function selectCity(name: string) {
  selectedCityName = name;
  applyWeatherToFlowField(cityWeatherByName.get(name));
  applyAmbient(Number(slider.value));
  updateCitySelectionUI();
  cityLabel.textContent = `${name} 기준`;

  const weather = cityWeatherByName.get(name);
  console.log(
    `[city] ${name}: mode=${currentWeatherMode}, weathercode=${weather ? weather.weathercode : 'N/A'}`,
  );

  if (prefersReducedMotion) {
    drawFrame(0);
  }
}

function updateSearchAvailability() {
  const count = getCityButtons().length;
  const atMax = count >= MAX_CITIES;
  citySearchInput.disabled = atMax;
  citySearchInput.placeholder = atMax ? '최대 8개까지 추가했어요' : '도시 검색 후 추가';
  citySearchHint.textContent = `${count} / ${MAX_CITIES}개 도시`;
}

function createCityListItem(name: string, lat: number, lon: number, removable: boolean): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'city-item';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'city-button';
  button.dataset.name = name;
  button.dataset.lat = String(lat);
  button.dataset.lon = String(lon);
  button.setAttribute('aria-pressed', 'false');
  button.innerHTML = `
    <span class="weather-icon" aria-hidden="true"></span>
    <span class="city"></span><span class="temp">--</span><span class="weather">Loading…</span>
    <span class="wind">
      <svg class="wind-arrow" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2 L11.5 9 L8 7 L4.5 9 Z" fill="currentColor" /></svg>
      <span class="wind-value"></span>
    </span>
    <span class="precip" hidden>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2C8 2 3.5 8 3.5 11a4.5 4.5 0 0 0 9 0C12.5 8 8 2 8 2Z" fill="currentColor" /></svg>
      <span class="precip-value"></span>
    </span>
  `;
  // Set via textContent, not innerHTML, since `name` comes from the
  // geocoding API and must not be parsed as markup.
  button.querySelector('.city')!.textContent = name;
  li.appendChild(button);

  if (removable) {
    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'city-remove';
    removeButton.dataset.name = name;
    removeButton.setAttribute('aria-label', `${name} 삭제`);
    removeButton.textContent = '×';
    li.appendChild(removeButton);
  }

  return li;
}

function removeCity(name: string, li: HTMLLIElement) {
  li.remove();
  cityWeatherByName.delete(name);
  if (selectedCityName === name) {
    const fallback = getCityButtons()[0]?.dataset.name;
    if (fallback) selectCity(fallback);
  }
  updateSearchAvailability();
}

cityListEl.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;

  const removeButton = target.closest<HTMLButtonElement>('.city-remove');
  if (removeButton) {
    const li = removeButton.closest('li');
    const name = removeButton.dataset.name;
    if (li && name) removeCity(name, li);
    return;
  }

  const cityButton = target.closest<HTMLButtonElement>('.city-button');
  if (cityButton) {
    const name = cityButton.dataset.name;
    if (name && cityWeatherByName.has(name)) {
      selectCity(name);
    }
  }
});

async function fetchAndRenderCityWeather(button: HTMLButtonElement) {
  const iconEl = button.querySelector<HTMLSpanElement>('.weather-icon')!;
  const tempEl = button.querySelector<HTMLSpanElement>('.temp')!;
  const weatherEl = button.querySelector<HTMLSpanElement>('.weather')!;
  const windEl = button.querySelector<HTMLSpanElement>('.wind')!;
  const windArrowEl = button.querySelector<SVGElement>('.wind-arrow')!;
  const windValueEl = button.querySelector<HTMLSpanElement>('.wind-value')!;
  const precipEl = button.querySelector<HTMLSpanElement>('.precip')!;
  const precipValueEl = button.querySelector<HTMLSpanElement>('.precip-value')!;
  const name = button.dataset.name!;
  try {
    const { lat, lon } = button.dataset;
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,windspeed_10m,winddirection_10m,precipitation,cloudcover,weathercode`,
    );
    if (!res.ok) throw new Error('Request failed');
    const data = await res.json();
    const current = data.current;
    cityWeatherByName.set(name, {
      name,
      temperature: current.temperature_2m,
      windspeed: current.windspeed_10m,
      winddirection: current.winddirection_10m,
      precipitation: current.precipitation,
      cloudcover: current.cloudcover,
      weathercode: current.weathercode,
    });
    tempEl.textContent = `${Math.round(current.temperature_2m)}°C`;
    weatherEl.textContent = weatherLabelFromCode(current.weathercode);
    iconEl.innerHTML = weatherModeIcon(weatherModeFromCode(current.weathercode));

    // Point the arrow the same way the wind actually pushes the flow
    // field (see applyWeatherToFlowField's flowBearing), not the raw
    // meteorological "from" direction, so the icon and the hero
    // animation agree with each other.
    const flowBearing = (current.winddirection_10m + 180) % 360;
    windArrowEl.style.transform = `rotate(${flowBearing}deg)`;
    windValueEl.textContent = `${Math.round(current.windspeed_10m)}km/h`;

    if (current.precipitation > 0.05) {
      precipEl.hidden = false;
      const roundedPrecip = Math.round(current.precipitation * 10) / 10;
      precipValueEl.textContent = `${roundedPrecip}mm`;
    } else {
      precipEl.hidden = true;
    }

    console.log(`[weather] ${name}:`, {
      temperature: current.temperature_2m,
      windspeed: current.windspeed_10m,
      weathercode: current.weathercode,
    });

    lastFetchTime = new Date();
    renderLastUpdated();
  } catch {
    tempEl.textContent = '--';
    weatherEl.textContent = 'Unavailable';
    windEl.hidden = true;
    precipEl.hidden = true;
  }
}

async function loadCityWeather() {
  await Promise.all(getCityButtons().map(fetchAndRenderCityWeather));

  const defaultCity = getCityButtons()[0]?.dataset.name;
  const firstAvailable = defaultCity && cityWeatherByName.has(defaultCity) ? defaultCity : [...cityWeatherByName.keys()][0];
  if (firstAvailable) {
    selectCity(firstAvailable);
  }

  updateSearchAvailability();
}

loadCityWeather();

// --- City search (Open-Meteo Geocoding API) ---

interface GeocodingResult {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  admin1?: string;
}

let searchDebounceTimer: number | undefined;
let searchAbortController: AbortController | null = null;

function closeSearchResults() {
  citySearchResults.hidden = true;
  citySearchResults.innerHTML = '';
  citySearchInput.setAttribute('aria-expanded', 'false');
}

function addCity(result: GeocodingResult) {
  citySearchInput.value = '';
  closeSearchResults();

  const existing = getCityButtons().find((button) => button.dataset.name === result.name);
  if (existing) {
    selectCity(result.name);
    return;
  }

  if (getCityButtons().length >= MAX_CITIES) {
    updateSearchAvailability();
    return;
  }

  const li = createCityListItem(result.name, result.latitude, result.longitude, true);
  cityListEl.appendChild(li);
  updateSearchAvailability();

  const button = li.querySelector<HTMLButtonElement>('.city-button')!;
  fetchAndRenderCityWeather(button).then(() => selectCity(result.name));
}

function renderSearchResults(results: GeocodingResult[]) {
  citySearchResults.innerHTML = '';

  if (results.length === 0) {
    closeSearchResults();
    return;
  }

  results.forEach((result) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'city-search-result';
    button.setAttribute('role', 'option');

    const nameEl = document.createElement('span');
    nameEl.className = 'city-search-result-name';
    nameEl.textContent = result.name;
    button.appendChild(nameEl);

    const locationParts = [result.admin1, result.country].filter(Boolean);
    if (locationParts.length > 0) {
      const metaEl = document.createElement('span');
      metaEl.className = 'city-search-result-meta';
      metaEl.textContent = locationParts.join(', ');
      button.appendChild(metaEl);
    }

    button.addEventListener('click', () => addCity(result));
    li.appendChild(button);
    citySearchResults.appendChild(li);
  });

  citySearchResults.hidden = false;
  citySearchInput.setAttribute('aria-expanded', 'true');
}

async function searchCities(query: string) {
  searchAbortController?.abort();
  const controller = new AbortController();
  searchAbortController = controller;
  try {
    const res = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=6&language=ko`,
      { signal: controller.signal },
    );
    if (!res.ok) throw new Error('Search failed');
    const data = await res.json();
    renderSearchResults((data.results ?? []) as GeocodingResult[]);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    closeSearchResults();
  }
}

citySearchInput.addEventListener('input', () => {
  const query = citySearchInput.value.trim();
  window.clearTimeout(searchDebounceTimer);
  if (query.length < 2) {
    closeSearchResults();
    return;
  }
  searchDebounceTimer = window.setTimeout(() => searchCities(query), 300);
});

citySearchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeSearchResults();
  }
});

document.addEventListener('click', (event) => {
  if (!(event.target instanceof Node)) return;
  if (!citySearchInput.closest('.city-search')?.contains(event.target)) {
    closeSearchResults();
  }
});

// --- Custom cursor ---
// A small dot that eases toward the pointer and picks up the current
// weather mode's tint. `updateCursorColor` is called from
// applyWeatherToFlowField above; being a hoisted function declaration,
// it's safe to reference there even though it's defined below - by the
// time weather data actually arrives and calls it, the whole module
// (including this block) has already finished its initial synchronous run.
const cursorDot = document.querySelector<HTMLDivElement>('#cursorDot')!;
const isTouchDevice = window.matchMedia('(pointer: coarse)').matches;

function updateCursorColor() {
  cursorDot.style.backgroundColor = rgbString(MODE_TINT[currentWeatherMode].color);
}

if (!isTouchDevice) {
  cursorDot.hidden = false;
  document.body.classList.add('has-custom-cursor');
  updateCursorColor();

  const CURSOR_EASE = 0.2;
  const CURSOR_HOVER_SCALE = 2;
  let cursorX = window.innerWidth / 2;
  let cursorY = window.innerHeight / 2;
  let targetX = cursorX;
  let targetY = cursorY;
  let cursorScale = 1;
  let targetScale = 1;

  const isInteractiveTarget = (el: Element | null) =>
    !!el?.closest('a, button, input, label, [role="button"], [role="option"]');

  const renderCursor = () => {
    cursorDot.style.transform = `translate3d(${cursorX}px, ${cursorY}px, 0) translate(-50%, -50%) scale(${cursorScale})`;
  };
  renderCursor();

  function stepCursor() {
    cursorX += (targetX - cursorX) * CURSOR_EASE;
    cursorY += (targetY - cursorY) * CURSOR_EASE;
    cursorScale += (targetScale - cursorScale) * CURSOR_EASE;
    renderCursor();
    requestAnimationFrame(stepCursor);
  }

  document.addEventListener('mousemove', (event) => {
    targetX = event.clientX;
    targetY = event.clientY;
    targetScale = isInteractiveTarget(event.target as Element | null) ? CURSOR_HOVER_SCALE : 1;

    if (prefersReducedMotion) {
      cursorX = targetX;
      cursorY = targetY;
      cursorScale = targetScale;
      renderCursor();
    }
  });

  if (!prefersReducedMotion) {
    requestAnimationFrame(stepCursor);
  }
}
