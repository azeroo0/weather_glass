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

const COLOR_KEYFRAMES: ColorKeyframe[] = [
  { hour: 0, color: [10, 10, 40] },
  { hour: 6, color: [255, 183, 178] },
  { hour: 12, color: [135, 206, 235] },
  { hour: 18, color: [255, 140, 66] },
  { hour: 24, color: [10, 10, 40] },
];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function colorForTime(hour: number): string {
  let i = 0;
  while (i < COLOR_KEYFRAMES.length - 2 && hour > COLOR_KEYFRAMES[i + 1].hour) {
    i++;
  }
  const from = COLOR_KEYFRAMES[i];
  const to = COLOR_KEYFRAMES[i + 1];
  const t = (hour - from.hour) / (to.hour - from.hour);
  const r = lerp(from.color[0], to.color[0], t);
  const g = lerp(from.color[1], to.color[1], t);
  const b = lerp(from.color[2], to.color[2], t);
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

let particleColor = colorForTime(Number(slider.value));

function updateFromSlider() {
  const hour = Number(slider.value);
  particleColor = colorForTime(hour);
  timeDisplay.textContent = formatTime(hour);
  weatherLabel.textContent = labelForTime(hour);
}

slider.addEventListener('input', updateFromSlider);
updateFromSlider();

document.querySelectorAll<HTMLElement>('.fade-up').forEach((section) => {
  gsap.from(section, {
    opacity: 0,
    y: 40,
    duration: 0.8,
    ease: 'power2.out',
    scrollTrigger: {
      trigger: section,
      start: 'top 80%',
    },
  });
});

function fieldAngle(x: number, y: number, time: number): number {
  return Math.sin(x * 0.01 + time) + Math.cos(y * 0.01 + time);
}

function step() {
  ctx.fillStyle = 'rgba(0, 0, 0, 0.05)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const time = performance.now() * 0.0005;

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

  requestAnimationFrame(step);
}

requestAnimationFrame(step);