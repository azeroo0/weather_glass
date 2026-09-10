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

let particleColor = colorForTime(Number(slider.value));
let backgroundRGB = interpolateKeyframes(BACKGROUND_KEYFRAMES, Number(slider.value));

function luminanceOf([r, g, b]: [number, number, number]): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function updateFromSlider() {
  const hour = Number(slider.value);
  particleColor = colorForTime(hour);
  backgroundRGB = interpolateKeyframes(BACKGROUND_KEYFRAMES, hour);
  document.body.style.backgroundColor = `rgb(${backgroundRGB[0]}, ${backgroundRGB[1]}, ${backgroundRGB[2]})`;
  document.body.classList.toggle('is-light', luminanceOf(backgroundRGB) > 150);
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
    p.x += Math.cos(angle) * 1.5;
    p.y += Math.sin(angle) * 1.5;

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

async function loadCityWeather() {
  const items = document.querySelectorAll<HTMLLIElement>('#cityList li');
  await Promise.all(
    Array.from(items).map(async (li) => {
      const tempEl = li.querySelector<HTMLSpanElement>('.temp')!;
      const weatherEl = li.querySelector<HTMLSpanElement>('.weather')!;
      try {
        const { lat, lon } = li.dataset;
        const res = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`,
        );
        if (!res.ok) throw new Error('Request failed');
        const data = await res.json();
        tempEl.textContent = `${Math.round(data.current_weather.temperature)}°C`;
        weatherEl.textContent = weatherLabelFromCode(data.current_weather.weathercode);
      } catch {
        tempEl.textContent = '--';
        weatherEl.textContent = 'Unavailable';
      }
    }),
  );
}

loadCityWeather();
