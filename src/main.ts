const canvas = document.querySelector<HTMLCanvasElement>('#flowCanvas')!;
const slider = document.querySelector<HTMLInputElement>('#timeSlider')!;
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

const NAVY: [number, number, number] = [10, 10, 40];
const SKY: [number, number, number] = [135, 206, 235];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function colorForTime(hour: number): string {
  const t = 1 - Math.abs(hour - 12) / 12;
  const r = lerp(NAVY[0], SKY[0], t);
  const g = lerp(NAVY[1], SKY[1], t);
  const b = lerp(NAVY[2], SKY[2], t);
  return `rgb(${r}, ${g}, ${b})`;
}

let particleColor = colorForTime(Number(slider.value));

slider.addEventListener('input', () => {
  particleColor = colorForTime(Number(slider.value));
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
