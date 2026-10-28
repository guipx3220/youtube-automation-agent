// Generates one narration clip per script segment with Gemini TTS.
// Usage: node motion-studio/tts.mjs <project-dir>
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const { GoogleGenAI } = require('@google/genai');

const projectDir = path.resolve(process.argv[2] || 'motion-studio/projects/trailers');
const script = JSON.parse(fs.readFileSync(path.join(projectDir, 'script.json'), 'utf8'));
const credentials = JSON.parse(fs.readFileSync(path.resolve('config/credentials.json'), 'utf8'));
const apiKey = credentials.gemini?.apiKey || process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error('No Gemini API key in config/credentials.json or GEMINI_API_KEY');

const model = process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-tts';
const ai = new GoogleGenAI({ apiKey });
const outDir = path.join(projectDir, 'out', 'narration');
fs.mkdirSync(outDir, { recursive: true });

async function synthesize(text) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: [{ parts: [{ text }] }],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: script.voice || 'Kore' } } }
        }
      });
      const data = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!data) throw new Error('Gemini TTS returned no audio');
      return Buffer.from(data, 'base64');
    } catch (error) {
      const wait = 5000 * attempt;
      console.log(`  attempt ${attempt} failed (${String(error.message).slice(0, 120)}); retrying in ${wait / 1000}s`);
      await new Promise(resolve => setTimeout(resolve, wait));
    }
  }
  throw new Error('Gemini TTS failed after 6 attempts');
}

for (const [index, segment] of script.segments.entries()) {
  const wavPath = path.join(outDir, `${String(index).padStart(2, '0')}-${segment.id}.wav`);
  const textPath = wavPath.replace(/\.wav$/, '.txt');
  if (fs.existsSync(wavPath) && fs.existsSync(textPath) && fs.readFileSync(textPath, 'utf8') === segment.text) {
    console.log(`= ${segment.id} (cached)`);
    continue;
  }
  console.log(`> ${segment.id}`);
  const pcm = await synthesize(segment.text);
  const pcmPath = wavPath + '.pcm';
  fs.writeFileSync(pcmPath, pcm);
  // Trim leading/trailing silence so cue timing maps onto the spoken words.
  execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', pcmPath,
    '-af', 'silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse',
    '-ar', '48000', wavPath]);
  fs.unlinkSync(pcmPath);
  fs.writeFileSync(textPath, segment.text);
}
console.log('narration ready:', outDir);
