// Renders a film by calling window.seek(t) for every frame.
//   node motion-studio/render.mjs <project-dir>                 full render → out/film.mp4
//   node motion-studio/render.mjs <project-dir> --contact       one frame per beat → out/contact-*.png
//   node motion-studio/render.mjs <project-dir> --at 4.2,7.5    single frames → out/frame-<t>.png
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const { chromium } = require('playwright');

const root = path.dirname(new URL(import.meta.url).pathname);
const projectDir = path.resolve(process.argv[2] || 'motion-studio/projects/trailers');
const outDir = path.join(projectDir, 'out');
const args = process.argv.slice(3);
const timeline = JSON.parse(fs.readFileSync(path.join(outDir, 'timeline.json'), 'utf8'));
const { fps, width, height, duration } = timeline;

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.woff2': 'font/woff2', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/player/index.html`;

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
async function openPage() {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  page.on('pageerror', error => { console.error('page error:', error.message); process.exitCode = 1; });
  await page.addInitScript(data => { window.__TIMELINE__ = data; }, timeline);
  await page.goto(url);
  await page.evaluate(() => window.filmReady);
  return page;
}
const page = await openPage();

async function frameAt(t, target = page) {
  await target.evaluate(time => window.seek(time), t);
  return target.screenshot({ type: 'png', clip: { x: 0, y: 0, width, height } });
}

try {
  if (args[0] === '--at') {
    for (const t of args[1].split(',').map(Number)) {
      const file = path.join(outDir, `frame-${t.toFixed(2)}.png`);
      fs.writeFileSync(file, await frameAt(t));
      console.log(file);
    }
  } else if (args[0] === '--contact') {
    // One frame per beat, sampled just after the hit lands, tiled 8×5 per sheet.
    const tileDir = path.join(outDir, 'contact-tiles');
    fs.rmSync(tileDir, { recursive: true, force: true });
    fs.mkdirSync(tileDir, { recursive: true });
    const beats = timeline.beats.filter(b => b < duration);
    for (const [i, b] of beats.entries()) {
      fs.writeFileSync(path.join(tileDir, `${String(i).padStart(4, '0')}.png`), await frameAt(Math.min(duration - 1 / fps, b + 0.25)));
    }
    const perSheet = 40;
    for (let s = 0; s * perSheet < beats.length; s++) {
      const file = path.join(outDir, `contact-${s + 1}.png`);
      execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-start_number', String(s * perSheet), '-i', path.join(tileDir, '%04d.png'),
        '-frames:v', '1', '-vf', 'scale=480:270,tile=8x5:padding=6:color=white',
        file]);
      console.log(file);
    }
  } else {
    // Frames are a pure function of time, so pages render disjoint frames in parallel.
    const total = Math.round(duration * fps);
    const workers = Number(process.env.RENDER_WORKERS || 3);
    const frameDir = path.join(outDir, 'frames');
    fs.rmSync(frameDir, { recursive: true, force: true });
    fs.mkdirSync(frameDir, { recursive: true });
    const pages = [page, ...(await Promise.all(Array.from({ length: workers - 1 }, openPage)))];
    const started = Date.now();
    let done = 0;
    await Promise.all(pages.map(async (p, w) => {
      for (let f = w; f < total; f += workers) {
        fs.writeFileSync(path.join(frameDir, `${String(f).padStart(5, '0')}.png`), await frameAt(f / fps, p));
        if (++done % 150 === 0) console.log(`frame ${done}/${total} · ${((Date.now() - started) / 1000).toFixed(0)}s`);
      }
    }));
    const output = path.join(outDir, 'film.mp4');
    execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(frameDir, '%05d.png'), '-i', path.join(outDir, 'mix.wav'),
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '256k',
      '-shortest', '-movflags', '+faststart', output]);
    console.log(output);
  }
} finally {
  await browser.close();
  server.close();
}
