// Ambient sounds: built-in ones are generated on the device, and your own files loop in place of them.
let ctx, master, current, birdTimer;
let trackLoader, trackFailed, cachedTrack;
const TARGET_RMS = 0.1;
const MAX_DECODED_BYTES = 200 * 1048576;

// The app supplies how to read an uploaded track: id => Promise<{ data, norm, level }>.
export function setTrackSource(loader, onFail) {
  trackLoader = loader;
  trackFailed = onFail;
}

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

const decode = data => new Promise((resolve, reject) => {
  // Older iOS only takes callbacks, newer returns a promise too, so the extra one must not go unhandled.
  const result = ctx.decodeAudioData(data, resolve, reject);
  result?.catch?.(() => {});
});

// Reads a new file once to find its length and how loud it is, so tracks sit at a similar level.
export async function analyzeTrack(data) {
  unlockAudio();
  if (!ctx) throw new Error('no audio');
  const buffer = await decode(data.slice(0));
  const decodedBytes = buffer.length * buffer.numberOfChannels * 4;
  if (decodedBytes > MAX_DECODED_BYTES) return { tooLong: true, duration: buffer.duration, decodedBytes, maxSeconds: buffer.duration * MAX_DECODED_BYTES / decodedBytes };
  let sum = 0; let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const v = d[i];
      sum += v * v;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
    }
  }
  const rms = Math.sqrt(sum / (buffer.length * buffer.numberOfChannels)) || 0.0001;
  const norm = Math.min(Math.max(TARGET_RMS / rms, 0.25), 4, peak ? 0.95 / peak : 4);
  return { duration: buffer.duration, norm, decodedBytes };
}

// Blends the end of the file into its start, so the loop has no gap or click.
function loopable(buffer) {
  const rate = buffer.sampleRate;
  const length = buffer.length;
  const fade = buffer.duration < 1 ? 0 : Math.min(Math.floor(rate * 1.5), Math.floor(length * 0.2));
  if (!fade) return { buffer, loopEnd: buffer.duration };
  const out = ctx.createBuffer(buffer.numberOfChannels, length, rate);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const src = buffer.getChannelData(c);
    const d = out.getChannelData(c);
    d.set(src);
    for (let i = 0; i < fade; i++) {
      const t = (i / fade) * Math.PI / 2;
      d[i] = src[i] * Math.sin(t) + src[length - fade + i] * Math.cos(t);
    }
  }
  return { buffer: out, loopEnd: (length - fade) / rate };
}

async function startTrack(mine, id) {
  try {
    const record = await trackLoader(id);
    if (current !== mine) return;
    if (cachedTrack?.id !== id) {
      cachedTrack = null;
      const looped = loopable(await decode(record.data.slice(0)));
      cachedTrack = { id, ...looped };
    }
    if (current !== mine) return;
    const src = ctx.createBufferSource();
    src.buffer = cachedTrack.buffer;
    src.loop = true;
    src.loopEnd = cachedTrack.loopEnd;
    const trim = ctx.createGain();
    mine.norm = record.norm;
    mine.level = record.level;
    trim.gain.value = mine.norm * mine.level;
    mine.trim = trim;
    src.connect(trim).connect(mine.bus);
    src.start();
    mine.nodes.push(src);
  } catch (error) {
    console.error(error);
    if (current === mine) {
      current = null;
      mine.bus.disconnect();
    }
    trackFailed?.(id);
  }
}

// Forgets the decoded copy of a removed track.
export function dropTrack(id) {
  if (cachedTrack?.id === id) cachedTrack = null;
}

// Changes how loud one of your tracks plays, on top of the matching done when it was added.
export function setTrackLevel(name, level) {
  if (current?.name !== name || !current.trim) return;
  current.level = level;
  current.trim.gain.value = current.norm * level;
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
  const custom = name.startsWith('c:');
  if (name === 'off' || (!custom && !SCENES[name]) || (custom && !trackLoader)) return;
  const bus = ctx.createGain();
  bus.gain.setValueAtTime(0, ctx.currentTime);
  bus.gain.linearRampToValueAtTime(1, ctx.currentTime + 0.8);
  bus.connect(master);
  current = { name, bus, nodes: [] };
  if (custom) startTrack(current, name.slice(2));
  else SCENES[name]();
}

export function setVolume(volume) {
  if (master) master.gain.value = volume;
}

export const soundState = () => ({ running: ctx?.state === 'running', playing: current?.name || 'off' });
