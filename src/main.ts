import './style.css';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

const canvas = document.querySelector<HTMLCanvasElement>('#flowCanvas')!;
const slider = document.querySelector<HTMLInputElement>('#timeSlider')!;
const timeDisplay = document.querySelector<HTMLSpanElement>('#currentTime')!;
const weatherLabel = document.querySelector<HTMLSpanElement>('#weatherLabel')!;
const ctx = canvas.getContext('2d')!;

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
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
}

const particles: Particle[] = Array.from({ length: PARTICLE_COUNT }, () => ({
  x: Math.random() * canvas.width,
  y: Math.random() * canvas.height,
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

function colorForTime(hour: number): string {
  const [r, g, b] = interpolateKeyframes(PARTICLE_KEYFRAMES, hour);
  return `rgb(${r}, ${g}, ${b})`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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

let flowSpeed = 1.5;
let flowBias = { x: 0, y: 0 };
let flowTurbulence = 0;
let cloudDarkenFactor = 1;

function applyWeatherToFlowField(weather: CityWeather | undefined) {
  if (!weather) {
    flowSpeed = 1.5;
    flowBias = { x: 0, y: 0 };
    flowTurbulence = 0;
    cloudDarkenFactor = 1;
    return;
  }

  flowSpeed = clamp(0.4 + weather.windspeed * 0.06, 0.4, 4.5);

  const biasStrength = clamp(weather.windspeed / 20, 0.15, 1.5);
  const flowBearing = (weather.winddirection + 180) % 360; // wind blows TOWARD this bearing
  const biasAngle = ((flowBearing - 90) * Math.PI) / 180; // meteorological bearing -> canvas angle
  flowBias = { x: Math.cos(biasAngle) * biasStrength, y: Math.sin(biasAngle) * biasStrength };

  flowTurbulence = clamp(weather.precipitation * 0.15, 0, 1.2);
  cloudDarkenFactor = 1 - clamp(weather.cloudcover / 100, 0, 1) * 0.35;
}

function effectiveBackgroundRGB(hour: number): [number, number, number] {
  const [r, g, b] = interpolateKeyframes(BACKGROUND_KEYFRAMES, hour);
  return [r * cloudDarkenFactor, g * cloudDarkenFactor, b * cloudDarkenFactor];
}

let particleColor = colorForTime(Number(slider.value));
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
  particleColor = colorForTime(hour);
  applyAmbient(hour);
  timeDisplay.textContent = formatTime(hour);
  weatherLabel.textContent = labelForTime(hour);
  slider.setAttribute('aria-valuetext', `${formatTime(hour)}, ${labelForTime(hour)}`);
  if (prefersReducedMotion) {
    drawFrame(0);
  }
}

slider.addEventListener('input', updateFromSlider);
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

function drawFrame(time: number) {
  const [br, bg, bb] = backgroundRGB;
  ctx.fillStyle = `rgba(${br}, ${bg}, ${bb}, 0.05)`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = particleColor;
  for (const p of particles) {
    const angle = fieldAngle(p.x, p.y, time);
    let vx = Math.cos(angle) + flowBias.x;
    let vy = Math.sin(angle) + flowBias.y;

    if (flowTurbulence > 0) {
      vx += (Math.random() - 0.5) * flowTurbulence;
      vy += (Math.random() - 0.5) * flowTurbulence;
    }

    const len = Math.hypot(vx, vy) || 1;
    p.x += (vx / len) * flowSpeed;
    p.y += (vy / len) * flowSpeed;

    if (p.x < 0) p.x = canvas.width;
    if (p.x > canvas.width) p.x = 0;
    if (p.y < 0) p.y = canvas.height;
    if (p.y > canvas.height) p.y = 0;

    ctx.fillRect(p.x, p.y, 2, 2);
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

const cityButtons = document.querySelectorAll<HTMLButtonElement>('.city-button');

function updateCitySelectionUI() {
  cityButtons.forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.name === selectedCityName));
  });
}

function selectCity(name: string) {
  selectedCityName = name;
  applyWeatherToFlowField(cityWeatherByName.get(name));
  applyAmbient(Number(slider.value));
  updateCitySelectionUI();
  if (prefersReducedMotion) {
    drawFrame(0);
  }
}

cityButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const name = button.dataset.name;
    if (name && cityWeatherByName.has(name)) {
      selectCity(name);
    }
  });
});

async function loadCityWeather() {
  await Promise.all(
    Array.from(cityButtons).map(async (button) => {
      const tempEl = button.querySelector<HTMLSpanElement>('.temp')!;
      const weatherEl = button.querySelector<HTMLSpanElement>('.weather')!;
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
      } catch {
        tempEl.textContent = '--';
        weatherEl.textContent = 'Unavailable';
      }
    }),
  );

  const defaultCity = cityButtons[0]?.dataset.name;
  const firstAvailable = defaultCity && cityWeatherByName.has(defaultCity) ? defaultCity : [...cityWeatherByName.keys()][0];
  if (firstAvailable) {
    selectCity(firstAvailable);
  }
}

loadCityWeather();
