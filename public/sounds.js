// claude-tower — unified sound module.
//
// Synthesizes short, tasteful chimes via Web Audio. No file assets.
// Public API: play(name)
//   approval-arrive  — bright two-note ping (G6 → B6 rise)
//   approval-resolve — single descending chirp (E6 → A5 glide)
//   attention        — subtle low pulse (E4 sine, slow envelope)
//   error            — sharp dyad (D5 + Eb5 dissonance, square)
//   click            — ultra-short tick (one cycle blip at 2.4kHz)
//   success          — warm two-note rise (C5 → G5, triangle)
//
// All sounds respect:
//   • document.hidden                 → silent
//   • localStorage tower:sound = off  → silent
//   • prefers-reduced-motion          → silent (treat sound like motion)
// Volume capped at 0.15.

const MAX_GAIN = 0.15;

let ctx = null;
function audio() {
  if (ctx) return ctx;
  try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
  return ctx;
}

// Browser autoplay policy — unlock on any first user gesture.
let unlocked = false;
function unlock() {
  if (unlocked) return;
  const c = audio();
  if (!c) return;
  if (c.state === "suspended") c.resume().catch(() => {});
  unlocked = true;
}
for (const ev of ["click", "keydown", "touchstart"]) {
  window.addEventListener(ev, unlock, { passive: true });
}

function reducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}
function soundOff() {
  try { return localStorage.getItem("tower:sound") === "off"; } catch { return false; }
}
function muted() {
  return document.hidden || soundOff() || reducedMotion();
}

// Envelope helper: short attack, exp decay.
function envelope(gain, t0, peak, attack, decay) {
  const p = Math.min(peak, MAX_GAIN);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(p, t0 + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
}

function tone({ freq, type = "sine", t0, attack = 0.008, decay = 0.18, peak = 0.10, glideTo = null, glideDur = 0 }) {
  const c = audio();
  if (!c) return;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (glideTo && glideDur > 0) {
    o.frequency.exponentialRampToValueAtTime(glideTo, t0 + glideDur);
  }
  envelope(g, t0, peak, attack, decay);
  o.connect(g).connect(c.destination);
  o.start(t0);
  o.stop(t0 + attack + decay + 0.02);
}

const SOUNDS = {
  "approval-arrive"(now) {
    // Bright two-note ping — G6 then B6, triangle on top of sine for warmth.
    tone({ freq: 1568, type: "sine",     t0: now,        peak: 0.10, attack: 0.006, decay: 0.18 });
    tone({ freq: 1568, type: "triangle", t0: now,        peak: 0.05, attack: 0.006, decay: 0.18 });
    tone({ freq: 1976, type: "sine",     t0: now + 0.10, peak: 0.10, attack: 0.006, decay: 0.22 });
    tone({ freq: 1976, type: "triangle", t0: now + 0.10, peak: 0.05, attack: 0.006, decay: 0.22 });
  },
  "approval-resolve"(now) {
    // Single descending chirp E6 → A5.
    tone({ freq: 1318, type: "sine", t0: now, peak: 0.10, attack: 0.006, decay: 0.22, glideTo: 880, glideDur: 0.22 });
  },
  "attention"(now) {
    // Low slow pulse — E4, long envelope, sub-harmonic.
    tone({ freq: 329.6, type: "sine",     t0: now, peak: 0.09, attack: 0.04, decay: 0.42 });
    tone({ freq: 164.8, type: "triangle", t0: now, peak: 0.04, attack: 0.04, decay: 0.42 });
  },
  "error"(now) {
    // Sharp dyad — D5 + Eb5 (semitone clash), square waves, short.
    tone({ freq: 587.3, type: "square", t0: now,        peak: 0.08, attack: 0.004, decay: 0.10 });
    tone({ freq: 622.3, type: "square", t0: now,        peak: 0.08, attack: 0.004, decay: 0.10 });
    tone({ freq: 587.3, type: "square", t0: now + 0.12, peak: 0.08, attack: 0.004, decay: 0.10 });
    tone({ freq: 622.3, type: "square", t0: now + 0.12, peak: 0.08, attack: 0.004, decay: 0.10 });
  },
  "click"(now) {
    // Ultra-short tick.
    tone({ freq: 2400, type: "sine", t0: now, peak: 0.06, attack: 0.002, decay: 0.025 });
  },
  "success"(now) {
    // Warm two-note rise C5 → G5, triangle + sine layer.
    tone({ freq: 523.3, type: "triangle", t0: now,        peak: 0.10, attack: 0.008, decay: 0.20 });
    tone({ freq: 523.3, type: "sine",     t0: now,        peak: 0.05, attack: 0.008, decay: 0.20 });
    tone({ freq: 784.0, type: "triangle", t0: now + 0.11, peak: 0.10, attack: 0.008, decay: 0.26 });
    tone({ freq: 784.0, type: "sine",     t0: now + 0.11, peak: 0.05, attack: 0.008, decay: 0.26 });
  },
};

export function play(name) {
  if (muted()) return;
  const c = audio();
  if (!c) return;
  if (c.state === "suspended") c.resume().catch(() => {});
  const fn = SOUNDS[name];
  if (!fn) return;
  try { fn(c.currentTime); } catch (e) { /* never let audio crash UI */ }
}

export function isSoundOn() { return !soundOff(); }
export function setSoundOn(on) {
  try { localStorage.setItem("tower:sound", on ? "on" : "off"); } catch {}
}
