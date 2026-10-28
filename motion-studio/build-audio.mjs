// Builds the sound for a film: places narration on the beat grid, synthesizes
// the score and SFX in code, measures the beat grid from the rendered score
// (beats.json), and mixes everything to -14 LUFS.
// Usage: node motion-studio/build-audio.mjs <project-dir>
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { mulberry32 } from './lib/noise.mjs';

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');

const projectDir = path.resolve(process.argv[2] || 'motion-studio/projects/trailers');
const outDir = path.join(projectDir, 'out');
const script = JSON.parse(fs.readFileSync(path.join(projectDir, 'script.json'), 'utf8'));
const SR = 48000;
const BEAT = 60 / script.bpm;
const BAR = BEAT * 4;

// ── WAV helpers ──────────────────────────────────────────────────────────
function readWavMono(file) {
  const buf = fs.readFileSync(file);
  let offset = 12;
  let channels = 1;
  while (offset < buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ') channels = buf.readUInt16LE(offset + 10);
    if (id === 'data') {
      const frames = size / 2 / channels;
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) out[i] = buf.readInt16LE(offset + 8 + i * 2 * channels) / 32768;
      return out;
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error(`No data chunk in ${file}`);
}

function writeWavStereo(file, left, right) {
  const frames = left.length;
  const buf = Buffer.alloc(44 + frames * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + frames * 4, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, left[i])) * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, right[i])) * 32767), 46 + i * 4);
  }
  fs.writeFileSync(file, buf);
}

// ── 1. Narration placement on the beat grid ──────────────────────────────
const narrationDir = path.join(outDir, 'narration');
const clips = script.segments.map((segment, index) => {
  const file = path.join(narrationDir, `${String(index).padStart(2, '0')}-${segment.id}.wav`);
  const samples = readWavMono(file);
  return { segment, file, samples, duration: samples.length / SR };
});

const firstBeat = 1; // hook voice enters on beat 1 (0.6s); picture starts moving at t=0
let cursor = 0;
const placed = clips.map((clip, index) => {
  const earliest = index === 0 ? firstBeat * BEAT : cursor + 0.35;
  const start = Math.ceil(earliest / BEAT - 1e-6) * BEAT;
  cursor = start + clip.duration;
  return { ...clip, start, end: cursor };
});
const outroBeats = 6;
const duration = Math.ceil(cursor / BEAT) * BEAT + outroBeats * BEAT;
const N = Math.ceil(duration * SR);

// ── 2. Score ─────────────────────────────────────────────────────────────
const rand = mulberry32(1913);
const note = midi => 440 * Math.pow(2, (midi - 69) / 12);
const chords = [ // A minor: i – VI – III – VII
  { root: 45, tones: [57, 60, 64] },
  { root: 41, tones: [57, 60, 65] },
  { root: 48, tones: [55, 60, 64] },
  { root: 43, tones: [55, 59, 62] }
];
const musicL = new Float32Array(N);
const musicR = new Float32Array(N);
const add = (buf, i, v) => { if (i >= 0 && i < N) buf[i] += v; };

// Pad: a few detuned additive voices, slow swell per bar.
for (let bar = 0; bar * BAR < duration; bar++) {
  const chord = chords[bar % chords.length];
  const startS = Math.floor(bar * BAR * SR);
  const len = Math.floor(BAR * SR * 1.15);
  for (const tone of chord.tones) {
    for (const [detune, pan] of [[-0.06, 0.25], [0.06, 0.75]]) {
      const f = note(tone + detune);
      for (let j = 0; j < len; j++) {
        const t = j / SR;
        const env = Math.min(1, t / 0.6) * Math.min(1, (len / SR - t) / 0.5);
        const v = (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t) + 0.12 * Math.sin(6 * Math.PI * f * t)) * env * 0.018;
        add(musicL, startS + j, v * (1 - pan)); add(musicR, startS + j, v * pan);
      }
    }
  }
}

// Kick on every beat, bass pulse on 8ths, off-beat hats, seeded pluck arpeggio.
const totalBeats = Math.round(duration / BEAT);
for (let b = 0; b < totalBeats - 2; b++) {
  const t0 = b * BEAT;
  const s0 = Math.floor(t0 * SR);
  const chord = chords[Math.floor(b / 4) % chords.length];
  // kick
  let phase = 0;
  for (let j = 0; j < SR * 0.32; j++) {
    const t = j / SR;
    const f = 45 + 85 * Math.exp(-t * 28);
    phase += 2 * Math.PI * f / SR;
    const v = Math.sin(phase) * Math.exp(-t * 9) * 0.55;
    add(musicL, s0 + j, v); add(musicR, s0 + j, v);
  }
  // bass 8th pulses
  for (const half of [0, 0.5]) {
    const sb = Math.floor((t0 + half * BEAT) * SR);
    const f = note(chord.root);
    for (let j = 0; j < SR * BEAT * 0.45; j++) {
      const t = j / SR;
      const v = (Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(4 * Math.PI * f * t)) * Math.exp(-t * 6) * 0.16;
      add(musicL, sb + j, v); add(musicR, sb + j, v);
    }
  }
  // hats on the off-beat
  const sh = Math.floor((t0 + BEAT / 2) * SR);
  let prev = 0;
  for (let j = 0; j < SR * 0.04; j++) {
    const white = rand() * 2 - 1;
    const hp = white - prev; prev = white;
    const v = hp * Math.exp(-(j / SR) * 90) * 0.06;
    add(musicL, sh + j, v * 0.8); add(musicR, sh + j, v * 1.2);
  }
  // pluck arpeggio, 8ths, seeded choice of chord tone
  for (const half of [0, 0.5]) {
    if (rand() < 0.25) continue;
    const tone = chord.tones[Math.floor(rand() * chord.tones.length)] + 12;
    const f = note(tone);
    const sp = Math.floor((t0 + half * BEAT) * SR);
    const pan = 0.3 + rand() * 0.4;
    for (let j = 0; j < SR * 0.5; j++) {
      const t = j / SR;
      const v = (Math.sin(2 * Math.PI * f * t) + 0.4 * Math.sin(4 * Math.PI * f * t) * Math.exp(-t * 12)) * Math.exp(-t * 7) * 0.035;
      add(musicL, sp + j, v * (1 - pan)); add(musicR, sp + j, v * pan);
    }
  }
}
fs.mkdirSync(outDir, { recursive: true });
const musicPath = path.join(outDir, 'music.wav');
writeWavStereo(musicPath, musicL, musicR);

// ── 3. Measure the beat grid from the rendered score ─────────────────────
function measureBeats(left, right) {
  const hop = 256;
  // Low-pass (one-pole) to isolate the kick, then energy flux onsets.
  const a = Math.exp(-2 * Math.PI * 150 / SR);
  let y = 0;
  const frames = Math.floor(left.length / hop);
  const energy = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let j = 0; j < hop; j++) {
      const i = f * hop + j;
      y = (1 - a) * ((left[i] + right[i]) / 2) + a * y;
      e += y * y;
    }
    energy[f] = e;
  }
  const flux = energy.map((e, f) => Math.max(0, e - (f ? energy[f - 1] : 0)));
  const max = Math.max(...flux);
  const beats = [];
  const minGap = Math.floor(0.3 * SR / hop);
  let last = -minGap;
  for (let f = 1; f < frames - 1; f++) {
    if (flux[f] > max * 0.2 && flux[f] >= flux[f - 1] && flux[f] >= flux[f + 1] && f - last >= minGap) {
      beats.push(+(f * hop / SR).toFixed(4));
      last = f;
    }
  }
  return beats;
}
const measured = measureBeats(musicL, musicR);
const intervals = measured.slice(1).map((t, i) => t - measured[i]).sort((x, y) => x - y);
const measuredBpm = 60 / intervals[Math.floor(intervals.length / 2)];
// The onset frame lands a few ms after the kick starts; align the grid to the
// measured phase so visuals hit where the ear hears the kick.
const phase = measured.reduce((sum, t) => sum + (t - Math.round(t / BEAT) * BEAT), 0) / measured.length;
const beats = Array.from({ length: totalBeats + 1 }, (_, b) => +(b * BEAT + phase).toFixed(4));
fs.writeFileSync(path.join(outDir, 'beats.json'), JSON.stringify({
  bpm: +measuredBpm.toFixed(2), phase: +phase.toFixed(4), measuredOnsets: measured.length, beats
}, null, 2));
const snap = t => beats.reduce((best, b) => Math.abs(b - t) < Math.abs(best - t) ? b : best, beats[0]);

// ── 4. Cues: map words in the narration to beat-snapped times ────────────
const scenes = placed.map((clip, index) => {
  const text = clip.segment.text;
  const cues = {};
  const derived = [];
  for (const [name, raw] of Object.entries(clip.segment.cues || {})) {
    if (typeof raw === 'object') { derived.push([name, raw]); continue; }
    const last = raw.endsWith('$');
    const needle = last ? raw.slice(0, -1) : raw;
    const at = last ? text.lastIndexOf(needle) : text.indexOf(needle);
    if (at < 0) throw new Error(`Cue "${needle}" not found in segment ${clip.segment.id}`);
    let t = snap(clip.start + clip.duration * (at / text.length));
    if (t < clip.start) t = clip.start;
    cues[name] = +t.toFixed(4);
  }
  const sceneStart = index === 0 ? 0 : snap(clip.start);
  for (const [name, rule] of derived) {
    const base = rule.at === 'start' ? sceneStart : cues[rule.at];
    if (base === undefined) throw new Error(`Cue ${name} depends on unknown cue ${rule.at}`);
    cues[name] = +snap(base + (rule.beats || 0) * BEAT).toFixed(4);
  }
  const next = placed[index + 1];
  return {
    id: clip.segment.id,
    start: +sceneStart.toFixed(4),
    end: +(next ? snap(next.start) : duration).toFixed(4),
    voiceStart: +clip.start.toFixed(4),
    voiceEnd: +clip.end.toFixed(4),
    cues
  };
});

// ── 5. SFX, synthesized and placed on the measured grid ──────────────────
const sfxL = new Float32Array(N);
const sfxR = new Float32Array(N);
const srand = mulberry32(1960);
const addS = (i, l, r) => { if (i >= 0 && i < N) { sfxL[i] += l; sfxR[i] += r; } };
const sfx = {
  whoosh(t) { // band-limited noise swelling into the beat
    const len = 0.45 * SR; const s0 = Math.floor((t - 0.4) * SR);
    let lp = 0, prev = 0;
    for (let j = 0; j < len; j++) {
      const x = j / len;
      const cutoff = 0.02 + 0.25 * x * x;
      const w = srand() * 2 - 1; lp += cutoff * (w - lp);
      const bp = lp - prev; prev = lp;
      const env = Math.pow(x, 2.2) * (x > 0.9 ? (1 - x) * 10 : 1);
      addS(s0 + j, bp * env * 0.9 * (1 - x * 0.6), bp * env * 0.9 * (0.4 + x * 0.6));
    }
  },
  hit(t) { // low thud + paper slap
    const s0 = Math.floor(t * SR); let ph = 0;
    for (let j = 0; j < 0.5 * SR; j++) {
      const tt = j / SR; ph += 2 * Math.PI * (38 + 60 * Math.exp(-tt * 20)) / SR;
      const v = Math.sin(ph) * Math.exp(-tt * 6) * 0.6 + (srand() * 2 - 1) * Math.exp(-tt * 60) * 0.25;
      addS(s0 + j, v, v);
    }
  },
  pop(t) {
    const s0 = Math.floor(t * SR);
    for (let j = 0; j < 0.08 * SR; j++) {
      const tt = j / SR; const v = Math.sin(2 * Math.PI * (900 - 2500 * tt) * tt) * Math.exp(-tt * 45) * 0.25;
      addS(s0 + j, v, v);
    }
  },
  marker(t) { // highlighter swipe: filtered noise with a rising edge
    const len = 0.3 * SR; const s0 = Math.floor(t * SR); let lp = 0;
    for (let j = 0; j < len; j++) {
      const x = j / len; lp += 0.35 * ((srand() * 2 - 1) - lp);
      const v = lp * Math.sin(Math.PI * x) * 0.22; addS(s0 + j, v * 0.7, v);
    }
  },
  type(t, count = 10) {
    for (let k = 0; k < count; k++) {
      const s0 = Math.floor((t + k * BEAT / 4) * SR);
      for (let j = 0; j < 0.025 * SR; j++) {
        const tt = j / SR; const v = (srand() * 2 - 1) * Math.exp(-tt * 220) * 0.3 + Math.sin(2 * Math.PI * 1800 * tt) * Math.exp(-tt * 300) * 0.15;
        addS(s0 + j, v, v);
      }
    }
  },
  tear(t) {
    const len = 0.42 * SR; const s0 = Math.floor(t * SR);
    for (let j = 0; j < len; j++) {
      const x = j / len; const burst = srand() < 0.08 ? 1 : 0.25;
      const v = (srand() * 2 - 1) * burst * (1 - x) * 0.35; addS(s0 + j, v, v * 0.8);
    }
  },
  stamp(t) { sfx.hit(t); sfx.pop(t + 0.01); }
};

const sfxEvents = [];
for (const [index, scene] of scenes.entries()) {
  if (index > 0) { sfx.whoosh(scene.start); sfxEvents.push({ t: scene.start, kind: 'whoosh' }); }
  for (const [cue, kind] of Object.entries(script.segments[index].sfx || {})) {
    if (scene.cues[cue] === undefined) continue;
    sfx[kind](scene.cues[cue]);
    sfxEvents.push({ t: scene.cues[cue], kind, cue: `${scene.id}.${cue}` });
  }
}
sfx.hit(0); sfxEvents.push({ t: 0, kind: 'hit', cue: 'open' });
const sfxPath = path.join(outDir, 'sfx.wav');
writeWavStereo(sfxPath, sfxL, sfxR);

// ── 6. Narration bus ──────────────────────────────────────────────────────
const voice = new Float32Array(N);
for (const clip of placed) {
  const s0 = Math.floor(clip.start * SR);
  for (let j = 0; j < clip.samples.length; j++) if (s0 + j < N) voice[s0 + j] += clip.samples[j];
}
const voicePath = path.join(outDir, 'voice.wav');
writeWavStereo(voicePath, voice, voice);

// ── 7. Mix: duck the score under the voice, then normalize to -14 LUFS ───
const premix = path.join(outDir, 'premix.wav');
execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', voicePath, '-i', musicPath, '-i', sfxPath, '-filter_complex',
  '[0:a]asplit=2[v][key];' +
  '[1:a][key]sidechaincompress=threshold=0.03:ratio=6:attack=15:release=350[duck];' +
  '[v]highpass=f=80,acompressor=threshold=0.1:ratio=3:attack=5:release=120,volume=1.0[vc];' +
  '[duck]volume=0.85[m];[2:a]volume=0.8[s];' +
  '[vc][m][s]amix=inputs=3:normalize=0[out]', '-map', '[out]', '-ar', String(SR), premix]);

const analysis = spawnSync(ffmpeg, ['-hide_banner', '-i', premix, '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'], { encoding: 'utf8' });
const report = analysis.stderr;
const stats = JSON.parse(report.slice(report.lastIndexOf('{'), report.lastIndexOf('}') + 1));
const mixPath = path.join(outDir, 'mix.wav');
execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', premix, '-af',
  `loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=${stats.input_i}:measured_TP=${stats.input_tp}:measured_LRA=${stats.input_lra}:measured_thresh=${stats.input_thresh}:offset=${stats.target_offset}:linear=true`,
  '-ar', String(SR), mixPath]);

fs.writeFileSync(path.join(outDir, 'timeline.json'), JSON.stringify({
  title: script.title, fps: script.fps, width: script.width, height: script.height,
  duration: +duration.toFixed(4), beat: BEAT, beats, scenes, sfx: sfxEvents
}, null, 2));
console.log(`duration ${duration.toFixed(2)}s · ${scenes.length} scenes · measured ${measured.length} onsets @ ${measuredBpm.toFixed(2)} bpm (phase ${(phase * 1000).toFixed(1)} ms)`);
