/* ============================================================
   Double-Slit Experiment — app.js
   Physics engine + particle simulation + canvas rendering + UI
   ============================================================ */

'use strict';

// ── Constants ────────────────────────────────────────────────

const SUPPORTED_LANGS  = ['de', 'en'];
const MAX_HITS         = 50000; // cap stored hits to prevent memory issues
const HITS_TRIM        = 5000;  // how many to remove when cap is reached
const GLOW_ALPHA       = 0x55;  // outer glow transparency (0–255)
const CORE_ALPHA       = 0xFF;  // bright core transparency (0–255)
const INTENSITY_SCALE  = 2.0;   // multiplier for screen brightness (>1 = brighter)
const SCREEN_WIDTH     = 20;    // visual width of the screen bar in pixels

// ── i18n ─────────────────────────────────────────────────────

const I18N = { _data: {}, _lang: 'de' };

I18N.load = async function (lang) {
  if (!this._data[lang]) {
    const res = await fetch(`locales/${lang}.json`);
    this._data[lang] = await res.json();
  }
  this._lang = lang;
  this._apply();
  document.documentElement.lang = lang;
  document.querySelectorAll('.lang-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.lang === lang);
  });
};

I18N.t = function (key) {
  const parts = key.split('.');
  let v = this._data[this._lang];
  for (const p of parts) { v = v && v[p]; }
  return v != null ? v : key;
};

I18N._apply = function () {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    const txt = this.t(key);
    if (txt !== key) el.textContent = txt;
  });
  // Rebuild particle select options
  const sel = document.getElementById('particleType');
  if (sel) {
    const current = sel.value;
    sel.querySelectorAll('option').forEach(o => {
      const k = `particleTypes.${o.value}`;
      const txt = this.t(k);
      if (txt !== k) o.textContent = txt;
    });
    sel.value = current;
  }
  App.updateAllDisplays();
  // Re-render canvas so bottom labels update immediately
  if (Sim.canvas && !Sim.running) Sim.render();
};

// ── Particle type definitions ────────────────────────────────

const PARTICLES = {
  photon:   { color: '#FFD700', classical: false, icon: '⚡', defaultLambda: 40 },
  electron: { color: '#4FC3F7', classical: false, icon: '⚛', defaultLambda: 25 },
  proton:   { color: '#EF5350', classical: false, icon: 'p⁺', defaultLambda: 10 },
  neutron:  { color: '#90A4AE', classical: false, icon: 'n',  defaultLambda: 15 },
  atom:     { color: '#66BB6A', classical: false, icon: 'He', defaultLambda: 5  },
  ball:     { color: '#E0E0E0', classical: true,  icon: '●',  defaultLambda: 0  },
  paint:    { color: null,      classical: true,  icon: '🎨', defaultLambda: 0  },
};

// ── Physics engine ───────────────────────────────────────────

const Physics = {
  /**
   * Normalised intensity at screen position y (from centre).
   * All length parameters (lambda, d, a, y, L) must be in the same unit.
   */
  intensity(y, lambda, d, a, N, L) {
    if (lambda <= 0) {
      // Classical: Gaussian shadow of each slit (see sampleClassical)
      return 0;
    }
    const sinT = y / Math.sqrt(y * y + L * L);

    // Single-slit envelope
    const bArg = Math.PI * a * sinT / lambda;
    const single = Math.abs(bArg) < 1e-9
      ? 1.0
      : Math.pow(Math.sin(bArg) / bArg, 2);

    if (N <= 1) return single;

    // Multi-slit interference
    const dArg   = Math.PI * d * sinT / lambda;
    const sinD   = Math.sin(dArg);
    const multi  = Math.abs(sinD) < 1e-9
      ? 1.0
      : Math.pow(Math.sin(N * dArg) / (N * sinD), 2);

    return single * multi;
  },

  /**
   * Build a cumulative distribution function for screen positions.
   * Returns { positions[], cdf[] } where cdf is normalised 0→1.
   */
  buildCDF(lambda, d, a, N, L, screenHalf, classical, slitCentres) {
    const STEPS = 1200;
    const pos   = new Float64Array(STEPS + 1);
    const vals  = new Float64Array(STEPS + 1);

    for (let i = 0; i <= STEPS; i++) {
      const y = (i / STEPS) * 2 * screenHalf - screenHalf;
      pos[i]  = y;
      if (classical) {
        // Sum Gaussian from each slit projected onto screen
        let v = 0;
        const sigma = Math.max(a * 1.2, 8);
        for (const sc of slitCentres) {
          v += Math.exp(-0.5 * ((y - sc) / sigma) ** 2);
        }
        vals[i] = v;
      } else {
        vals[i] = this.intensity(y, lambda, d, a, N, L);
      }
    }

    const cdf = new Float64Array(STEPS + 1);
    cdf[0] = 0;
    for (let i = 1; i <= STEPS; i++) {
      cdf[i] = cdf[i - 1] + vals[i];
    }
    const total = cdf[STEPS];
    if (total > 0) {
      for (let i = 0; i <= STEPS; i++) cdf[i] /= total;
    }
    return { pos, cdf, STEPS };
  },

  /** Inverse-CDF sample. */
  sample({ pos, cdf, STEPS }) {
    const r = Math.random();
    let lo = 0, hi = STEPS;
    while (lo < hi - 1) {
      const mid = (lo + hi) >>> 1;
      if (cdf[mid] <= r) lo = mid; else hi = mid;
    }
    const span = cdf[hi] - cdf[lo];
    const t    = span > 1e-12 ? (r - cdf[lo]) / span : 0.5;
    return pos[lo] + t * (pos[hi] - pos[lo]);
  }
};

// ── Simulation state ─────────────────────────────────────────

const Sim = {
  canvas:     null,
  ctx:        null,
  running:    false,
  rafId:      null,
  particles:  [],   // active (travelling) particles
  hits:       [],   // { y, color } – accumulated screen hits
  hitCount:   0,
  cdfData:    null,
  dirty:      true, // cdf needs rebuild

  // Parameters (in canvas-pixel units where applicable)
  params: {
    numSlits:   2,
    slitWidth:  20,   // px
    slitSep:    70,   // px  (centre-to-centre)
    lambda:     25,   // px  (simulation unit, same scale as d/a)
    sourceFrac: 0.28, // slit x as fraction of canvas width from source
    screenFrac: 0.42, // screen x relative to slit
    particleType: 'electron',
    speed:      5,    // 1-25  (animation / movement speed)
    density:    5,    // 1-10  (emission rate, particles per second)
    sequential: false, // emit one particle at a time
  },

  init(canvas) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');
    this.resize();
    this.render();
  },

  resize() {
    const el = this.canvas;
    el.width  = el.clientWidth  || 800;
    el.height = el.clientHeight || 340;
    this.dirty = true;
  },

  // Derived geometry
  get sourceX() { return Math.round(this.canvas.width * 0.05); },
  get slitX()   { return Math.round(this.canvas.width * (0.05 + this.params.sourceFrac)); },
  get screenX() { return Math.round(this.slitX + this.canvas.width * this.params.screenFrac); },
  get L()       { return this.screenX - this.slitX; },
  get centerY() { return Math.round(this.canvas.height / 2); },

  slitCentres() {
    const { numSlits, slitSep } = this.params;
    const cy = this.centerY;
    const out = [];
    for (let i = 0; i < numSlits; i++) {
      out.push(cy + (i - (numSlits - 1) / 2) * slitSep);
    }
    return out;
  },

  rebuildCDF() {
    const { numSlits, slitWidth, slitSep, lambda } = this.params;
    const pt      = PARTICLES[this.params.particleType];
    const classic = pt.classical || lambda <= 0;
    const half    = this.canvas.height * 0.6;
    // Slit centres relative to canvas centre (needed for classical Gaussian CDF)
    const slitCentresRel = this.slitCentres().map(sc => sc - this.centerY);
    this.cdfData  = Physics.buildCDF(
      lambda, slitSep, slitWidth, numSlits, this.L,
      half, classic, slitCentresRel
    );
    this.dirty = false;
  },

  start() {
    if (this.running) return;
    this.running = true;
    this._sequentialReady = true; // ensure ready for sequential mode
    this._loop();
  },

  stop() {
    this.running = false;
    if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = null; }
  },

  toggle() {
    if (this.running) this.stop(); else this.start();
  },

  reset() {
    this.stop();
    this.particles = [];
    this.hits      = [];
    this.hitCount  = 0;
    this.dirty     = true;
    this._sequentialReady = true; // reset sequential flag
    this.render();
    App.updateParticleCount();
  },

  resetScreen() {
    this.hits     = [];
    this.hitCount = 0;
    this.render();   // re-render immediately so screen clears even when paused
    App.updateParticleCount();
  },

  _loop() {
    if (!this.running) return;
    if (this.dirty) this.rebuildCDF();

    // Sub-integer emission via accumulator so density=1 emits ~3 particles/sec
    if (!this.params.sequential) {
      this._emitAccum = (this._emitAccum || 0)
        + (this.params.density * this.params.density) * 0.05;
      const pps = Math.floor(this._emitAccum);
      this._emitAccum -= pps;
      for (let i = 0; i < pps; i++) this._spawn();
    } else {
      // Sequential mode: emit only if no particles are active
      if (this._sequentialReady && this.particles.length === 0) {
        this._spawn();
        this._sequentialReady = false;
      }
    }

    this._update();
    this.render();

    // Update hit counter in UI every ~20 frames to avoid DOM thrashing
    this._frameCount = ((this._frameCount || 0) + 1) % 20;
    if (this._frameCount === 0) App.updateParticleCount();

    this.rafId = requestAnimationFrame(() => this._loop());
  },

  _spawn() {
    if (!this.cdfData) return;
    const { slitWidth } = this.params;
    const pt       = PARTICLES[this.params.particleType];
    const classic  = pt.classical || this.params.lambda <= 0;
    const centres  = this.slitCentres();

    // Colour: paint = random, others = particle colour
    let color = pt.color;
    if (pt.color === null) {
      const hue = Math.random() * 360;
      color = `hsl(${hue},90%,65%)`;
    }

    if (classic) {
      // Classical: aim at a random y across the whole barrier region
      // Some particles will be blocked; only those in slits reach the screen
      const top    = centres[0] - slitWidth - 30;
      const bot    = centres[centres.length - 1] + slitWidth + 30;
      const slitY  = top + Math.random() * (bot - top);
      const inSlit = this._inSlit(slitY);

      // Classical geometric projection: particle travels straight through the slit
      // Landing position ≈ slit position + small divergence spread
      const screenY = inSlit
        ? slitY + (Math.random() - 0.5) * slitWidth * 1.5
        : slitY; // will be blocked at slit plane anyway

      this.particles.push({
        x: this.sourceX,
        y: this.centerY + (Math.random() - 0.5) * 6,
        phase: 1,
        slitX: this.slitX,
        slitY,
        screenX: this.screenX,
        screenY,
        color,
        alive: true,
      });
    } else {
      // Quantum: sample landing position from interference pattern
      const landY = this.centerY + Physics.sample(this.cdfData);
      // Visually route through a random slit (superposition)
      const slitY = centres[Math.floor(Math.random() * centres.length)]
                    + (Math.random() - 0.5) * slitWidth * 0.6;

      this.particles.push({
        x: this.sourceX,
        y: this.centerY + (Math.random() - 0.5) * 6,
        phase: 1,
        slitX: this.slitX,
        slitY,
        screenX: this.screenX,
        screenY: landY,
        color,
        alive: true,
      });
    }
  },

  _update() {
    // Slower speed range: at min=1 → 1.5 px/frame; at max=10 → 7.8 px/frame
    const speed = 0.8 + this.params.speed * 0.7;
    const newParticles = [];

    for (const p of this.particles) {
      if (!p.alive) continue;

      const tx = p.phase === 1 ? p.slitX  : p.screenX;
      const ty = p.phase === 1 ? p.slitY  : p.screenY;
      const dx = tx - p.x;
      const dy = ty - p.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= speed) {
        p.x = tx; p.y = ty;
        if (p.phase === 1) {
          // Check if particle is blocked by the barrier
          if (!this._inSlit(ty)) { p.alive = false; continue; }
          p.phase = 2;
        } else {
          // Hit the screen
          this.hits.push({ y: p.y, color: p.color });
          // Cap hits to avoid memory issues on long runs
          if (this.hits.length > MAX_HITS) this.hits.splice(0, HITS_TRIM);
          this.hitCount++;
          p.alive = false;
          // In sequential mode, mark ready to emit next particle
          if (this.params.sequential) {
            this._sequentialReady = true;
          }
          continue;
        }
      } else {
        p.x += (dx / dist) * speed;
        p.y += (dy / dist) * speed;
      }
      newParticles.push(p);
    }
    this.particles = newParticles;
  },

  _inSlit(y) {
    const { slitWidth } = this.params;
    const half = slitWidth / 2;
    for (const sc of this.slitCentres()) {
      if (Math.abs(y - sc) <= half) return true;
    }
    return false;
  },

  // ── Rendering ──────────────────────────────────────────────

  render() {
    const { ctx, canvas } = this;
    if (!ctx) return;
    const W = canvas.width, H = canvas.height;

    // Background
    ctx.fillStyle = '#050810';
    ctx.fillRect(0, 0, W, H);

    this._drawGrid();
    this._drawBarrier();
    this._drawScreen();
    this._drawSource();
    this._drawParticles();
    this._drawLabels();

    if (document.getElementById('showGradient')?.checked) {
      this._drawGradient();
    }
    if (document.getElementById('showGraph')?.checked) {
      this._drawGraph();
    }
  },

  _drawGrid() {
    const { ctx, canvas } = this;
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth   = 1;
    const step = 40;
    for (let x = 0; x < canvas.width; x += step) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
    }
    for (let y = 0; y < canvas.height; y += step) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
    }
  },

  _drawBarrier() {
    const { ctx, canvas } = this;
    const { slitWidth } = this.params;
    const x  = this.slitX;
    const bw = 8; // barrier visual thickness

    // Solid barrier
    ctx.fillStyle = '#455A64';
    ctx.fillRect(x - bw / 2, 0, bw, canvas.height);

    // Cut out slits (paint background colour)
    ctx.fillStyle = '#050810';
    for (const sc of this.slitCentres()) {
      ctx.fillRect(x - bw / 2, sc - slitWidth / 2, bw, slitWidth);
    }

    // Highlight slit edges
    ctx.strokeStyle = '#78909C';
    ctx.lineWidth   = 1;
    for (const sc of this.slitCentres()) {
      ctx.strokeRect(x - bw / 2 + 0.5, sc - slitWidth / 2 + 0.5, bw - 1, slitWidth - 1);
    }
  },

  _drawScreen() {
    const { ctx, canvas } = this;
    const x  = this.screenX;
    const sw = SCREEN_WIDTH;

    // Screen bar background (wider halo behind the bar)
    ctx.fillStyle = '#1a2730';
    ctx.fillRect(x - 4, 0, sw + 8, canvas.height);
    ctx.fillStyle = '#263238';
    ctx.fillRect(x, 0, sw, canvas.height);
    ctx.strokeStyle = '#37474F';
    ctx.lineWidth   = 1;
    ctx.strokeRect(x + 0.5, 0.5, sw - 1, canvas.height - 1);

    if (this.hits.length === 0) return;

    const pt      = PARTICLES[this.params.particleType];
    const isPaint = this.params.particleType === 'paint';

    if (isPaint) {
      // Paint: draw each coloured dot individually across the wider bar
      for (const hit of this.hits) {
        ctx.fillStyle = hit.color;
        ctx.fillRect(x + 2, Math.round(hit.y), sw - 4, 1);
      }
    } else {
      // Quantum/classical: density-map for clean visualisation
      const cellH    = 2;
      const numCells = Math.ceil(canvas.height / cellH);
      const counts   = new Int32Array(numCells);
      let   maxCount = 0;
      for (const hit of this.hits) {
        const c = Math.max(0, Math.min(numCells - 1, Math.floor(hit.y / cellH)));
        if (++counts[c] > maxCount) maxCount = counts[c];
      }
      const col = pt.color || '#9E9E9E';
      for (let c = 0; c < numCells; c++) {
        if (counts[c] === 0) continue;
        // Doubled intensity: sqrt-scale then multiply by INTENSITY_SCALE, clamped to 1
        const alpha = Math.min(Math.pow(counts[c] / maxCount, 0.5) * INTENSITY_SCALE, 1.0);
        const py    = c * cellH;
        // Soft glow halo (wider than before)
        ctx.fillStyle = col + Math.round(alpha * GLOW_ALPHA).toString(16).padStart(2, '0');
        ctx.fillRect(x - 12, py, sw + 24, cellH);
        // Bright core
        ctx.fillStyle = col + Math.round(alpha * CORE_ALPHA).toString(16).padStart(2, '0');
        ctx.fillRect(x, py, sw, cellH);
      }
    }
  },

  _drawSource() {
    const { ctx } = this;
    const x  = this.sourceX;
    const y  = this.centerY;
    const pt = PARTICLES[this.params.particleType];

    // Glow
    const grd = ctx.createRadialGradient(x, y, 2, x, y, 20);
    const col = pt.color || '#9E9E9E';
    grd.addColorStop(0, col + 'AA');
    grd.addColorStop(1, col + '00');
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.arc(x, y, 20, 0, Math.PI * 2);
    ctx.fill();

    // Core
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth   = 1.5;
    ctx.stroke();
  },

  _drawParticles() {
    const { ctx } = this;
    for (const p of this.particles) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.fill();
    }
  },

  _drawLabels() {
    const { ctx, canvas } = this;
    ctx.font      = '11px sans-serif';
    ctx.fillStyle = 'rgba(139,148,158,0.8)';
    ctx.textAlign = 'center';

    const label = (x, text) => {
      ctx.fillText(text, x, canvas.height - 6);
    };

    label(this.sourceX, I18N.t('labels.source'));
    label(this.slitX,   I18N.t('labels.slits'));
    label(this.screenX + SCREEN_WIDTH / 2, I18N.t('labels.screen'));
  },

  _drawGradient() {
    const { ctx, canvas } = this;
    const { numSlits, slitWidth, slitSep, lambda } = this.params;
    const pt      = PARTICLES[this.params.particleType];
    const classic = pt.classical || lambda <= 0;
    const L       = this.L;
    const cx      = this.centerY;
    const sx      = this.screenX;
    const sw      = 24; // gradient band width (drawn to the right of the screen bar)

    for (let py = 0; py < canvas.height; py++) {
      const y = py - cx;
      let intensity;
      if (classic) {
        intensity = 0;
        const sigma = Math.max(slitWidth * 1.2, 8);
        for (const sc of this.slitCentres()) {
          intensity += Math.exp(-0.5 * ((py - sc) / sigma) ** 2);
        }
        intensity = Math.min(intensity, 1);
      } else {
        intensity = Physics.intensity(y, lambda, slitSep, slitWidth, numSlits, L);
      }
      const a = Math.min(intensity * 0.75, 0.75);
      ctx.fillStyle = `rgba(88,166,255,${a.toFixed(3)})`;
      ctx.fillRect(sx + SCREEN_WIDTH + 2, py, sw, 1);
    }
  },

  _drawGraph() {
    const { ctx, canvas } = this;
    const { numSlits, slitWidth, slitSep, lambda } = this.params;
    const pt      = PARTICLES[this.params.particleType];
    const classic = pt.classical || lambda <= 0;
    const L       = this.L;
    const cx      = this.centerY;
    const H       = canvas.height;
    const gw      = 60;
    // graph starts after screen bar + gradient band (24px) + spacing (2px each)
    const gx      = this.screenX + SCREEN_WIDTH + 28;

    // Background
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(gx, 0, gw, H);

    // Compute and normalise
    const vals = new Float64Array(H);
    let maxV = 0;
    for (let py = 0; py < H; py++) {
      const y = py - cx;
      if (classic) {
        const sigma = Math.max(slitWidth * 1.2, 8);
        let v = 0;
        for (const sc of this.slitCentres()) {
          v += Math.exp(-0.5 * ((py - sc) / sigma) ** 2);
        }
        vals[py] = v;
      } else {
        vals[py] = Physics.intensity(y, lambda, slitSep, slitWidth, numSlits, L);
      }
      if (vals[py] > maxV) maxV = vals[py];
    }

    // Plot
    ctx.strokeStyle = '#4FC3F7';
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    for (let py = 0; py < H; py++) {
      const x = gx + (maxV > 0 ? (vals[py] / maxV) * (gw - 4) : 0);
      if (py === 0) ctx.moveTo(x, py); else ctx.lineTo(x, py);
    }
    ctx.stroke();

    // Axis
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth   = 1;
    ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke();
  },
};

// ── App controller ───────────────────────────────────────────

const App = {
  async init() {
    // Detect browser language preference
    const browserLang = SUPPORTED_LANGS.find(l => navigator.language?.startsWith(l)) || 'en';
    const stored      = localStorage.getItem('dse_lang');
    // Only accept known language codes from storage to prevent path traversal
    const savedLang   = SUPPORTED_LANGS.includes(stored) ? stored : browserLang;

    await I18N.load(savedLang);

    const canvas = document.getElementById('experimentCanvas');
    Sim.init(canvas);

    this._bindEvents();
    this.updateAllDisplays();

    // Handle resize
    const ro = new ResizeObserver(() => {
      Sim.resize();
      if (!Sim.running) Sim.render();
    });
    ro.observe(canvas.parentElement);
  },

  _bindEvents() {
    // Language
    document.querySelectorAll('.lang-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const lang = btn.dataset.lang;
        localStorage.setItem('dse_lang', lang);
        I18N.load(lang);
      });
    });

    // Play / Pause / Reset
    document.getElementById('btnPlay').addEventListener('click', () => {
      Sim.toggle();
      this._updatePlayBtn();
    });
    document.getElementById('btnReset').addEventListener('click', () => {
      Sim.reset();
      this._updatePlayBtn();
    });
    document.getElementById('btnResetScreen').addEventListener('click', () => {
      Sim.resetScreen();
    });

    // Particle type
    document.getElementById('particleType').addEventListener('change', e => {
      const pt = e.target.value;
      Sim.params.particleType = pt;
      const pDef = PARTICLES[pt];
      // Set default lambda for the new particle type
      if (pDef.classical) {
        document.getElementById('wavelength').disabled = true;
        Sim.params.lambda = 0;
      } else {
        document.getElementById('wavelength').disabled = false;
        const slider = document.getElementById('wavelength');
        slider.value = pDef.defaultLambda;
        Sim.params.lambda = pDef.defaultLambda;
      }
      Sim.dirty = true;
      this.updateAllDisplays();
    });

    // Range inputs
    const ranges = [
      ['wavelength', v => { Sim.params.lambda    = +v; Sim.dirty = true; }],
      ['numSlits',   v => { Sim.params.numSlits  = +v; Sim.dirty = true; }],
      ['slitWidth',  v => { Sim.params.slitWidth = +v; Sim.dirty = true; }],
      ['slitSep',    v => { Sim.params.slitSep   = +v; Sim.dirty = true; }],
      ['sourceDist', v => { Sim.params.sourceFrac = 0.12 + (+v / 100) * 0.28; }],
      ['screenDist', v => { Sim.params.screenFrac = 0.18 + (+v / 100) * 0.38; Sim.dirty = true; }],
      ['simSpeed',   v => { Sim.params.speed   = +v; }],
      ['simDensity', v => { Sim.params.density = +v; }],
    ];
    for (const [id, fn] of ranges) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.addEventListener('input', e => {
        fn(e.target.value);
        this.updateAllDisplays();
        if (!Sim.running) Sim.render();
      });
    }

    // Sequential mode checkbox
    document.getElementById('sequentialMode').addEventListener('change', e => {
      Sim.params.sequential = e.target.checked;
      const densitySlider = document.getElementById('simDensity');
      densitySlider.disabled = e.target.checked;
      this.updateAllDisplays();
    });

    // Overlay checkboxes – just re-render
    ['showGradient', 'showGraph'].forEach(id => {
      document.getElementById(id)?.addEventListener('change', () => {
        if (!Sim.running) Sim.render();
      });
    });
  },

  _updatePlayBtn() {
    const btn = document.getElementById('btnPlay');
    btn.textContent = Sim.running ? I18N.t('pause') : I18N.t('play');
  },

  updateAllDisplays() {
    const pt   = Sim.params.particleType;
    const lang = I18N._lang;
    const units = I18N.t(`units.${pt}`);

    // Wavelength
    const lambdaEl = document.getElementById('wavelength');
    const pDef = PARTICLES[pt];
    if (pDef && pDef.classical) {
      document.getElementById('wavelengthVal').textContent = I18N.t('labels.classical');
    } else {
      const v = lambdaEl ? +lambdaEl.value : Sim.params.lambda;
      document.getElementById('wavelengthVal').textContent = `${v} ${units.lambda || 'nm'}`;
    }

    // numSlits
    const ns = document.getElementById('numSlits');
    if (ns) document.getElementById('numSlitsVal').textContent = ns.value;

    // slitWidth
    const sw = document.getElementById('slitWidth');
    if (sw) document.getElementById('slitWidthVal').textContent = `${sw.value} ${units.a || 'nm'}`;

    // slitSep
    const ss = document.getElementById('slitSep');
    if (ss) document.getElementById('slitSepVal').textContent = `${ss.value} ${units.d || 'nm'}`;

    // distances
    const sd = document.getElementById('sourceDist');
    if (sd) document.getElementById('sourceDistVal').textContent = `${sd.value} ${units.L1 || 'mm'}`;

    const scr = document.getElementById('screenDist');
    if (scr) document.getElementById('screenDistVal').textContent = `${scr.value} ${units.L2 || 'mm'}`;

    // speed
    const sp = document.getElementById('simSpeed');
    if (sp) document.getElementById('simSpeedVal').textContent = sp.value;

    // density
    const den = document.getElementById('simDensity');
    if (den) document.getElementById('simDensityVal').textContent = den.value;

    // Info bar
    const infoEl = document.getElementById('particleInfo');
    if (infoEl) {
      const icon = pDef ? pDef.icon : '';
      const name = I18N.t(`particleTypes.${pt}`);
      infoEl.innerHTML = `<span class="info-particle">${icon} ${name}</span> — ${I18N.t(`info.${pt}`)}`;
    }

    this.updateParticleCount();
    this._updatePlayBtn();
  },

  updateParticleCount() {
    const el = document.getElementById('particle-count');
    if (el) el.textContent = `${I18N.t('particles')}: ${Sim.hitCount.toLocaleString()}`;
  },
};

// Boot
window.addEventListener('DOMContentLoaded', () => App.init());
