// Vox-style explainer film. Pure function of time: window.seek(t) paints frame t.
// No transitions, timers or rAF; no state carried between frames; seeded noise only.
import { mulberry32, hash1 } from '../lib/noise.mjs';

const TL = window.__TIMELINE__;
const W = 1920;
const H = 1080;
const BEAT = TL.beat;

// ── math ────────────────────────────────────────────────────────────────
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const P = (t, a, d) => clamp((t - a) / d);
const lerp = (a, b, x) => a + (b - a) * x;
const E = {
  out: x => 1 - Math.pow(1 - x, 3),
  inOut: x => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  back: x => { const c1 = 1.9, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); },
  expo: x => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x))
};
const smoothNoise = (x, seed) => {
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  return lerp(hash1(i, seed), hash1(i + 1, seed), u) * 2 - 1;
};
// Decaying shake after an impact at time c.
const shake = (t, c, amp = 10) => (t < c ? 0 : Math.exp(-(t - c) * 9) * Math.sin((t - c) * 70) * amp);
const slam = (t, c, from = 1.7, d = 0.3) => lerp(from, 1, E.back(P(t, c, d)));

// ── DOM helpers ─────────────────────────────────────────────────────────
function h(tag, cls, parent, style = {}, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  Object.assign(el.style, style);
  if (text !== undefined) el.textContent = text;
  if (parent) parent.appendChild(el);
  return el;
}
const px = v => `${v}px`;
function tf(el, { x = 0, y = 0, s = 1, sx, sy, r = 0 } = {}) {
  el.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) rotate(${r.toFixed(3)}deg) scale(${(sx ?? s).toFixed(4)}, ${(sy ?? s).toFixed(4)})`;
}
const vis = (el, on) => { el.style.visibility = on ? 'visible' : 'hidden'; };
function wipe(el, p, dir = 'right') {
  const q = ((1 - clamp(p)) * 100).toFixed(3);
  el.style.clipPath = {
    right: `inset(-20% ${q}% -20% -2%)`,
    left: `inset(-20% -2% -20% ${q}%)`,
    up: `inset(${q}% -5% -5% -5%)`,
    down: `inset(-5% -5% ${q}% -5%)`
  }[dir];
}

// Text line built from parts; parts with an id get their own span for measuring.
function line(parent, parts, cls, x, y, size, extra = {}) {
  const el = h('div', `abs ${cls}`, parent, { left: px(x), top: px(y), fontSize: px(size), ...extra });
  const spans = {};
  for (const part of parts) {
    if (typeof part === 'string') el.appendChild(document.createTextNode(part));
    else spans[part.id] = h('span', '', el, {}, part.t);
  }
  return { el, spans };
}
// Highlighter bar behind a span (or whole line). Returns a setter p→paint.
function highlighter(lineObj, spanId, { top = 0.1, height = 0.82, pad = 14, skew = -4 } = {}) {
  const target = spanId ? lineObj.spans[spanId] : lineObj.el;
  const hl = h('div', 'hl', lineObj.el);
  const left = spanId ? target.offsetLeft : 0;
  const width = target.offsetWidth;
  const lineH = lineObj.el.offsetHeight;
  Object.assign(hl.style, { left: px(left - pad), top: px(lineH * top), width: px(width + pad * 2), height: px(lineH * height), zIndex: -1 });
  lineObj.el.style.isolation = 'isolate';
  return p => { hl.style.transform = `skewX(${skew}deg) scaleX(${E.out(clamp(p)).toFixed(4)})`; };
}
function striker(lineObj, spanId, thickness = 18) {
  const target = spanId ? lineObj.spans[spanId] : lineObj.el;
  const st = h('div', 'strike', lineObj.el);
  const lineH = lineObj.el.offsetHeight;
  Object.assign(st.style, { left: px((spanId ? target.offsetLeft : 0) - 10), top: px(lineH * 0.47 - thickness / 2), width: px(target.offsetWidth + 20), height: px(thickness) });
  return p => { st.style.transform = `rotate(-2deg) scaleX(${E.out(clamp(p)).toFixed(4)})`; };
}
// Typewriter text with an accent caret.
function typer(parent, text, x, y, size, extra = {}) {
  const el = h('div', 'abs ui', parent, { left: px(x), top: px(y), fontSize: px(size), ...extra });
  const shown = h('span', '', el);
  const caret = h('span', '', el, { display: 'inline-block', width: '0.55em', height: '0.95em', background: 'var(--accent)', verticalAlign: '-0.12em', marginLeft: '2px' });
  return (t, start, dur) => {
    const p = P(t, start, dur);
    shown.textContent = text.slice(0, Math.round(p * text.length));
    const blink = Math.floor((t - start) / (BEAT / 2)) % 2 === 0;
    caret.style.visibility = t >= start && (p < 1 || (blink && t < start + dur + BEAT * 4)) ? 'visible' : 'hidden';
    el.style.visibility = t >= start ? 'visible' : 'hidden';
  };
}
// Rolling odometer for numbers like "289.000.000".
function odometer(parent, template, x, y, size, color = 'var(--ink)') {
  const el = h('div', 'abs disp', parent, { left: px(x), top: px(y), fontSize: px(size), lineHeight: '1', color, display: 'flex' });
  const columns = [];
  const digitCount = template.replace(/\D/g, '').length;
  let k = digitCount - 1;
  for (const ch of template) {
    if (/\d/.test(ch)) {
      const col = h('div', '', el, { height: px(size), overflow: 'hidden', position: 'relative' });
      const strip = h('div', '', col, { display: 'flex', flexDirection: 'column' });
      for (const d of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0]) h('div', '', strip, { height: px(size), lineHeight: px(size) }, String(d));
      columns.push({ strip, place: k-- });
    } else {
      h('div', '', el, { height: px(size), lineHeight: px(size) }, ch);
    }
  }
  const update = value => {
    for (const { strip, place } of columns) {
      // Each wheel sits on its digit and only rolls while the wheel below wraps 9→0.
      const r = value / Math.pow(10, place);
      const digit = Math.floor(r) % 10;
      const below = place === 0 ? r - Math.floor(r) : (value % Math.pow(10, place)) / Math.pow(10, place);
      const pos = digit + (place === 0 ? below : clamp((below - 0.9) * 10));
      strip.style.transform = `translateY(${(-pos * size).toFixed(2)}px)`;
    }
  };
  update.el = el;
  return update;
}

// ── film ────────────────────────────────────────────────────────────────
const stage = document.getElementById('stage');
const scenes = TL.scenes.map((sc, index) => ({ ...sc, index }));
const byId = Object.fromEntries(scenes.map(s => [s.id, s]));
const C = id => byId[id].cues;

function sheet(index) {
  const el = h('div', `sheet${index ? ' edge' : ''}`, stage, { zIndex: String(index + 1) });
  const cam = h('div', 'cam', el);
  return { el, cam };
}

const builders = {
  hook(root) {
    const c = C('hook');
    const slab = h('div', 'abs', root, { left: '0px', top: '296px', width: '1720px', height: '310px', background: 'var(--accent)' });
    const counter = odometer(root, '289.000.000', 128, 326, 250);
    const ruler = h('div', 'abs', root, { left: '134px', top: '646px', width: '1080px', height: '36px' });
    h('div', 'abs', ruler, { left: '0px', top: '16px', width: '1080px', height: '6px', background: 'var(--ink)' });
    for (let i = 0; i <= 24; i++) h('div', 'abs', ruler, { left: px(i * 45 - 3), top: i % 6 === 0 ? '0px' : '8px', width: '6px', height: i % 6 === 0 ? '38px' : '22px', background: 'var(--ink)' });
    const rulerA = h('div', 'abs ui', root, { left: '134px', top: '694px', fontSize: '40px' }, '0H');
    const rulerB = h('div', 'abs ui', root, { left: '1140px', top: '694px', fontSize: '40px' }, '24H');
    const label = line(root, ['VISUALIZAÇÕES EM ', { id: 'h', t: '24 HORAS' }], 'ui', 134, 780, 62);
    const labelHl = highlighter(label, 'h');
    const group = [slab, counter.el, ruler, rulerA, rulerB, label.el];

    const film = h('div', 'abs card', root, { left: '1290px', top: '640px', width: '520px', height: '330px' });
    const strip = h('div', 'abs', film, { left: '40px', top: '40px', width: '440px', height: '150px', background: 'var(--ink)' });
    for (let i = 0; i < 9; i++) {
      h('div', 'abs', strip, { left: px(14 + i * 48), top: '12px', width: '26px', height: '18px', background: 'var(--card)', borderRadius: '3px' });
      h('div', 'abs', strip, { left: px(14 + i * 48), top: '120px', width: '26px', height: '18px', background: 'var(--card)', borderRadius: '3px' });
    }
    h('div', 'abs disp', film, { left: '40px', top: '218px', fontSize: '76px' }, 'UM FILME?');
    const xA = h('div', 'abs', film, { left: '25px', top: '148px', width: '470px', height: '34px', background: 'var(--ink)', transformOrigin: '50% 50%' });
    const xB = h('div', 'abs', film, { left: '25px', top: '148px', width: '470px', height: '34px', background: 'var(--ink)', transformOrigin: '50% 50%' });

    const trailer = line(root, ['UM ', { id: 'w', t: 'TRAILER.' }], 'disp', 128, 650, 240, { transformOrigin: '0 60%' });
    const trailerHl = highlighter(trailer, 'w', { top: 0.52, height: 0.4, pad: 18, skew: -6 });

    return (t, sc) => {
      const u = t - sc.start;
      wipe(slab, E.out(P(t, -0.2, 0.5)));
      counter(289e6 * E.out(P(t, -0.45, 2.0)));
      wipe(ruler, E.inOut(P(t, c.ruler, 0.6)));
      vis(rulerA, t >= c.ruler); vis(rulerB, t >= c.ruler + 0.45);
      wipe(label.el, E.out(P(t, c.label, 0.3)));
      labelHl(P(t, c.label + 0.25, 0.4));

      const lift = E.inOut(P(t, c.trailer - 0.15, 0.4));
      for (const el of group) el.style.translate = `0px ${(-lift * 250).toFixed(2)}px`;

      const filmIn = E.out(P(t, c.notFilm, 0.4));
      const filmOut = E.inOut(P(t, c.trailer - 0.1, 0.45));
      tf(film, { x: filmOut * 900, y: (1 - filmIn) * 700, r: lerp(9, 4, filmIn) });
      vis(film, t >= c.notFilm);
      tf(xA, { r: -30, sx: E.out(P(t, c.xmark, 0.18)), sy: 1 });
      tf(xB, { r: 30, sx: E.out(P(t, c.xmark + 0.12, 0.18)), sy: 1 });

      vis(trailer.el, t >= c.trailer);
      tf(trailer.el, { y: shake(t, c.trailer, 6), s: slam(t, c.trailer, 1.55, 0.32) });
      trailerHl(P(t, c.trailer + 0.3, 0.45));
      return { zoom: 1 + 0.035 * E.inOut(P(u, 0, sc.end - sc.start)), shake: shake(t, c.trailer, 8) };
    };
  },

  cinema(root) {
    const c = C('cinema');
    const room = h('div', 'abs', root, { left: '110px', top: '110px', width: '980px', height: '680px', border: '8px solid var(--ink)', borderRadius: '22px' });
    const screen = h('div', 'abs', root, { left: '200px', top: '160px', width: '800px', height: '30px', background: 'var(--ink)' });
    const screenLabel = h('div', 'abs ui', root, { left: '200px', top: '204px', fontSize: '40px' }, 'TELA');
    const seats = [];
    const order = Array.from({ length: 72 }, (_, i) => i);
    const rand = mulberry32(13);
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    const rank = new Array(72); order.forEach((seat, r) => { rank[seat] = r; });
    for (let r = 0; r < 6; r++) {
      for (let q = 0; q < 12; q++) {
        const i = r * 12 + q;
        const x = 210 + q * 66, y = 300 + r * 74;
        const ghost = h('div', 'abs', root, { left: px(x), top: px(y), width: '46px', height: '46px', border: '4px solid var(--grey)', borderRadius: '12px', transformOrigin: '50% 50%' });
        const person = h('div', 'abs', root, { left: px(x), top: px(y), width: '46px', height: '46px', background: 'var(--ink)', borderRadius: '12px', transformOrigin: '50% 50%' });
        seats.push({ ghost, person, r, i });
      }
    }
    const film = h('div', 'abs', root, { left: '110px', top: '850px', width: '1100px', height: '86px', background: 'var(--ink)' });
    h('div', 'abs ui', film, { left: '28px', top: '14px', fontSize: '50px', color: 'var(--card)' }, 'SESSÃO');
    const ads = h('div', 'abs', root, { left: '1222px', top: '850px', width: '588px', height: '86px', background: 'var(--accent)' });
    h('div', 'abs ui', ads, { left: '28px', top: '14px', fontSize: '50px' }, 'ANÚNCIOS');
    const head = h('div', 'abs', root, { left: '0px', top: '820px', width: '10px', height: '146px', background: 'var(--ink)' });
    const headTip = h('div', 'abs', root, { left: '0px', top: '800px', width: '0px', height: '0px', borderLeft: '22px solid transparent', borderRight: '22px solid transparent', borderTop: '30px solid var(--ink)' });
    const stamp = h('div', 'abs stamp disp', root, { left: '1230px', top: '170px', fontSize: '150px' }, 'c. 1913');
    const after = line(root, ['OS ANÚNCIOS\nVINHAM ', { id: 'd', t: 'DEPOIS' }, '\nDA SESSÃO.'], 'ui', 1240, 470, 58, { lineHeight: '1.3' });
    const afterHl = highlighter(after, 'd', { top: 0.37, height: 0.24 });
    const count = h('div', 'abs ui', root, { left: '600px', top: '200px', fontSize: '50px' });

    return (t, sc) => {
      const u = t - sc.start;
      wipe(room, E.out(P(t, sc.start - 0.1, 0.5)), 'down');
      wipe(screen, E.out(P(t, sc.start + 0.1, 0.4)));
      vis(screenLabel, t >= sc.start + 0.3);
      let present = 0;
      for (const seat of seats) {
        const pop = E.back(P(t, sc.start + 0.15 + seat.r * 0.07, 0.3));
        tf(seat.ghost, { s: pop });
        const leaveAt = c.leave + (rank[seat.i] / 72) * 2.6;
        const stays = rank[seat.i] >= 64;
        const gone = stays ? 0 : E.inOut(P(t, leaveAt, 0.22));
        tf(seat.person, { s: pop * (1 - gone), y: -gone * 30 });
        if (!stays && gone >= 1) continue;
        present++;
      }
      count.textContent = `${String(present).padStart(2, '0')}/72 NA SALA`;
      vis(count, t >= c.leave);
      wipe(film, E.out(P(t, sc.start + 0.3, 0.5)));
      wipe(ads, E.out(P(t, sc.start + 0.7, 0.4)));
      const headX = t < c.leave
        ? lerp(110, 1222, E.inOut(P(t, sc.start + 0.2, c.leave - sc.start - 0.2)))
        : lerp(1222, 1790, P(t, c.leave, sc.end - c.leave));
      tf(head, { x: headX - 5 }); tf(headTip, { x: headX - 22 });
      vis(head, t >= sc.start + 0.2); vis(headTip, t >= sc.start + 0.2);
      vis(stamp, t >= c.stamp);
      tf(stamp, { s: slam(t, c.stamp, 2.1, 0.22), r: -8 });
      stamp.style.transformOrigin = '50% 50%';
      wipe(after.el, E.out(P(t, c.after - BEAT, 0.5)), 'down');
      afterHl(P(t, c.after, 0.4));
      return { zoom: 1 + 0.03 * P(u, 0, sc.end - sc.start), shake: shake(t, c.stamp, 7) };
    };
  },

  word(root) {
    const c = C('word');
    const track = h('div', 'abs', root, { left: '0px', top: '560px', width: '1920px', height: '8px', background: 'var(--ink)' });
    const train = h('div', 'abs', root, { left: '0px', top: '340px', width: '1400px', height: '220px' });
    const boxB = h('div', 'abs', train, { left: '0px', top: '20px', width: '540px', height: '200px', background: 'var(--accent)' });
    h('div', 'abs disp', boxB, { left: '36px', top: '62px', fontSize: '84px' }, 'ANÚNCIO');
    const rope = h('div', 'abs', train, { left: '540px', top: '112px', width: '120px', height: '10px', background: 'var(--ink)' });
    const boxA = h('div', 'abs', train, { left: '660px', top: '0px', width: '640px', height: '220px', background: 'var(--ink)' });
    h('div', 'abs disp', boxA, { left: '40px', top: '60px', fontSize: '84px', color: 'var(--card)' }, 'FILME');
    h('div', 'abs ui', boxA, { left: '44px', top: '150px', fontSize: '32px', color: 'var(--accent)' }, 'PRINCIPAL');
    const caption = h('div', 'abs ui', root, { left: '150px', top: '610px', fontSize: '64px' }, '↑ VEM ATRÁS');

    const card = h('div', 'abs card', root, { left: '930px', top: '520px', width: '880px', height: '450px' });
    const cardRoot = h('div', 'abs', card, { left: '0px', top: '0px', width: '880px', height: '450px' });
    h('div', 'abs disp', cardRoot, { left: '56px', top: '46px', fontSize: '140px' }, 'trail');
    h('div', 'abs ui', cardRoot, { left: '470px', top: '96px', fontSize: '34px', color: 'var(--grey)' }, '[trêil] · verbo');
    h('div', 'abs', cardRoot, { left: '56px', top: '210px', width: '768px', height: '4px', background: 'var(--ink)' });
    line(cardRoot, ['1. seguir'], 'ui', 56, 248, 58);
    const def2 = line(cardRoot, ['2. ', { id: 'v', t: 'vir atrás' }], 'ui', 56, 336, 58);
    const def2Hl = highlighter(def2, 'v');

    const big = line(root, [{ id: 'a', t: 'TRAIL' }, { id: 'b', t: 'ER' }], 'disp', 130, 300, 330);
    const erHl = highlighter(big, 'b', { top: 0.08, height: 0.86, pad: 10, skew: -3 });
    const eq = line(root, ['TRAIL + ER = ', { id: 'q', t: 'O QUE VEM ATRÁS' }], 'ui', 140, 720, 60);
    const eqHl = highlighter(eq, 'q');

    return (t, sc) => {
      const u = t - sc.start;
      const out = E.inOut(P(t, c.merge - 0.25, 0.4));
      wipe(track, E.out(P(t, sc.start - 0.1, 0.6)));
      const trainIn = E.out(P(t, sc.start - 0.1, 0.8));
      const lift = E.inOut(P(t, c.card - 0.1, 0.45));
      tf(train, { x: lerp(-1500, 120, trainIn) + u * 26 - out * 1900, y: lerp(40, -180, lift), s: lerp(1.3, 1, lift) });
      track.style.translate = `${(-out * 1920).toFixed(1)}px ${lerp(40 + 0.3 * 220, -180, lift).toFixed(1)}px`;
      vis(caption, t >= c.caption && t < c.merge);
      tf(caption, { y: (1 - E.back(P(t, c.caption, 0.3))) * 40 + lerp(200, -180, lift), s: lerp(1.2, 1, lift) });
      wipe(caption, P(t, c.caption, 0.2), 'up');
      vis(card, t >= c.card - 0.05);
      tf(card, { y: (1 - E.out(P(t, c.card, 0.4))) * 700, x: -out * 1950, r: -2 });
      def2Hl(P(t, c.highlight, 0.45));
      vis(big.el, t >= c.merge);
      tf(big.el, { s: slam(t, c.merge, 1.5, 0.3), y: shake(t, c.merge, 6) + shake(t, c.er, 5) });
      big.el.style.transformOrigin = '0 60%';
      const er = big.spans.b;
      er.style.display = 'inline-block';
      er.style.transform = `translateX(${((1 - E.out(P(t, c.er, 0.3))) * 1300).toFixed(1)}px)`;
      vis(er, t >= c.er - 0.15);
      erHl(t >= c.er ? P(t, c.er + 0.1, 0.3) : 0);
      wipe(eq.el, E.out(P(t, c.eq, 0.35)));
      eqHl(P(t, c.eq + 0.35, 0.4));
      return { zoom: 1 + 0.04 * P(u, 0, sc.end - sc.start), shake: shake(t, c.merge, 8) };
    };
  },

  psycho(root) {
    const c = C('psycho');
    const year = h('div', 'abs disp', root, { left: '-40px', top: '90px', fontSize: '470px' }, '1960');
    const name = typer(root, 'ALFRED HITCHCOCK', 120, 620, 62);
    const title = typer(root, 'O TRAILER DE PSICOSE', 120, 300, 58);
    const watch = h('div', 'abs', root, { left: '120px', top: '400px', width: '520px', height: '170px', border: '8px solid var(--ink)', borderRadius: '20px' });
    const watchText = h('div', 'abs disp', watch, { left: '40px', top: '28px', fontSize: '110px' });
    const plus = h('div', 'abs', root, { left: '600px', top: '370px', width: '120px', height: '120px', background: 'var(--accent)', borderRadius: '60px' });
    h('div', 'abs disp', plus, { left: '30px', top: '10px', fontSize: '96px' }, '+');

    const svgWrap = h('div', 'abs', root, { left: '860px', top: '150px', width: '980px', height: '820px' });
    svgWrap.innerHTML = `
      <svg width="980" height="820" viewBox="0 0 980 820" xmlns="http://www.w3.org/2000/svg" style="overflow:visible">
        <g fill="none" stroke="#161412" stroke-width="7" stroke-linecap="round" stroke-linejoin="round">
          <path class="draw" d="M380 400 C 520 330, 700 290, 960 270"/>
          <path class="draw" d="M620 300 L620 130 L860 130 L860 288"/>
          <path class="draw" d="M600 132 L740 40 L880 132"/>
          <path class="draw" d="M660 170 h50 v50 h-50 z M770 170 h50 v50 h-50 z"/>
          <path class="draw" d="M640 320 L600 350 L580 380 L540 410 L520 440"/>
          <path class="draw" d="M40 470 L860 470 L860 690 L40 690 Z"/>
          <path class="draw" d="M190 470 L190 690 M300 470 L300 690 M410 470 L410 690 M520 470 L520 690 M630 470 L630 690 M745 470 L745 690"/>
        </g>
        <path class="route" d="M115 760 L115 610 L245 610 L245 760 L575 760 L575 600 L690 600 L690 440 L560 420 L610 330 L740 260" fill="none" stroke="#FFC929" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"/>
        <path class="route-ink" d="M115 760 L115 610 L245 610 L245 760 L575 760 L575 600 L690 600 L690 440 L560 420 L610 330 L740 260" fill="none" stroke="#161412" stroke-width="4" stroke-dasharray="2 16" stroke-linecap="round"/>
        <g font-family="UI" font-weight="600" font-size="34" fill="#161412" letter-spacing="1">
          <text class="lab" x="50" y="455">ESCRITÓRIO</text>
          <text class="lab" x="530" y="455">QUARTO 1</text>
          <text class="lab" x="640" y="115">A CASA</text>
        </g>
      </svg>`;
    const draws = [...svgWrap.querySelectorAll('.draw')].map(p => ({ p, len: p.getTotalLength() }));
    for (const d of draws) d.p.style.strokeDasharray = `${d.len} ${d.len}`;
    const route = svgWrap.querySelector('.route');
    const routeLen = route.getTotalLength();
    route.style.strokeDasharray = `${routeLen} ${routeLen}`;
    const routeInk = svgWrap.querySelector('.route-ink');
    const labs = [...svgWrap.querySelectorAll('.lab')];
    const dot = h('div', 'abs', root, { width: '44px', height: '44px', borderRadius: '22px', background: 'var(--ink)', border: '8px solid var(--accent)' });
    const tag = h('div', 'abs ui', root, { fontSize: '30px', background: 'var(--ink)', color: 'var(--card)', padding: '10px 18px' }, 'HITCHCOCK GUIA');
    const zero = h('div', 'abs stamp disp', root, { left: '900px', top: '560px', fontSize: '110px', background: 'var(--card)' }, '0 CENAS\nDO FILME');
    zero.style.whiteSpace = 'pre';
    zero.style.lineHeight = '0.95';

    return (t, sc) => {
      const u = t - sc.start;
      const shrink = E.inOut(P(t, c.plan - 0.3, 0.5));
      wipe(year, E.out(P(t, sc.start - 0.15, 0.45)));
      tf(year, { x: lerp(0, 160, shrink), y: lerp(0, -60, shrink), s: lerp(1, 0.36, shrink) });
      name(t, c.name, 1.2);
      title(t, c.plan, 1.4);
      vis(watch, t >= c.clock);
      tf(watch, { y: (1 - E.back(P(t, c.clock, 0.3))) * 60 });
      const minutes = 6 * E.inOut(P(t, c.clock + 0.1, 1.6));
      const mm = Math.floor(minutes), ss = Math.floor((minutes - mm) * 60);
      watchText.textContent = `0${mm}:${String(ss).padStart(2, '0')}`;
      vis(plus, t >= c.clock + 1.8);
      tf(plus, { s: slam(t, c.clock + 1.8, 0.2, 0.25) });
      plus.style.transformOrigin = '50% 50%';
      draws.forEach((d, i) => { d.p.style.strokeDashoffset = String(d.len * (1 - E.out(P(t, c.plan + i * 0.12, 0.7)))); });
      vis(svgWrap, t >= c.plan);
      const pr = E.inOut(P(t, c.tour, c.zero + BEAT - c.tour));
      route.style.strokeDashoffset = String(routeLen * (1 - pr));
      routeInk.style.visibility = t >= c.tour ? 'visible' : 'hidden';
      const pt = route.getPointAtLength(routeLen * pr);
      tf(dot, { x: 860 + pt.x - 22, y: 150 + pt.y - 22, s: E.back(P(t, c.tour, 0.25)) });
      dot.style.transformOrigin = '50% 50%';
      vis(dot, t >= c.tour);
      labs.forEach((lab, i) => { lab.style.visibility = t >= c.tour + i * 1.8 ? 'visible' : 'hidden'; });
      vis(tag, t >= c.guide && t < c.zero);
      tf(tag, { x: 860 + pt.x - tag.offsetWidth - 34, y: 150 + pt.y - 90 + (1 - E.out(P(t, c.guide, 0.25))) * 30 });
      vis(zero, t >= c.zero);
      tf(zero, { s: slam(t, c.zero, 2.0, 0.24), r: 6 });
      zero.style.transformOrigin = '50% 50%';
      return { zoom: 1 + 0.035 * P(u, 0, sc.end - sc.start), shake: shake(t, c.zero, 7) };
    };
  },

  jaws(root) {
    const c = C('jaws');
    const year = h('div', 'abs disp', root, { left: '90px', top: '110px', fontSize: '250px' }, '1975');
    const title = h('div', 'abs disp', root, { left: '100px', top: '380px', fontSize: '120px' }, 'TUBARÃO');
    const prime = line(root, [{ id: 'p', t: 'HORÁRIO NOBRE' }], 'disp', 100, 640, 92);
    const primeHl = highlighter(prime, 'p', { top: 0.5, height: 0.42 });
    const tvType = typer(root, 'COMERCIAIS EM\nMASSA NA TV', 104, 790, 50, { lineHeight: '1.25' });
    const area = { x: 1000, y: 140, w: 840, h: 720 };
    const grids = [[1, 1], [2, 2], [4, 4], [8, 6]].map(([cols, rows], gi) => {
      const g = h('div', 'abs', root, { left: px(area.x), top: px(area.y), width: px(area.w), height: px(area.h) });
      const gap = gi === 0 ? 0 : gi === 3 ? 10 : 18;
      const cw = (area.w - gap * (cols - 1)) / cols;
      const ch = Math.min((area.h - gap * (rows - 1)) / rows, cw * 0.78);
      const tvs = [];
      const rand = mulberry32(100 + gi);
      for (let r = 0; r < rows; r++) for (let q = 0; q < cols; q++) {
        const border = Math.max(3, 14 / Math.sqrt(cols));
        const tv = h('div', 'abs', g, { left: px(q * (cw + gap)), top: px(r * (ch + gap)), width: px(cw), height: px(ch), border: `${border}px solid var(--ink)`, borderRadius: px(border * 2.5), background: 'var(--card)', transformOrigin: '50% 50%' });
        const scr = h('div', 'abs', tv, { left: px(border), top: px(border), width: px(cw - border * 4), height: px(ch - border * 4), background: 'var(--ink)', overflow: 'hidden', borderRadius: px(border) });
        const sw = cw - border * 4, sh = ch - border * 4;
        h('div', 'abs', scr, { left: '0px', top: px(sh * 0.62), width: px(sw), height: px(Math.max(2, sh * 0.03)), background: 'var(--card)' });
        const fin = h('div', 'abs', scr, { left: '0px', top: px(sh * 0.62 - sh * 0.3), width: '0px', height: '0px', borderLeft: `${sh * 0.12}px solid transparent`, borderRight: `${sh * 0.2}px solid transparent`, borderBottom: `${sh * 0.3}px solid var(--accent)` });
        tvs.push({ tv, fin, sw, phase: rand(), delay: rand() * 0.35, speed: 0.18 + rand() * 0.12 });
      }
      return { g, tvs };
    });
    const icons = h('div', 'abs', root, { left: '1010px', top: '150px', width: '840px', height: '700px' });
    const iconEls = [];
    const rand = mulberry32(1975);
    for (let r = 0; r < 6; r++) for (let q = 0; q < 10; q++) {
      const ic = h('div', 'abs', icons, { left: px(q * 84), top: px(r * 112), width: '72px', height: '90px', transformOrigin: '50% 100%' });
      h('div', 'abs', ic, { left: '0px', top: '0px', width: '0px', height: '0px', borderLeft: '36px solid transparent', borderRight: '36px solid transparent', borderBottom: '26px solid var(--ink)' });
      h('div', 'abs', ic, { left: '6px', top: '26px', width: '60px', height: '64px', background: 'var(--ink)' });
      h('div', 'abs', ic, { left: '12px', top: '36px', width: '48px', height: '14px', background: 'var(--accent)' });
      iconEls.push({ ic, at: rand() });
    }
    const cinemaLabel = line(root, [{ id: 'c', t: 'CENTENAS DE CINEMAS' }, '\nNA MESMA DATA'], 'ui', 1010, 870, 52);
    const cinemaHl = highlighter(cinemaLabel, 'c');

    return (t, sc) => {
      const u = t - sc.start;
      wipe(year, E.out(P(t, sc.start - 0.1, 0.45)));
      wipe(title, E.out(P(t, c.title, 0.35)));
      wipe(prime.el, E.out(P(t, c.prime, 0.3)));
      primeHl(P(t, c.prime + 0.25, 0.4));
      tvType(t, c.tv16, 1.2);
      const stages = [sc.start, c.tv4, c.tv16, c.tv48];
      const gridOut = E.inOut(P(t, c.cinemas - 0.2, 0.4));
      grids.forEach(({ g, tvs }, gi) => {
        const active = t >= stages[gi] - 0.05 && (gi === 3 || t < stages[gi + 1]);
        vis(g, active);
        if (!active) return;
        g.style.translate = `0px ${(-gridOut * 1100).toFixed(1)}px`;
        for (const tvo of tvs) {
          tf(tvo.tv, { s: E.back(P(t, stages[gi] + (gi ? tvo.delay : 0.1), 0.3)) });
          const fx = ((tvo.phase + u * tvo.speed) % 1) * (tvo.sw + 60) - 40;
          tvo.fin.style.transform = `translateX(${fx.toFixed(1)}px)`;
        }
      });
      vis(icons, t >= c.cinemas);
      for (const { ic, at } of iconEls) tf(ic, { s: E.back(P(t, c.cinemas + at * 1.6, 0.25)) });
      wipe(cinemaLabel.el, E.out(P(t, c.cinemaLabel, 0.3)));
      cinemaHl(P(t, c.cinemaLabel + 0.3, 0.4));
      return { zoom: 1 + 0.03 * P(u, 0, sc.end - sc.start), shake: 0 };
    };
  },

  starwars(root) {
    const c = C('starwars');
    const year = h('div', 'abs disp', root, { left: '90px', top: '100px', fontSize: '250px' }, '1998');
    const sub = h('div', 'abs ui', root, { left: '100px', top: '370px', fontSize: '56px', lineHeight: '1.25' }, 'STAR WARS:\nEPISÓDIO I');
    const ticket = h('div', 'abs', root, { left: '930px', top: '170px', width: '900px', height: '440px', transformOrigin: '50% 50%' });
    const left = h('div', 'abs', ticket, { left: '0px', top: '0px', width: '660px', height: '440px', background: 'var(--card)', border: '8px solid var(--ink)', borderRight: '6px dashed var(--ink)', borderRadius: '24px 0 0 24px' });
    const right = h('div', 'abs', ticket, { left: '660px', top: '0px', width: '240px', height: '440px', background: 'var(--accent)', border: '8px solid var(--ink)', borderLeft: 'none', borderRadius: '0 24px 24px 0', transformOrigin: '0 100%' });
    h('div', 'abs disp', left, { left: '40px', top: '40px', fontSize: '104px' }, 'INGRESSO');
    h('div', 'abs ui', left, { left: '44px', top: '166px', fontSize: '52px', lineHeight: '1.15' }, 'FILME: OUTRO\nQUALQUER');
    const reasonType = typer(left, 'MOTIVO: O TRAILER', 44, 328, 54);
    const reasonLine = h('div', 'hl', left, { left: '284px', top: '326px', width: '310px', height: '68px', zIndex: '-1' });
    left.style.isolation = 'isolate';
    h('div', 'abs disp', right, { left: '48px', top: '120px', fontSize: '210px' }, 'I');
    h('div', 'abs ui', right, { left: '40px', top: '360px', fontSize: '30px' }, 'Nº 1998');
    const people = h('div', 'abs', root, { left: '930px', top: '700px', width: '900px', height: '260px', overflow: 'hidden' });
    const persons = [];
    for (let i = 0; i < 7; i++) {
      const p = h('div', 'abs', people, { left: px(i * 120), top: '40px', width: '70px', height: '170px' });
      h('div', 'abs', p, { left: '13px', top: '0px', width: '44px', height: '44px', borderRadius: '22px', background: 'var(--ink)' });
      h('div', 'abs', p, { left: '0px', top: '54px', width: '70px', height: '110px', borderRadius: '30px 30px 8px 8px', background: 'var(--ink)' });
      persons.push(p);
    }
    const exit = h('div', 'abs ui', root, { left: '1560px', top: '660px', fontSize: '46px', background: 'var(--accent)', padding: '8px 18px' }, 'SAÍDA →');
    const pile = [];
    const rand = mulberry32(1998);
    for (let i = 0; i < 9; i++) {
      const tk = h('div', 'abs card', root, { left: px(80 + rand() * 700), top: px(80 + rand() * 640), width: '380px', height: '170px', border: '6px solid var(--ink)', borderRadius: '16px', transformOrigin: '50% 50%' });
      h('div', 'abs disp', tk, { left: '26px', top: '26px', fontSize: '58px' }, 'INGRESSO');
      h('div', 'abs', tk, { left: '270px', top: '0px', width: '0px', height: '158px', borderLeft: '5px dashed var(--ink)' });
      h('div', 'abs ui', tk, { left: '28px', top: '100px', fontSize: '26px', color: 'var(--grey)' }, 'SÓ PELO TRAILER');
      pile.push({ tk, r: rand() * 40 - 20, at: i * 0.11 });
    }

    return (t, sc) => {
      const u = t - sc.start;
      wipe(year, E.out(P(t, sc.start - 0.1, 0.45)));
      wipe(sub, E.out(P(t, c.sub, 0.35)), 'down');
      vis(ticket, t >= c.ticket - 0.05);
      const tin = E.out(P(t, c.ticket, 0.45));
      tf(ticket, { y: (1 - tin) * 800, r: lerp(-12, -4, tin) });
      reasonType(t, c.reason, 1.3);
      reasonLine.style.transform = `scaleX(${E.out(P(t, c.reasonHl, 0.35)).toFixed(4)})`;
      const tear = E.out(P(t, c.tear, 0.35));
      tf(right, { x: tear * 120, y: tear * 70, r: tear * 16 });
      tf(left, { x: -tear * 18, r: -tear * 1.5 });
      vis(people, t >= c.leave);
      persons.forEach((p, i) => {
        const walk = Math.max(0, t - c.leave - i * 0.08);
        const bob = Math.abs(Math.sin(walk * 9 + i)) * 10;
        tf(p, { x: lerp(-900, 0, E.out(P(t, c.leave, 0.35))) + walk * 230, y: -bob });
      });
      vis(exit, t >= c.leave);
      wipe(exit, E.out(P(t, c.leave + 0.2, 0.25)));
      for (const { tk, r, at } of pile) {
        vis(tk, t >= c.pile + at);
        tf(tk, { s: slam(t, c.pile + at, 1.8, 0.2), r });
      }
      return { zoom: 1 + 0.03 * P(u, 0, sc.end - sc.start), shake: shake(t, c.pile, 9) };
    };
  },

  today(root) {
    const c = C('today');
    const strip = h('div', 'abs', root, { left: '0px', top: '0px', width: '4200px', height: '1080px' });
    h('div', 'abs', strip, { left: '0px', top: '470px', width: '4200px', height: '8px', background: 'var(--ink)' });
    const marks = [[160, '1913', 'ANÚNCIOS DEPOIS\nDA SESSÃO'], [760, '1960', 'O PASSEIO DE\nHITCHCOCK'], [1360, '1975', 'TV EM MASSA'], [2060, '1998', 'INGRESSO SÓ\nPELO TRAILER'], [2760, '2018', 'O TRAILER\nÉ O EVENTO']];
    const markEls = marks.map(([x, yr, cap], i) => {
      const m = h('div', 'abs', strip, { left: px(x), top: '300px', width: '600px', height: '420px' });
      h('div', 'abs', m, { left: '0px', top: '150px', width: '14px', height: '60px', background: i === 4 ? 'var(--accent)' : 'var(--ink)' });
      h('div', 'abs disp', m, { left: '0px', top: '0px', fontSize: '130px' }, yr);
      h('div', 'abs ui', m, { left: '4px', top: '228px', fontSize: '52px', lineHeight: '1.2' }, cap);
      return { m, x };
    });
    const phone = h('div', 'abs', root, { left: '1340px', top: '110px', width: '440px', height: '860px', border: '16px solid var(--ink)', borderRadius: '64px', background: 'var(--card)' });
    const video = h('div', 'abs', phone, { left: '18px', top: '120px', width: '372px', height: '210px', background: 'var(--ink)', borderRadius: '14px' });
    h('div', 'abs', video, { left: '160px', top: '72px', width: '0px', height: '0px', borderTop: '34px solid transparent', borderBottom: '34px solid transparent', borderLeft: '56px solid var(--accent)' });
    h('div', 'abs ui', phone, { left: '22px', top: '352px', fontSize: '28px', lineHeight: '1.3' }, 'VINGADORES:\nULTIMATO\nTRAILER');
    const bar = h('div', 'abs', phone, { left: '22px', top: '510px', width: '364px', height: '12px', background: 'var(--accent)', transformOrigin: '0 50%' });
    h('div', 'abs', phone, { left: '22px', top: '510px', width: '364px', height: '12px', border: '3px solid var(--ink)' });
    const rows = [];
    for (let i = 0; i < 4; i++) rows.push(h('div', 'abs', phone, { left: '22px', top: px(570 + i * 58), width: px(364 - (i % 2) * 90), height: '26px', background: 'var(--grey)', opacity: '0.35', transformOrigin: '0 50%' }));
    const countBox = h('div', 'abs', root, { left: '90px', top: '640px', width: '1200px', height: '300px' });
    const countHlBox = h('div', 'hl', countBox, { left: '-20px', top: '20px', width: '1230px', height: '170px', zIndex: '-1' });
    countBox.style.isolation = 'isolate';
    const counter = odometer(countBox, '289.000.000', 0, 0, 190);
    const countLabel = line(countBox, [{ id: 'l', t: 'VISUALIZAÇÕES' }, ' · PRIMEIRO DIA'], 'ui', 6, 212, 56);

    return (t, sc) => {
      const u = t - sc.start;
      const pan = E.inOut(P(t, c.pan, c.phone - c.pan));
      const shift = -pan * 2000;
      tf(strip, { x: shift });
      for (const { m, x } of markEls) {
        const screenX = x + shift;
        const appear = screenX < 1300 ? 1 : 0;
        wipe(m, appear ? E.out(clamp((1300 - screenX) / 260)) : 0, 'up');
      }
      const lift = E.inOut(P(t, c.count - 0.3, 0.5));
      strip.style.translate = `0px ${(-lift * 230).toFixed(1)}px`;
      vis(phone, t >= c.phone - 0.05);
      tf(phone, { y: (1 - E.out(P(t, c.phone, 0.45))) * 1000 });
      bar.style.transform = `scaleX(${clamp((t - c.phone) / 6).toFixed(4)})`;
      rows.forEach((row, i) => { row.style.transform = `scaleX(${E.out(P(t, c.phone + 0.3 + i * 0.12, 0.3)).toFixed(4)})`; });
      vis(countBox, t >= c.count);
      wipe(countBox, E.out(P(t, c.count, 0.3)), 'up');
      counter(289e6 * E.out(P(t, c.count, 2.2)));
      countHlBox.style.transform = `skewX(-4deg) scaleX(${E.out(P(t, c.push, 0.4)).toFixed(4)})`;
      const push = E.inOut(P(t, c.push, 0.6));
      tf(countBox, { s: 1 + push * 0.06, y: -push * 20 });
      return { zoom: 1 + 0.03 * P(u, 0, sc.end - sc.start), shake: shake(t, c.push, 6) };
    };
  },

  end(root) {
    const c = C('end');
    const sc0 = byId.end;
    const l1 = line(root, ['O TRAILER'], 'disp', 120, 120, 170);
    const l2 = line(root, [{ id: 'a', t: 'ANUNCIAVA' }], 'disp', 120, 310, 170);
    const l3 = line(root, [{ id: 'e', t: 'O EVENTO.' }], 'disp', 120, 500, 170);
    const strike = striker(l2, 'a', 26);
    const virou = h('div', 'abs disp', root, { left: '1010px', top: '250px', fontSize: '150px', background: 'var(--accent)', padding: '18px 34px 6px', transformOrigin: '50% 50%' }, 'VIROU');
    const eHl = highlighter(l3, 'e', { top: 0.05, height: 0.9, pad: 16 });
    const slate = h('div', 'abs', root, { left: '0px', top: '0px', width: '1920px', height: '1080px', background: 'var(--ink)', boxShadow: '-28px 0 48px rgba(22,20,18,.28)' });
    h('div', 'abs disp', slate, { left: '110px', top: '330px', fontSize: '230px', color: 'var(--card)' }, 'FATOPAMINA');
    const slateBar = h('div', 'abs', slate, { left: '116px', top: '580px', width: '980px', height: '18px', background: 'var(--accent)', transformOrigin: '0 50%' });
    const slateLine = h('div', 'abs ui', slate, { left: '118px', top: '640px', fontSize: '50px', color: 'var(--card)' }, 'INSCREVA-SE PARA O PRÓXIMO FATO');

    return (t, sc) => {
      const u = t - sc.start;
      wipe(l1.el, E.out(P(t, sc0.start, 0.35)), 'up');
      wipe(l2.el, E.out(P(t, c.l2, 0.35)), 'up');
      wipe(l3.el, E.out(P(t, c.l3, 0.35)), 'up');
      strike(P(t, c.strike, 0.25));
      vis(virou, t >= c.strike + 0.1);
      tf(virou, { s: slam(t, c.strike + 0.1, 1.8, 0.25), r: -4 });
      eHl(P(t, c.slate, 0.45));
      const sIn = E.out(P(t, c.endcard - 0.3, 0.45));
      vis(slate, t >= c.endcard - 0.3);
      tf(slate, { x: (1 - sIn) * W * 1.04 });
      slateBar.style.transform = `scaleX(${E.out(P(t, c.endcard + BEAT, 0.5)).toFixed(4)})`;
      wipe(slateLine, E.out(P(t, c.endcard + BEAT * 2, 0.4)));
      return { zoom: 1 + 0.03 * P(u, 0, sc.end - sc.start), shake: shake(t, c.strike + 0.1, 8) };
    };
  }
};

// ── grain: a few seeded noise plates, picked by frame (no state) ─────────
const grain = h('canvas', '', stage);
grain.id = 'grain';
grain.width = 960; grain.height = 540;
const gctx = grain.getContext('2d');
const plates = Array.from({ length: 6 }, (_, k) => {
  const img = gctx.createImageData(960, 540);
  const rand = mulberry32(7000 + k);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 150 + Math.floor(rand() * 105);
    img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v - 6; img.data[i + 3] = 255;
  }
  return img;
});
h('div', '', stage).id = 'vignette';

// Static paper fibers (deterministic SVG turbulence).
document.documentElement.style.setProperty('--fibers',
  `url("data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><filter id="f"><feTurbulence type="fractalNoise" baseFrequency="0.012 0.9" numOctaves="2" seed="11"/><feColorMatrix values="0 0 0 0 0.45  0 0 0 0 0.38  0 0 0 0 0.28  0 0 0 0.16 0"/></filter><rect width="100%" height="100%" filter="url(#f)"/></svg>')}")`);

let painters = [];
async function init() {
  await document.fonts.ready;
  await Promise.all([...document.fonts].map(f => f.load()));
  painters = scenes.map(sc => {
    const { el, cam } = sheet(sc.index);
    const paint = builders[sc.id](cam, sc);
    return { sc, el, cam, paint };
  });
}

function seek(t) {
  const TIN = 0.3, TDUR = 0.42;
  for (const { sc, el, cam, paint } of painters) {
    const visible = t >= sc.start - TIN && t < sc.end + 0.15;
    vis(el, visible);
    if (!visible) continue;
    const k = sc.index === 0 ? 1 : E.out(P(t, sc.start - TIN, TDUR));
    const outK = E.out(P(t, sc.end - TIN, TDUR));
    tf(el, { x: (1 - k) * W * 1.03 - outK * W * 0.28, r: (1 - k) * 1.8 });
    el.style.transformOrigin = '0% 100%';
    const { zoom = 1, shake: sh = 0 } = paint(t, sc) || {};
    const dx = smoothNoise(t * 0.3, sc.index * 3 + 1) * 8 + sh;
    const dy = smoothNoise(t * 0.3, sc.index * 3 + 2) * 6;
    cam.style.transform = `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px) scale(${zoom.toFixed(4)})`;
  }
  gctx.putImageData(plates[Math.floor(t * 12) % plates.length], 0, 0);
}

window.seek = seek;
window.filmReady = init();
