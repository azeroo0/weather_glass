import './style.css';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

const canvas = document.querySelector<HTMLCanvasElement>('#flowCanvas')!;
const slider = document.querySelector<HTMLInputElement>('#timeSlider')!;
const timeDisplay = document.querySelector<HTMLSpanElement>('#currentTime')!;
const weatherLabel = document.querySelector<HTMLSpanElement>('#weatherLabel')!;
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

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
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
  if (hour < 3 || hour >= 21) return 'Night';
  if (hour < 9) return 'Dawn';
  if (hour < 15) return 'Midday';
  return 'Dusk';
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
// speed, direction bias, turbulence - come entirely from each chapter's
// city weather, blended continuously as the user scrolls (see
// WeatherSnapshot below).
interface CityWeather {
  name: string;
  temperature: number;
  windspeed: number; // km/h
  winddirection: number; // degrees, direction the wind is blowing FROM
  precipitation: number; // mm, last hour
  cloudcover: number; // %
  weathercode: number;
}

// WMO weathercode -> which "shape language" the flow field blends toward.
// Each mode has a genuinely different physical character (background
// gradient, particle shape, direction of travel, speed) rather than just a
// different tint - see MODE_LOOK below. Thunderstorm reuses rain's motion
// entirely and adds flash/shake on top (see maybeTriggerThunderFlash).
// Rendering never snaps discretely between modes - see WeatherSnapshot's
// modeWeights, which interpolate continuously between two cities' one-hot
// vectors as the user scrubs through a chapter.
type WeatherMode = 'sunny' | 'cloudy' | 'rainy' | 'thunderstorm' | 'snowy';
type ModeWeights = [number, number, number, number, number];

const MODE_INDEX: Record<WeatherMode, 0 | 1 | 2 | 3 | 4> = {
  sunny: 0,
  cloudy: 1,
  rainy: 2,
  thunderstorm: 3,
  snowy: 4,
};

function weatherModeFromCode(code: number): WeatherMode {
  if (code <= 1) return 'sunny';
  if (code === 2 || code === 3 || code === 45 || code === 48) return 'cloudy';
  if (code >= 71 && code <= 77) return 'snowy';
  if (code >= 95 && code <= 99) return 'thunderstorm';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 86)) return 'rainy';
  return 'cloudy';
}

// Each mode's full physical character in one place: a top-to-bottom
// background gradient, an edge vignette strength, particle color/opacity/
// count, and how quickly the trail-fade wipe erases the previous frame
// (long persistence for rain's streaks, short for everything else). These
// are "base" colors - dayBrightnessFactor scales them for time-of-day
// without diluting the mode's own hue.
interface ModeLook {
  topColor: [number, number, number];
  bottomColor: [number, number, number];
  vignette: number;
  particleColor: [number, number, number];
  particleAlpha: number;
  particleCount: number;
  trailFadeAlpha: number;
}

const MODE_LOOK: Record<WeatherMode, ModeLook> = {
  sunny: {
    topColor: [255, 225, 158],
    bottomColor: [173, 213, 236],
    vignette: 0,
    particleColor: [255, 250, 224],
    particleAlpha: 0.9,
    particleCount: 55,
    trailFadeAlpha: 0.4,
  },
  cloudy: {
    topColor: [122, 133, 145],
    bottomColor: [98, 108, 120],
    vignette: 0.12,
    particleColor: [156, 163, 172],
    particleAlpha: 0.38,
    particleCount: 55,
    trailFadeAlpha: 0.16,
  },
  rainy: {
    topColor: [23, 28, 46],
    bottomColor: [10, 12, 20],
    vignette: 0.6,
    particleColor: [196, 210, 224],
    particleAlpha: 0.85,
    particleCount: 260,
    trailFadeAlpha: 0.08,
  },
  thunderstorm: {
    topColor: [16, 18, 30],
    bottomColor: [6, 7, 13],
    vignette: 0.72,
    particleColor: [205, 214, 228],
    particleAlpha: 0.9,
    particleCount: 260,
    trailFadeAlpha: 0.08,
  },
  snowy: {
    topColor: [236, 237, 241],
    bottomColor: [213, 216, 223],
    vignette: 0,
    particleColor: [255, 255, 255],
    particleAlpha: 0.95,
    particleCount: 130,
    trailFadeAlpha: 0.5,
  },
};

// A fully-resolved "what the flow field should look like" for one city.
// Every field here is a plain number/vector so two snapshots can be
// linearly interpolated (see blendSnapshots) - that continuous blend, not
// a fade between two rendered frames, is what makes a chapter transition
// actually change the particles' color/shape/speed/density as you scroll.
interface WeatherSnapshot {
  modeWeights: ModeWeights;
  flowSpeed: number;
  flowBias: { x: number; y: number };
  flowTurbulence: number;
  topColor: [number, number, number];
  bottomColor: [number, number, number];
  vignette: number;
  particleColor: [number, number, number];
  particleAlpha: number;
  particleCount: number;
  trailFadeAlpha: number;
}

function snapshotFromLook(mode: WeatherMode, look: ModeLook, weather: CityWeather | undefined): WeatherSnapshot {
  const modeWeights: ModeWeights = [0, 0, 0, 0, 0];
  modeWeights[MODE_INDEX[mode]] = 1;

  const windspeed = weather?.windspeed ?? 8;
  const winddirection = weather?.winddirection ?? 0;
  const precipitation = weather?.precipitation ?? 0;

  const flowSpeed = clamp(0.4 + windspeed * 0.05, 0.4, 3.2);
  const biasStrength = clamp(windspeed / 20, 0.15, 1.5);
  const flowBearing = (winddirection + 180) % 360; // wind blows TOWARD this bearing
  const biasAngle = ((flowBearing - 90) * Math.PI) / 180; // meteorological bearing -> canvas angle
  const flowBias = { x: Math.cos(biasAngle) * biasStrength, y: Math.sin(biasAngle) * biasStrength };
  const flowTurbulence = clamp(precipitation * 0.15, 0, 1.2);

  return {
    modeWeights,
    flowSpeed,
    flowBias,
    flowTurbulence,
    topColor: look.topColor,
    bottomColor: look.bottomColor,
    vignette: look.vignette,
    particleColor: look.particleColor,
    particleAlpha: look.particleAlpha,
    particleCount: look.particleCount,
    trailFadeAlpha: look.trailFadeAlpha,
  };
}

const DEFAULT_SNAPSHOT: WeatherSnapshot = snapshotFromLook('cloudy', MODE_LOOK.cloudy, undefined);

function computeSnapshot(weather: CityWeather | undefined): WeatherSnapshot {
  if (!weather) return DEFAULT_SNAPSHOT;
  const mode = weatherModeFromCode(weather.weathercode);
  return snapshotFromLook(mode, MODE_LOOK[mode], weather);
}

function blendSnapshots(a: WeatherSnapshot, b: WeatherSnapshot, t: number): WeatherSnapshot {
  return {
    modeWeights: [
      lerp(a.modeWeights[0], b.modeWeights[0], t),
      lerp(a.modeWeights[1], b.modeWeights[1], t),
      lerp(a.modeWeights[2], b.modeWeights[2], t),
      lerp(a.modeWeights[3], b.modeWeights[3], t),
      lerp(a.modeWeights[4], b.modeWeights[4], t),
    ],
    flowSpeed: lerp(a.flowSpeed, b.flowSpeed, t),
    flowBias: { x: lerp(a.flowBias.x, b.flowBias.x, t), y: lerp(a.flowBias.y, b.flowBias.y, t) },
    flowTurbulence: lerp(a.flowTurbulence, b.flowTurbulence, t),
    topColor: mixColor(a.topColor, b.topColor, t),
    bottomColor: mixColor(a.bottomColor, b.bottomColor, t),
    vignette: lerp(a.vignette, b.vignette, t),
    particleColor: mixColor(a.particleColor, b.particleColor, t),
    particleAlpha: lerp(a.particleAlpha, b.particleAlpha, t),
    particleCount: lerp(a.particleCount, b.particleCount, t),
    trailFadeAlpha: lerp(a.trailFadeAlpha, b.trailFadeAlpha, t),
  };
}

// Effective values for *this* frame, recomputed at the top of drawFrame()
// from the active chapter's blend. Kept as module state (rather than
// threaded through every function) since the cursor dot also reads them
// outside the main particle loop.
let flowSpeed = DEFAULT_SNAPSHOT.flowSpeed;
let flowBias = DEFAULT_SNAPSHOT.flowBias;
let flowTurbulence = DEFAULT_SNAPSHOT.flowTurbulence;

function scaleColor(color: [number, number, number], factor: number): [number, number, number] {
  return [color[0] * factor, color[1] * factor, color[2] * factor];
}

// The time slider no longer blends its own hue into the weather colors -
// doing that was exactly what made every mode look like the same gray with
// a slightly different tint. It now only scales brightness, so noon reads
// brighter and midnight darker *within* whatever mode is showing, without
// diluting that mode's own characteristic color.
function dayBrightnessFactor(hour: number): number {
  const cycle = Math.cos((2 * Math.PI * (hour - 12)) / 24); // 1 at noon, -1 at midnight
  return lerp(0.55, 1.05, (cycle + 1) / 2);
}

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

function setBodyAmbient(color: [number, number, number]) {
  const rgb: [number, number, number] = [Math.round(color[0]), Math.round(color[1]), Math.round(color[2])];
  document.body.style.backgroundColor = rgbString(rgb);
  document.body.classList.toggle('is-light', relativeLuminance(rgb) > CONTRAST_CROSSOVER_LUMINANCE);
}

function updateFromSlider() {
  const hour = Number(slider.value);
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
  playButton.textContent = '▶ Play the day';
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
  playButton.textContent = '■ Stop';
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
// Not called here yet: under prefers-reduced-motion, updateFromSlider()
// synchronously calls drawFrame(), which reads `chapters` - declared much
// later in this file. Deferred to the bottom, after chapters/weather
// setup has run, alongside the other post-setup kickoff calls.

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

// Hero title reveal: split into words, each masked by its own clip-path
// (see .intro-title .word in style.css) that starts fully hidden from the
// bottom and sweeps upward to fully visible - a wipe, not a fade. Runs
// once immediately on load, staggered per word.
function wrapWordsForReveal(el: HTMLElement): HTMLElement[] {
  const words = (el.textContent ?? '').split(' ').filter(Boolean);
  el.textContent = '';
  const wordEls = words.map((word, i) => {
    const span = document.createElement('span');
    span.className = 'word';
    span.textContent = word;
    el.appendChild(span);
    if (i < words.length - 1) el.appendChild(document.createTextNode(' '));
    return span;
  });
  return wordEls;
}

const introTitleEl = document.querySelector<HTMLElement>('.intro-title')!;
const introTitleWords = wrapWordsForReveal(introTitleEl);

if (prefersReducedMotion) {
  gsap.set(introTitleWords, { clipPath: 'inset(0% 0 0 0)' });
} else {
  gsap.to(introTitleWords, {
    clipPath: 'inset(0% 0 0 0)',
    duration: 0.9,
    stagger: 0.08,
    ease: 'power3.out',
  });
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

// Weak, ambient pull toward the hero title so particles read as gathering
// around it instead of drifting past uniformly. Scoped to the hero: it
// fades out with window.scrollY (gone by the time the intro section's own
// height has been scrolled past) so it never fights the chapters' weather
// blend further down the page.
const introEl = document.querySelector<HTMLElement>('.intro')!;
const HERO_ATTRACTION_STRENGTH = 0.5;
const HERO_ATTRACTION_RADIUS_RATIO = 0.6;

function applyHeroTitleAttraction(p: Particle) {
  const introHeight = introEl.offsetHeight || viewHeight;
  const strength = clamp(1 - window.scrollY / introHeight, 0, 1) * HERO_ATTRACTION_STRENGTH;
  if (strength <= 0.001) return;

  const rect = introTitleEl.getBoundingClientRect();
  const anchorX = rect.left + rect.width / 2;
  const anchorY = rect.top + rect.height / 2;
  const radius = Math.min(viewWidth, viewHeight) * HERO_ATTRACTION_RADIUS_RATIO;

  const dx = anchorX - p.x;
  const dy = anchorY - p.y;
  const dist = Math.hypot(dx, dy);
  if (dist >= radius || dist < 0.0001) return;
  const falloff = 1 - dist / radius;
  p.x += (dx / dist) * falloff * strength;
  p.y += (dy / dist) * falloff * strength;
}

// Depth layers: each frame's particle budget is split across back/mid/front
// so the flow field reads as layers of depth rather than one flat plane -
// back is smaller/slower/faintest, front is bigger/faster/most opaque.
type ParticleLayer = 'back' | 'mid' | 'front';
const PARTICLE_LAYERS: ParticleLayer[] = ['back', 'mid', 'front'];

interface LayerConfig {
  countRatio: number;
  speedMul: number;
  turbulenceMul: number;
  sizeMul: number;
  alpha: number;
}

const LAYER_CONFIG: Record<ParticleLayer, LayerConfig> = {
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

// A particle's velocity is a weighted blend of all modes' motion formulas
// (weights sum to ~1) rather than picking one - this is what makes a
// chapter transition actually morph the flow field's behavior frame by
// frame, instead of cross-fading between two finished looks. Thunderstorm
// shares rain's velocity entirely (it only adds flash/shake on top), so
// the two weights are combined into one "rainWeight" wherever motion or
// shape is concerned.
function computeBlendedVelocity(
  p: Particle,
  time: number,
  weights: ModeWeights,
  cfg: LayerConfig,
): { vx: number; vy: number } {
  let vx = 0;
  let vy = 0;
  const rainWeight = weights[2] + weights[3];

  if (weights[0] > 0.001) {
    // Sunny: barely-there upward drift with a gentle sway - "중력을 거스르듯
    // 아주 천천히 위로 부유".
    const sway = Math.sin(time * 0.3 + p.seed * Math.PI * 2) * 0.15;
    vx += weights[0] * sway * cfg.speedMul;
    vy += weights[0] * (-0.1 - flowSpeed * 0.03) * cfg.speedMul;
  }

  if (weights[1] > 0.001) {
    // Cloudy: purely horizontal, no vertical motion at all - layered fog
    // banks sliding sideways, each depth layer at its own speed.
    const direction = flowBias.x >= 0 ? 1 : -1;
    const drift = (0.5 + Math.abs(flowBias.x) * 0.7) * direction;
    vx += weights[1] * drift * cfg.speedMul;
  }

  if (rainWeight > 0.001) {
    // Rain (and thunderstorm): fast, near-vertical fall with a
    // wind-driven horizontal kick - "빠르게 아래로 떨어짐".
    vx += rainWeight * (flowBias.x * 2 + (Math.random() - 0.5) * flowTurbulence * cfg.turbulenceMul);
    vy += rainWeight * (13 + flowSpeed * 3) * cfg.speedMul;
  }

  if (weights[4] > 0.001) {
    // Snow: slow fall with a wide, slow side-to-side sway - "크고 부드럽게
    // 좌우로 살랑이며".
    const sway = Math.sin(time * 0.6 + p.seed * Math.PI * 2) * 1.1;
    vx += weights[4] * sway * cfg.speedMul;
    vy += weights[4] * (1.1 + flowSpeed * 0.25) * cfg.speedMul;
  }

  return { vx, vy };
}

// Batching: every particle of a given depth layer is added as a subpath of
// that layer's single Path2D, then filled/stroked exactly once - instead
// of a beginPath/fill (or stroke) per particle, it's at most a couple of
// draw calls per layer no matter how many particles are on screen.
function addCircleToPath(path: Path2D, x: number, y: number, radius: number) {
  path.moveTo(x + radius, y);
  path.arc(x, y, radius, 0, Math.PI * 2);
}

function fillParticlePath(path: Path2D, color: [number, number, number], alpha: number, blurPx: number) {
  ctx.save();
  if (blurPx > 0.5) ctx.filter = `blur(${blurPx}px)`;
  ctx.fillStyle = rgbString(color);
  ctx.globalAlpha = alpha;
  ctx.fill(path);
  ctx.restore();
}

function strokeStreakPath(path: Path2D, color: [number, number, number], alpha: number, lineWidth: number) {
  ctx.strokeStyle = rgbString(color);
  ctx.globalAlpha = alpha;
  ctx.lineWidth = lineWidth;
  ctx.stroke(path);
  ctx.globalAlpha = 1;
}

// Top-to-bottom gradient wash, painted at trailFadeAlpha (not full opacity)
// so the previous frame's particles persist and fade rather than being
// wiped clean every frame - this is what gives rain's streaks their trail
// and sunny's motes their soft afterglow.
function drawModeBackground(
  topColor: [number, number, number],
  bottomColor: [number, number, number],
  alpha: number,
) {
  const gradient = ctx.createLinearGradient(0, 0, 0, viewHeight);
  gradient.addColorStop(0, rgbString(topColor));
  gradient.addColorStop(1, rgbString(bottomColor));
  ctx.fillStyle = gradient;
  ctx.globalAlpha = alpha;
  ctx.fillRect(0, 0, viewWidth, viewHeight);
  ctx.globalAlpha = 1;
}

// A dark radial overlay drawn fresh every frame (not trailed) so it always
// reads as a crisp, stable vignette rather than smearing with the trail
// wash above.
function drawVignette(strength: number) {
  if (strength <= 0.01) return;
  const cx = viewWidth / 2;
  const cy = viewHeight / 2;
  const outerRadius = Math.max(viewWidth, viewHeight) * 0.75;
  const gradient = ctx.createRadialGradient(cx, cy, outerRadius * 0.35, cx, cy, outerRadius);
  gradient.addColorStop(0, 'rgba(0, 0, 0, 0)');
  gradient.addColorStop(1, `rgba(0, 0, 0, ${strength * 0.8})`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, viewWidth, viewHeight);
}

// Rain splashes: a short-lived mark spawned wherever a rain-weighted
// particle actually reaches the bottom edge (see drawFrame), rendered as
// two small ticks flaring outward and fading over SPLASH_LIFETIME_MS. Kept
// as its own tiny system rather than folded into the particle pool because
// splashes are momentary events, not part of the continuous flow.
interface Splash {
  x: number;
  startedAt: number;
}

const splashes: Splash[] = [];
const SPLASH_LIFETIME_MS = 260;

function drawSplashes(now: number, color: [number, number, number], rainWeight: number) {
  if (splashes.length === 0) return;
  const path = new Path2D();
  let alphaSum = 0;
  let kept = 0;

  for (let i = splashes.length - 1; i >= 0; i--) {
    const age = now - splashes[i].startedAt;
    if (age >= SPLASH_LIFETIME_MS) {
      splashes.splice(i, 1);
      continue;
    }
    const t = age / SPLASH_LIFETIME_MS;
    const spread = 3 + t * 7;
    const y = viewHeight - t * 3;
    path.moveTo(splashes[i].x - spread, y + spread * 0.6);
    path.lineTo(splashes[i].x, y - spread * 0.5);
    path.lineTo(splashes[i].x + spread, y + spread * 0.6);
    alphaSum += (1 - t) * rainWeight;
    kept++;
  }

  if (kept === 0) return;
  ctx.strokeStyle = rgbString(color);
  ctx.lineWidth = 1.2;
  ctx.globalAlpha = clamp(alphaSum / kept, 0, 1);
  ctx.stroke(path);
  ctx.globalAlpha = 1;
}

// Thunderstorm flash + shake: a random gap of 5-12s, then a sub-100ms
// white flash immediately followed by a brief 2-3px shake of the canvas
// element itself (the flow field keeps flowing normally underneath - only
// the visual layer jitters). Entirely disabled under prefers-reduced-motion,
// since a flashing screen is a textbook seizure trigger.
let nextThunderFlashAt = prefersReducedMotion ? Infinity : performance.now() + 5000 + Math.random() * 7000;
let thunderFlashEndAt = 0;
let thunderShakeEndAt = 0;

function maybeTriggerThunderFlash(now: number, thunderWeight: number) {
  if (prefersReducedMotion || thunderWeight < 0.5) return;
  if (now < nextThunderFlashAt) return;
  thunderFlashEndAt = now + 60 + Math.random() * 40;
  thunderShakeEndAt = thunderFlashEndAt + 220;
  nextThunderFlashAt = now + 5000 + Math.random() * 7000;
}

function drawThunderFlash(now: number) {
  if (now >= thunderFlashEndAt) return;
  const remaining = clamp((thunderFlashEndAt - now) / 90, 0, 1);
  ctx.fillStyle = '#fff';
  ctx.globalAlpha = remaining * 0.85;
  ctx.fillRect(0, 0, viewWidth, viewHeight);
  ctx.globalAlpha = 1;
}

function applyScreenShake(now: number) {
  if (now >= thunderFlashEndAt && now < thunderShakeEndAt) {
    const dx = (Math.random() - 0.5) * 5;
    const dy = (Math.random() - 0.5) * 5;
    canvas.style.transform = `translate(${dx}px, ${dy}px)`;
  } else {
    canvas.style.transform = 'none';
  }
}

function drawFrame(time: number) {
  const now = performance.now();
  const prevChapter = chapters[Math.max(activeChapterIndex - 1, 0)];
  const currentChapter = chapters[activeChapterIndex];
  const prevSnapshot = prevChapter?.snapshot ?? DEFAULT_SNAPSHOT;
  const currentSnapshot = currentChapter?.snapshot ?? DEFAULT_SNAPSHOT;
  const blend = blendSnapshots(prevSnapshot, currentSnapshot, chapterProgress);
  const weights = blend.modeWeights;
  const rainWeight = weights[2] + weights[3];
  const thunderWeight = weights[3];

  flowSpeed = blend.flowSpeed;
  flowBias = blend.flowBias;
  flowTurbulence = blend.flowTurbulence;

  const brightness = dayBrightnessFactor(Number(slider.value));
  const topColor = scaleColor(blend.topColor, brightness);
  const bottomColor = scaleColor(blend.bottomColor, brightness);
  setBodyAmbient(bottomColor);

  const renderColor = scaleColor(blend.particleColor, Math.min(1.15, brightness));
  updateCursorColor(renderColor);

  drawModeBackground(topColor, bottomColor, blend.trailFadeAlpha);

  const count = Math.round(blend.particleCount * particleCountRatio);

  const dotPaths: Record<ParticleLayer, Path2D> = { back: new Path2D(), mid: new Path2D(), front: new Path2D() };
  const streakPaths: Record<ParticleLayer, Path2D> = { back: new Path2D(), mid: new Path2D(), front: new Path2D() };
  const hasStreaks: Record<ParticleLayer, boolean> = { back: false, mid: false, front: false };

  for (let i = 0; i < count; i++) {
    const p = particles[i];
    const layer = layerForIndex(i, count);
    const cfg = LAYER_CONFIG[layer];

    const { vx, vy } = computeBlendedVelocity(p, time, weights, cfg);
    p.x += vx;
    p.y += vy;
    applyHeroTitleAttraction(p);
    applyCursorField(p);
    applyRipple(p);

    if (rainWeight > 0.3 && p.y > viewHeight && splashes.length < 80) {
      splashes.push({ x: p.x, startedAt: now });
    }
    wrapParticle(p);

    // Occasional per-particle "flare" - a sharp, rare spike (near 0 most
    // of the time, briefly near 1) rather than a smooth twinkle, so it
    // reads as a lens-flare-like flash-and-fade instead of continuous
    // sparkle.
    const flare = Math.pow(Math.max(0, Math.sin(time * 0.15 + p.seed * 41)), 30);
    const sunnyRadius = (1 + flare * 4) * cfg.sizeMul;
    const cloudyRadius = (48 + Math.sin(p.seed * 3 + time * 0.15) * 12) * cfg.sizeMul;
    const rainHeadRadius = 0.8 * cfg.sizeMul;
    const snowRadius = (5 + Math.sin(p.seed * 7 + time * 0.5) * 1.6) * cfg.sizeMul;
    const radius =
      weights[0] * sunnyRadius + weights[1] * cloudyRadius + rainWeight * rainHeadRadius + weights[4] * snowRadius;
    addCircleToPath(dotPaths[layer], p.x, p.y, radius);

    if (rainWeight > 0.02) {
      const length = 24 * cfg.sizeMul * rainWeight;
      const slantX = flowBias.x * 4 * rainWeight;
      streakPaths[layer].moveTo(p.x, p.y);
      streakPaths[layer].lineTo(p.x - slantX, p.y - length);
      hasStreaks[layer] = true;
    }
  }

  const cloudyBlurPx = weights[1] * 16;
  for (const layer of PARTICLE_LAYERS) {
    const cfg = LAYER_CONFIG[layer];
    fillParticlePath(dotPaths[layer], renderColor, blend.particleAlpha * cfg.alpha, cloudyBlurPx);
    if (hasStreaks[layer]) {
      strokeStreakPath(streakPaths[layer], renderColor, blend.particleAlpha * cfg.alpha * rainWeight, cfg.sizeMul);
    }
  }

  drawSplashes(now, renderColor, rainWeight);
  drawVignette(blend.vignette);

  maybeTriggerThunderFlash(now, thunderWeight);
  drawThunderFlash(now);
  applyScreenShake(now);
}

function step() {
  drawFrame(performance.now() * 0.0005);
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
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hr ago`;
}

function renderLastUpdated() {
  if (!lastFetchTime) return;
  lastUpdatedEl.textContent = `Last updated ${formatRelativeUpdate(lastFetchTime)}`;
}

setInterval(renderLastUpdated, 30000);

// --- Chapters: one full-screen, pinned+scrubbed section per city ---

interface ChapterCity {
  name: string;
  lat: number;
  lon: number;
  weather?: CityWeather;
  snapshot: WeatherSnapshot;
  sectionEl: HTMLElement;
  navButtonEl: HTMLButtonElement;
  conditionEl: HTMLElement;
  tempValueEl: HTMLElement;
  scrollTrigger?: ScrollTrigger;
  // Only the very first onEnter should count up from 0 - every later
  // entry (onEnter again after leaving, or onEnterBack) just shows the
  // resolved value immediately.
  hasPlayedTempCountUp?: boolean;
}

// Scrolling to a chapter by its section's DOM position is unreliable once
// ScrollTrigger has pinned things (spacers get inserted, elements go
// position:fixed) - jumping to the trigger's own computed `start` plus a
// pixel is the position ScrollTrigger itself considers "just inside this
// chapter", so onEnter/onUpdate reliably fire instead of landing exactly
// on a boundary neither chapter reports as active.
function scrollToChapter(chapter: ChapterCity) {
  const top = (chapter.scrollTrigger?.start ?? 0) + 1;
  window.scrollTo({ top, behavior: prefersReducedMotion ? 'auto' : 'smooth' });
}

const chaptersContainer = document.querySelector<HTMLElement>('#chapters')!;
const chapterNavList = document.querySelector<HTMLUListElement>('#chapterNavList')!;

const MAX_CHAPTERS = 8;
const chapters: ChapterCity[] = [];

// Chapter 0 has no "previous" city to blend from, so drawFrame's
// prevChapter/currentChapter both resolve to it - it renders fully
// settled from the very first frame, matching the old page's behavior of
// defaulting to the first city immediately on load.
let activeChapterIndex = 0;
let chapterProgress = 1;

function updateChapterNavActive() {
  chapters.forEach((chapter, idx) => {
    chapter.navButtonEl.classList.toggle('is-active', idx === activeChapterIndex);
  });
}

// Drives only the background blend (see drawFrame's use of
// activeChapterIndex/chapterProgress) - this runs continuously from
// ScrollTrigger's scrub onUpdate, so it must stay free of anything that
// should settle once and stop reacting to scroll (like the temp readout).
function updateChapterVisuals(index: number, progress: number) {
  activeChapterIndex = index;
  chapterProgress = progress;
  updateChapterNavActive();

  // The ambient rAF loop is disabled under reduced motion (see the bottom
  // of this file), so nothing would otherwise repaint the canvas as the
  // chapter's blend state changes - redraw once per scroll update instead.
  if (prefersReducedMotion) {
    drawFrame(0);
  }
}

function showChapterTemp(chapter: ChapterCity) {
  const targetTemp = chapter.weather?.temperature ?? 0;
  chapter.tempValueEl.textContent = String(Math.round(targetTemp));
}

// A plain (non-scrub) tween: runs once on the first real onEnter and is
// then done, independent of however much the user scrubs back and forth
// afterward. Every later entry - onEnter again after leaving, or
// onEnterBack - skips straight to showChapterTemp() instead.
function playChapterTempCountUp(chapter: ChapterCity) {
  if (chapter.hasPlayedTempCountUp) {
    showChapterTemp(chapter);
    return;
  }
  chapter.hasPlayedTempCountUp = true;

  const targetTemp = chapter.weather?.temperature ?? 0;
  if (prefersReducedMotion) {
    showChapterTemp(chapter);
    return;
  }

  const counter = { value: 0 };
  gsap.to(counter, {
    value: targetTemp,
    duration: 1.2,
    ease: 'power1.out',
    onUpdate: () => {
      chapter.tempValueEl.textContent = String(Math.round(counter.value));
    },
  });
}

const TRANSITION_MARQUEE_REPEATS = 16;
const TRANSITION_MARQUEE_MAX_SHIFT = 30; // percent of the track's own width

// A short pinned+scrubbed "beat" inserted right before the given city's
// chapter (never before the very first one). The scrim's opacity and the
// marquee track's x-position are both read straight from the
// ScrollTrigger's own progress, so scrolling faster visibly moves the
// marquee faster - there's no independent CSS animation running underneath.
//
// Appends bandEl to chaptersContainer itself (rather than letting the
// caller do it) because ScrollTrigger's pin:true needs the element
// already attached to the DOM when it's created - it inserts a spacer as
// a sibling, which fails on a still-detached node.
function createTransitionBand(nextCityName: string): HTMLElement {
  const bandEl = document.createElement('section');
  bandEl.className = 'chapter-transition';

  const scrimEl = document.createElement('div');
  scrimEl.className = 'chapter-transition-scrim';

  const marqueeEl = document.createElement('div');
  marqueeEl.className = 'chapter-transition-marquee';
  const trackEl = document.createElement('div');
  trackEl.className = 'chapter-transition-track';
  for (let i = 0; i < TRANSITION_MARQUEE_REPEATS; i++) {
    const wordEl = document.createElement('span');
    wordEl.className = 'chapter-transition-word';
    wordEl.textContent = nextCityName.toUpperCase();
    trackEl.appendChild(wordEl);
  }
  marqueeEl.appendChild(trackEl);
  bandEl.append(scrimEl, marqueeEl);
  chaptersContainer.appendChild(bandEl);

  if (!prefersReducedMotion) {
    gsap.timeline({
      scrollTrigger: {
        trigger: bandEl,
        start: 'top top',
        end: '+=60%',
        pin: true,
        scrub: true,
        onUpdate: (self) => {
          if (!self.isActive) return;
          gsap.set(trackEl, { xPercent: -TRANSITION_MARQUEE_MAX_SHIFT * self.progress });
          // Peaks mid-band and eases back out at both ends, so the
          // darkening reads as one breath in and out rather than a hard cut.
          scrimEl.style.opacity = String(Math.sin(self.progress * Math.PI) * 0.35);
        },
        // onUpdate stops firing once isActive goes false, which can leave
        // the scrim at whatever value the last *sampled* progress was
        // rather than a clean 0 - force it back to fully transparent on
        // the way out in either scroll direction so no darkness lingers
        // into the chapter on either side of the band.
        onLeave: () => {
          scrimEl.style.opacity = '0';
        },
        onLeaveBack: () => {
          scrimEl.style.opacity = '0';
        },
      },
    });
  }

  return bandEl;
}

function createChapter(name: string, lat: number, lon: number): ChapterCity {
  const index = chapters.length;

  if (index > 0) {
    createTransitionBand(name);
  }

  const sectionEl = document.createElement('section');
  sectionEl.className = 'chapter';

  const inner = document.createElement('div');
  inner.className = 'chapter-inner';

  const conditionEl = document.createElement('p');
  conditionEl.className = 'chapter-condition';
  conditionEl.textContent = 'Loading…';

  const cityNameEl = document.createElement('h2');
  cityNameEl.className = 'chapter-city';
  cityNameEl.textContent = name;

  const tempEl = document.createElement('p');
  tempEl.className = 'chapter-temp';
  const tempValueEl = document.createElement('span');
  tempValueEl.className = 'chapter-temp-value';
  tempValueEl.textContent = '0';
  tempEl.append(tempValueEl, document.createTextNode('°'));

  inner.append(conditionEl, cityNameEl, tempEl);
  sectionEl.appendChild(inner);
  chaptersContainer.appendChild(sectionEl);

  const navButtonEl = document.createElement('button');
  navButtonEl.type = 'button';
  navButtonEl.className = 'chapter-nav-button';
  navButtonEl.textContent = name;
  const navItem = document.createElement('li');
  navItem.appendChild(navButtonEl);
  chapterNavList.appendChild(navItem);

  const chapter: ChapterCity = {
    name,
    lat,
    lon,
    snapshot: DEFAULT_SNAPSHOT,
    sectionEl,
    navButtonEl,
    conditionEl,
    tempValueEl,
  };
  chapters.push(chapter);
  updateChapterNavActive();

  navButtonEl.addEventListener('click', () => scrollToChapter(chapter));

  const timeline = gsap.timeline({
    scrollTrigger: {
      trigger: sectionEl,
      start: 'top top',
      end: '+=100%',
      pin: true,
      scrub: true,
      onEnter: () => {
        updateChapterVisuals(index, 0);
        playChapterTempCountUp(chapter);
      },
      onEnterBack: () => {
        updateChapterVisuals(index, 1);
        showChapterTemp(chapter);
      },
      onUpdate: (self) => {
        if (!self.isActive) return;
        updateChapterVisuals(index, self.progress);
      },
    },
  });
  chapter.scrollTrigger = timeline.scrollTrigger ?? undefined;

  return chapter;
}

async function updateCityWeatherFor(chapter: ChapterCity) {
  try {
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${chapter.lat}&longitude=${chapter.lon}&current=temperature_2m,windspeed_10m,winddirection_10m,precipitation,cloudcover,weathercode`,
    );
    if (!res.ok) throw new Error('Request failed');
    const data = await res.json();
    const current = data.current;
    const weather: CityWeather = {
      name: chapter.name,
      temperature: current.temperature_2m,
      windspeed: current.windspeed_10m,
      winddirection: current.winddirection_10m,
      precipitation: current.precipitation,
      cloudcover: current.cloudcover,
      weathercode: current.weathercode,
    };
    chapter.weather = weather;
    chapter.snapshot = computeSnapshot(weather);
    chapter.conditionEl.textContent = weatherLabelFromCode(current.weathercode);

    lastFetchTime = new Date();
    renderLastUpdated();
  } catch {
    chapter.conditionEl.textContent = 'Unavailable';
  }
}

// --- Intro loader ---
// Blocks the page (see body.is-loading) until the initial batch of
// chapter weather fetches actually resolves. The percent shown is driven
// by how many of those requests have genuinely settled - never a fake
// timer - so slow network keeps the loader up exactly as long as the real
// wait, and a fast one dismisses it just as quickly.
const introLoaderEl = document.querySelector<HTMLElement>('#introLoader')!;
const introLoaderPercentEl = document.querySelector<HTMLElement>('#introLoaderPercent')!;
const introLoaderPanels = document.querySelectorAll<HTMLElement>('.intro-loader-panel');
introLoaderPanels.forEach((panel) => {
  panel.style.backgroundColor = document.body.style.backgroundColor;
});

const introLoaderCounter = { value: 0 };

function setIntroLoaderPercent(percent: number) {
  const target = Math.round(clamp(percent, 0, 100));
  if (prefersReducedMotion) {
    introLoaderCounter.value = target;
    introLoaderPercentEl.textContent = `${target}%`;
    return;
  }
  // Smooths the *display* between real progress steps (e.g. 0 -> 25 -> 50
  // as each fetch settles) - the target itself is always the real ratio,
  // this just avoids the number visibly snapping between jumps.
  gsap.to(introLoaderCounter, {
    value: target,
    duration: 0.4,
    ease: 'power1.out',
    onUpdate: () => {
      introLoaderPercentEl.textContent = `${Math.round(introLoaderCounter.value)}%`;
    },
  });
}

function hideIntroLoader() {
  document.body.classList.remove('is-loading');

  if (prefersReducedMotion) {
    introLoaderEl.style.display = 'none';
    return;
  }

  gsap.to('.intro-loader-panel--top', { yPercent: -100, duration: 0.8, ease: 'power3.inOut' });
  gsap.to('.intro-loader-panel--bottom', { yPercent: 100, duration: 0.8, ease: 'power3.inOut' });
  gsap.to('.intro-loader-content', { opacity: 0, duration: 0.4, ease: 'power1.out' });
  gsap.delayedCall(0.85, () => {
    introLoaderEl.style.display = 'none';
  });
}

async function loadAllChapterWeather() {
  const total = chapters.length;
  let completed = 0;
  setIntroLoaderPercent(0);

  await Promise.all(
    chapters.map(async (chapter) => {
      await updateCityWeatherFor(chapter);
      completed += 1;
      setIntroLoaderPercent((completed / total) * 100);
    }),
  );

  updateSearchAvailability();
  hideIntroLoader();
}

const DEFAULT_CITIES: Array<{ name: string; lat: number; lon: number }> = [
  { name: 'Seoul', lat: 37.5665, lon: 126.978 },
  { name: 'London', lat: 51.5074, lon: -0.1278 },
  { name: 'Bangkok', lat: 13.7563, lon: 100.5018 },
  { name: 'Vancouver', lat: 49.2827, lon: -123.1207 },
];

DEFAULT_CITIES.forEach(({ name, lat, lon }) => createChapter(name, lat, lon));
ScrollTrigger.refresh();
loadAllChapterWeather();

// --- City search (Open-Meteo Geocoding API) ---
// Selecting a result adds a brand new pinned chapter (see createChapter)
// rather than a card in a list - the whole "Right now" list is gone.

const citySearchInput = document.querySelector<HTMLInputElement>('#citySearchInput')!;
const citySearchResults = document.querySelector<HTMLUListElement>('#citySearchResults')!;
const citySearchHint = document.querySelector<HTMLParagraphElement>('#citySearchHint')!;

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

function updateSearchAvailability() {
  const count = chapters.length;
  const atMax = count >= MAX_CHAPTERS;
  citySearchInput.disabled = atMax;
  citySearchInput.placeholder = atMax ? "You've reached the 8-chapter limit" : 'Search a city to add a chapter';
  citySearchHint.textContent = `${count} / ${MAX_CHAPTERS} city chapters`;
}

function closeSearchResults() {
  citySearchResults.hidden = true;
  citySearchResults.innerHTML = '';
  citySearchInput.setAttribute('aria-expanded', 'false');
}

function addCityChapter(result: GeocodingResult) {
  citySearchInput.value = '';
  closeSearchResults();

  const existing = chapters.find((chapter) => chapter.name === result.name);
  if (existing) {
    scrollToChapter(existing);
    return;
  }

  if (chapters.length >= MAX_CHAPTERS) {
    updateSearchAvailability();
    return;
  }

  const chapter = createChapter(result.name, result.latitude, result.longitude);
  ScrollTrigger.refresh();
  updateSearchAvailability();

  updateCityWeatherFor(chapter).then(() => {
    scrollToChapter(chapter);
  });
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

    button.addEventListener('click', () => addCityChapter(result));
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
// blended weather tint (see drawFrame's call to updateCursorColor).
const cursorDot = document.querySelector<HTMLDivElement>('#cursorDot')!;
const isTouchDevice = window.matchMedia('(pointer: coarse)').matches;

function updateCursorColor(tintColor: [number, number, number]) {
  cursorDot.style.backgroundColor = rgbString(tintColor);
}

if (!isTouchDevice) {
  cursorDot.hidden = false;
  document.body.classList.add('has-custom-cursor');

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

// Kicked off last, now that chapters/weather/cursor setup above have all
// run at least once synchronously - drawFrame() reads chapters[...] and
// module state defined throughout this file. updateFromSlider() also
// calls drawFrame() directly under reduced motion, so its very first call
// is deferred to here too (see the comment where it used to run, near the
// slider's `input` listener) - that covers the reduced-motion draw, so
// only the animation loop is still needed for the non-reduced-motion case.
updateFromSlider();
if (!prefersReducedMotion) {
  requestAnimationFrame(step);
}
