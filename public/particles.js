// Canvas particle engine — sparkles, bursts, confetti.
// requestAnimationFrame loop, auto-pauses when no particles alive.
// Exposes window.__particles for pixel.js to call.

const canvas = document.createElement("canvas");
canvas.id = "fxCanvas";
canvas.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:1000;";
document.body.appendChild(canvas);
const ctx = canvas.getContext("2d", { alpha: true });

let dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
function resize() {
  dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  canvas.style.width = window.innerWidth + "px";
  canvas.style.height = window.innerHeight + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
}
resize();
window.addEventListener("resize", resize, { passive: true });

/** @type {Array<Particle>} */
const particles = [];
let rafId = null;
let lastT = 0;

class Particle {
  constructor({ x, y, vx, vy, ax = 0, ay = 0, life, color, size = 4, rot = 0, vrot = 0, shape = "square", drag = 1 }) {
    this.x = x; this.y = y;
    this.vx = vx; this.vy = vy;
    this.ax = ax; this.ay = ay;
    this.life = life;
    this.maxLife = life;
    this.color = color;
    this.size = size;
    this.rot = rot;
    this.vrot = vrot;
    this.shape = shape;
    this.drag = drag;
    this.dead = false;
  }
  step(dt) {
    this.vx = (this.vx + this.ax * dt) * Math.pow(this.drag, dt * 60);
    this.vy = (this.vy + this.ay * dt) * Math.pow(this.drag, dt * 60);
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.rot += this.vrot * dt;
    this.life -= dt;
    if (this.life <= 0) this.dead = true;
  }
  draw(ctx) {
    const alpha = Math.max(0, Math.min(1, this.life / this.maxLife));
    ctx.globalAlpha = alpha;
    ctx.fillStyle = this.color;
    const s = this.size;
    if (this.shape === "square" && this.rot === 0) {
      // hot path
      ctx.fillRect(Math.round(this.x - s / 2), Math.round(this.y - s / 2), s, s);
    } else {
      ctx.save();
      ctx.translate(this.x, this.y);
      ctx.rotate(this.rot);
      if (this.shape === "spark") {
        ctx.fillRect(-s / 2, -1, s, 2);
        ctx.fillRect(-1, -s / 2, 2, s);
      } else {
        ctx.fillRect(-s / 2, -s / 2, s, s);
      }
      ctx.restore();
    }
  }
}

function spawn(p) { particles.push(p); start(); }

function start() {
  if (rafId !== null) return;
  lastT = performance.now();
  rafId = requestAnimationFrame(tick);
}

function tick(now) {
  const dt = Math.min(0.05, (now - lastT) / 1000); // clamp for tab-switch jumps
  lastT = now;
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.step(dt);
    if (p.dead || p.y > window.innerHeight + 50) {
      particles.splice(i, 1);
    } else {
      p.draw(ctx);
    }
  }
  ctx.globalAlpha = 1;
  if (particles.length === 0) {
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    rafId = null;
    return;
  }
  rafId = requestAnimationFrame(tick);
}

// ─── Public API ────────────────────────────────────────────

const COLORS = {
  needs_input: ["#fbbf24", "#fde047", "#fff7d6"],
  needs_permission: ["#ef4444", "#fb7185", "#fde047"],
  spark: ["#fde047", "#fff7d6"],
  confetti: ["#fbbf24", "#34d399", "#38bdf8", "#a78bfa", "#fb7185", "#22d3ee", "#f472b6"],
};

function rand(a, b) { return a + Math.random() * (b - a); }
function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }

export function burst(x, y, status = "needs_input") {
  const palette = COLORS[status] || COLORS.needs_input;
  const N = 22;
  for (let i = 0; i < N; i++) {
    const angle = (i / N) * Math.PI * 2 + rand(-0.1, 0.1);
    const speed = rand(120, 240);
    spawn(new Particle({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      ay: 60,
      drag: 0.94,
      life: rand(0.6, 1.0),
      color: pick(palette),
      size: rand(2, 5) | 0 * 2 + 3,
      shape: "square",
    }));
  }
  // Center flash
  spawn(new Particle({
    x, y, vx: 0, vy: 0, life: 0.35, color: pick(palette), size: 14, shape: "square",
  }));
}

export function sparkAt(x, y) {
  const palette = COLORS.spark;
  for (let i = 0; i < 5; i++) {
    spawn(new Particle({
      x: x + rand(-3, 3),
      y: y + rand(-3, 3),
      vx: rand(-30, 30),
      vy: rand(-90, -40),
      ay: 80,
      drag: 0.96,
      life: rand(0.4, 0.7),
      color: pick(palette),
      size: 3,
      shape: "square",
    }));
  }
  spawn(new Particle({
    x, y, vx: 0, vy: 0, life: 0.25, color: "#fff7d6", size: 6, shape: "spark", vrot: 8,
  }));
}

export function confetti() {
  const W = window.innerWidth;
  for (let i = 0; i < 80; i++) {
    spawn(new Particle({
      x: Math.random() * W,
      y: -10 - Math.random() * 80,
      vx: rand(-40, 40),
      vy: rand(80, 220),
      ax: 0,
      ay: 40,
      drag: 1,
      life: rand(2.0, 3.0),
      color: pick(COLORS.confetti),
      size: rand(4, 9) | 0,
      shape: "square",
      rot: Math.random() * Math.PI,
      vrot: rand(-6, 6),
    }));
  }
}

window.__particles = { burst, sparkAt, confetti };
