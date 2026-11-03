// Ambient sounds, generated on the device so they work offline.
let ctx, master, current, birdTimer;

function noiseBuffer(kind, seconds = 6) {
  const length = ctx.sampleRate * seconds;
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buffer.getChannelData(c);
    let last = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      if (kind === 'brown') { last = (last + 0.02 * white) / 1.02; d[i] = last * 3.5; }
      else d[i] = white;
    }
    // Crossfade the ends so the loop has no click.
    const fade = Math.floor(ctx.sampleRate * 0.25);
    for (let i = 0; i < fade; i++) {
      const t = i / fade;
      d[i] = d[i] * t + d[length - fade + i] * (1 - t);
    }
  }
  return buffer;
}

function loopNoise(kind, type, frequency, gain, q = 0.7) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(kind);
  src.loop = true;
  src.loopEnd = src.buffer.duration - 0.25;
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = frequency;
  filter.Q.value = q;
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(filter).connect(g).connect(current.bus);
  src.start();
  current.nodes.push(src);
  return g;
}

function slowWave(param, depth, rate) {
  const lfo = ctx.createOscillator();
  lfo.frequency.value = rate;
  const g = ctx.createGain();
  g.gain.value = depth;
  lfo.connect(g).connect(param);
  lfo.start();
  current.nodes.push(lfo);
}

function chirp() {
  if (!current) return;
  const t0 = ctx.currentTime + 0.02;
  const base = 2200 + Math.random() * 2400;
  const notes = 2 + Math.floor(Math.random() * 5);
  const pan = ctx.createStereoPanner();
  pan.pan.value = Math.random() * 1.6 - 0.8;
  pan.connect(current.bus);
  for (let n = 0; n < notes; n++) {
    const start = t0 + n * (0.1 + Math.random() * 0.05);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.setValueAtTime(base * (1 + Math.random() * 0.2), start);
    osc.frequency.exponentialRampToValueAtTime(base * (0.75 + Math.random() * 0.6), start + 0.08);
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(0.05, start + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0004, start + 0.09);
    osc.connect(g).connect(pan);
    osc.start(start);
    osc.stop(start + 0.11);
  }
}

function crackle() {
  if (!current) return;
  const src = ctx.createBufferSource();
  const len = Math.floor(ctx.sampleRate * 0.03);
  const b = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 4;
  src.buffer = b;
  const g = ctx.createGain();
  g.gain.value = 0.05 + Math.random() * 0.22;
  const f = ctx.createBiquadFilter();
  f.type = 'highpass';
  f.frequency.value = 900 + Math.random() * 2400;
  src.connect(f).connect(g).connect(current.bus);
  src.start();
}

const SCENES = {
  rain() {
    loopNoise('white', 'highpass', 900, 0.1);
    loopNoise('white', 'bandpass', 3800, 0.09, 0.5);
    const low = loopNoise('brown', 'lowpass', 500, 0.3);
    slowWave(low.gain, 0.06, 0.07);
  },
  fireplace() {
    const low = loopNoise('brown', 'lowpass', 420, 0.5);
    slowWave(low.gain, 0.1, 0.23);
    loopNoise('white', 'bandpass', 1400, 0.008, 0.6);
    const pop = () => {
      crackle();
      birdTimer = setTimeout(pop, 40 + Math.random() ** 2 * 900);
    };
    pop();
  },
  birdsong() {
    loopNoise('brown', 'lowpass', 700, 0.09);
    const sing = () => {
      chirp();
      birdTimer = setTimeout(sing, 900 + Math.random() * 3600);
    };
    sing();
  },
  ocean() {
    const low = loopNoise('brown', 'lowpass', 700, 0.5);
    slowWave(low.gain, 0.32, 0.09);
    const hi = loopNoise('white', 'bandpass', 2000, 0.03, 0.4);
    slowWave(hi.gain, 0.025, 0.09);
  },
  brown() {
    loopNoise('brown', 'lowpass', 900, 0.55);
  },
};

export const SOUND_OPTIONS = [
  ['off', 'Off'], ['rain', 'Rain'], ['fireplace', 'Fireplace'],
  ['birdsong', 'Birdsong'], ['ocean', 'Ocean'], ['brown', 'Brown noise'],
];

// Must first be called from a tap, because iOS blocks audio until then.
export function unlockAudio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.connect(ctx.destination);
    // Asks iOS to treat this as playback, so the silent switch may not mute it.
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
  }
  if (ctx.state !== 'running') ctx.resume().catch(() => {});
}

export function stopSound() {
  clearTimeout(birdTimer);
  if (!current) return;
  const old = current;
  current = null;
  const end = ctx.currentTime + 0.5;
  old.bus.gain.cancelScheduledValues(ctx.currentTime);
  old.bus.gain.setValueAtTime(old.bus.gain.value, ctx.currentTime);
  old.bus.gain.linearRampToValueAtTime(0, end);
  setTimeout(() => {
    old.nodes.forEach(n => { try { n.stop(); } catch {} });
    old.bus.disconnect();
  }, 600);
}

export function playSound(name, volume) {
  unlockAudio();
  if (!ctx) return;
  setVolume(volume);
  if (current?.name === name) return;
  stopSound();
  if (name === 'off' || !SCENES[name]) return;
  const bus = ctx.createGain();
  bus.gain.setValueAtTime(0, ctx.currentTime);
  bus.gain.linearRampToValueAtTime(1, ctx.currentTime + 0.8);
  bus.connect(master);
  current = { name, bus, nodes: [] };
  SCENES[name]();
}

export function setVolume(volume) {
  if (master) master.gain.value = volume;
}

export const soundState = () => ({ running: ctx?.state === 'running', playing: current?.name || 'off' });
