// Mullo, the mascot (S20). The designer's SVG (docs/brand/mascot-motion.dc.html),
// drawn with createElementNS since h() makes HTML elements only. The mood is ONE
// class on the root (`st-idle` … `st-offline`); app.css holds the designer's
// keyframes and which face each mood shows. Two drawings: the full one (viewBox
// 400x420) for Record, Recording, the empty library and the library card, and a
// mini (100x100) for the floating record button.

import { MOODS } from '../domain/mood.js';

const NS = 'http://www.w3.org/2000/svg';
const FORBIDDEN_ATTR = /^(?:on[a-z]+|style)$/i;

// [tag, attrs, ...children] → SVG element.
function draw([tag, attrs, ...children]) {
  const el = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (FORBIDDEN_ATTR.test(key)) throw new Error(`mascot: "${key}" is not allowed - use a class`);
    el.setAttribute(key, String(value));
  }
  for (const child of children) el.append(draw(child));
  return el;
}

// Every copy gets its own gradient id: two mascots on one page must not share one.
let copies = 0;

const DARK = '#221628';
const MOUTH = '#5A2338';
const TONGUE = '#F07C9A';
const MINT = '#9EDDCF';
const round = { 'stroke-linecap': 'round' };

function full(grad) {
  const eye = (x) => ['g', { class: 'eye' },
    ['circle', { cx: x, cy: 276, r: 21, fill: DARK }],
    ['g', { class: 'pupil' },
      ['circle', { cx: x, cy: 279, r: 15, fill: '#3E2D55' }],
      ['circle', { cx: x, cy: 280, r: 9, fill: DARK }],
      ['circle', { cx: x - 8, cy: 268, r: 7.5, fill: '#FFFFFF' }],
      ['circle', { cx: x + 8, cy: 286, r: 3, fill: '#FFFFFF' }]]];
  const body = 'M68 382 C58 276 100 178 200 178 C300 178 342 276 332 382 Q200 402 68 382 Z';
  const dashes = { fill: 'none', stroke: MINT, 'stroke-width': 2.2, 'stroke-dasharray': '0.1 7', ...round, opacity: 0.5 };
  return ['svg', { viewBox: '0 0 400 420', 'aria-hidden': 'true', focusable: 'false' },
    ['defs', {}, ['radialGradient', { id: grad, cx: 0.4, cy: 0.35, r: 0.75 },
      ['stop', { offset: 0, 'stop-color': '#FFE6EC' }],
      ['stop', { offset: 0.6, 'stop-color': '#F7BFC9' }],
      ['stop', { offset: 1, 'stop-color': '#E996AA' }]]],
    ['circle', { cx: 200, cy: 290, r: 168, fill: MINT, opacity: 0.05 }],
    ['path', { d: 'M44 250 A160 160 0 0 0 44 350', ...dashes }],
    ['path', { d: 'M356 250 A160 160 0 0 1 356 350', ...dashes }],
    ['g', { fill: MINT },
      ['rect', { class: 'bar', x: 268, y: 44, width: 9, height: 20, rx: 4.5 }],
      ['rect', { class: 'bar d1', x: 283, y: 30, width: 10, height: 48, rx: 5 }],
      ['rect', { class: 'bar d2', x: 299, y: 40, width: 9, height: 28, rx: 4.5 }],
      ['rect', { class: 'bar d3', x: 314, y: 34, width: 10, height: 40, rx: 5 }],
      ['rect', { class: 'bar d4', x: 330, y: 46, width: 9, height: 16, rx: 4.5 }]],
    ['ellipse', { cx: 200, cy: 396, rx: 176, ry: 18, fill: '#132A2D' }],
    ['ellipse', { cx: 200, cy: 392, rx: 176, ry: 18, fill: '#1A3639' }],
    ['ellipse', { cx: 200, cy: 392, rx: 176, ry: 18, fill: 'none', stroke: MINT, 'stroke-width': 1, opacity: 0.3 }],
    ['ellipse', { class: 'shadow', cx: 200, cy: 388, rx: 120, ry: 8, fill: '#000000', opacity: 0.3 }],
    ['g', { class: 'm-bounce' },
      ['g', { class: 'm-antenna' },
        ['path', { d: 'M200 182 C192 164 214 152 205 134 C198 120 214 110 214 98', fill: 'none', stroke: '#F4BCC8', 'stroke-width': 8, ...round }],
        ['circle', { class: 'tip', cx: 214, cy: 88, r: 13, fill: MINT }],
        ['circle', { cx: 210, cy: 84, r: 4, fill: '#FFFFFF', opacity: 0.9 }],
        ['g', { class: 'm-bub b1' }, ['circle', { cx: 214, cy: 80, r: 7, fill: MINT }]],
        ['g', { class: 'm-bub b2' }, ['circle', { cx: 214, cy: 80, r: 5, fill: MINT }]],
        ['g', { class: 'm-bub b3' }, ['circle', { cx: 214, cy: 80, r: 3.5, fill: MINT }]],
        ['g', { class: 'm-orbit orbit-full' },
          ['circle', { class: 'm-bub', cx: 214, cy: 60, r: 5, fill: MINT }],
          ['circle', { class: 'm-bub', cx: 240, cy: 96, r: 3.5, fill: MINT }],
          ['circle', { class: 'm-bub', cx: 190, cy: 104, r: 3, fill: MINT }]],
        ['g', { class: 'v v-dots', fill: MINT },
          ['circle', { cx: 238, cy: 62, r: 3 }], ['circle', { cx: 250, cy: 56, r: 3 }], ['circle', { cx: 262, cy: 50, r: 3 }]]],
      ['path', { class: 'spark', d: 'M150 150 L154 160 L164 164 L154 168 L150 178 L146 168 L136 164 L146 160 Z', fill: '#FFD95A' }],
      ['path', { class: 'spark s2', d: 'M262 142 L265 150 L273 153 L265 156 L262 164 L259 156 L251 153 L259 150 Z', fill: '#FFD95A' }],
      ['path', { class: 'spark s3', d: 'M282 196 L284 201 L289 203 L284 205 L282 210 L280 205 L275 203 L280 201 Z', fill: MINT }],
      ['ellipse', { cx: 146, cy: 386, rx: 22, ry: 9, fill: '#E996AA' }],
      ['ellipse', { cx: 254, cy: 386, rx: 22, ry: 9, fill: '#E996AA' }],
      ['g', { class: 'm-body' },
        ['path', { d: body, fill: `url(#${grad})` }],
        ['path', { d: body, fill: 'none', stroke: '#FFD8E0', 'stroke-width': 2, opacity: 0.7 }],
        ['path', { d: 'M110 232 C126 206 150 190 176 186', fill: 'none', stroke: '#FFFFFF', 'stroke-width': 9, ...round, opacity: 0.5 }],
        ['g', { fill: '#FFFFFF', opacity: 0.7 },
          ...[[102, 268, 1.8], [130, 364, 1.4], [290, 232, 1.8], [312, 322, 1.4], [214, 350, 1.6], [252, 372, 1.4], [160, 214, 1.2]]
            .map(([cx, cy, r]) => ['circle', { cx, cy, r }])],
        ['path', { d: 'M140 246 Q158 236 176 244', fill: 'none', stroke: '#5A2A44', 'stroke-width': 4, ...round }],
        ['path', { d: 'M224 244 Q242 236 260 246', fill: 'none', stroke: '#5A2A44', 'stroke-width': 4, ...round }],
        ['g', { class: 'v v-open' }, eye(158), eye(242)],
        ['g', { class: 'v v-closed', fill: 'none', stroke: DARK, 'stroke-width': 5, ...round },
          ['path', { d: 'M140 280 Q158 262 176 280' }], ['path', { d: 'M224 280 Q242 262 260 280' }]],
        ['g', { class: 'v v-half' },
          ['path', { d: 'M139 276 A19 19 0 0 0 177 276 Z', fill: DARK }],
          ['path', { d: 'M223 276 A19 19 0 0 0 261 276 Z', fill: DARK }],
          ['line', { x1: 136, y1: 276, x2: 180, y2: 276, stroke: DARK, 'stroke-width': 4, ...round }],
          ['line', { x1: 220, y1: 276, x2: 264, y2: 276, stroke: DARK, 'stroke-width': 4, ...round }]],
        ['ellipse', { cx: 124, cy: 310, rx: 16, ry: 9, fill: '#EE8DA2', opacity: 0.75 }],
        ['ellipse', { cx: 276, cy: 310, rx: 16, ry: 9, fill: '#EE8DA2', opacity: 0.75 }],
        ['g', { class: 'v v-smile' },
          ['path', { d: 'M178 304 Q200 338 222 304 Q200 312 178 304 Z', fill: MOUTH, stroke: MOUTH, 'stroke-width': 3, 'stroke-linejoin': 'round' }],
          ['path', { d: 'M188 320 Q200 334 212 320 Q200 326 188 320 Z', fill: TONGUE }]],
        ['g', { class: 'v v-o' },
          ['ellipse', { cx: 200, cy: 316, rx: 11, ry: 13, fill: MOUTH }],
          ['ellipse', { cx: 200, cy: 323, rx: 6, ry: 4, fill: TONGUE }]],
        ['g', { class: 'v v-chew' },
          ['path', { class: 'chew', d: 'M182 314 Q191 306 200 314 Q209 322 218 314', fill: 'none', stroke: MOUTH, 'stroke-width': 4.5, ...round }]],
        ['g', { class: 'v v-flat' },
          ['line', { x1: 188, y1: 316, x2: 212, y2: 316, stroke: MOUTH, 'stroke-width': 4.5, ...round }]],
        ['g', { class: 'v v-big' },
          ['path', { d: 'M170 300 Q200 350 230 300 Z', fill: MOUTH, stroke: MOUTH, 'stroke-width': 3, 'stroke-linejoin': 'round' }],
          ['path', { d: 'M184 322 Q200 342 216 322 Q200 330 184 322 Z', fill: TONGUE }]]]]];
}

function mini(grad) {
  const eye = (x) => ['g', { class: 'eye' },
    ['circle', { cx: x, cy: 62, r: 7, fill: DARK }],
    ['g', { class: 'pupil' }, ['circle', { cx: x - 2, cy: 59, r: 2.6, fill: '#FFFFFF' }]]];
  return ['svg', { viewBox: '0 0 100 100', 'aria-hidden': 'true', focusable: 'false' },
    ['defs', {}, ['radialGradient', { id: grad, cx: 0.4, cy: 0.35, r: 0.75 },
      ['stop', { offset: 0, 'stop-color': '#FFE6EC' }],
      ['stop', { offset: 1, 'stop-color': '#E996AA' }]]],
    ['g', { class: 'm-bounce' },
      ['g', { class: 'm-antenna' },
        ['path', { d: 'M50 36 C46 28 56 24 52 16', fill: 'none', stroke: '#F4BCC8', 'stroke-width': 4, ...round }],
        ['circle', { class: 'tip', cx: 53, cy: 12, r: 5.5, fill: MINT }]],
      ['g', { class: 'm-body' },
        ['path', { d: 'M12 88 C8 58 24 34 50 34 C76 34 92 58 88 88 Q50 95 12 88 Z', fill: `url(#${grad})` }],
        ['g', { class: 'v v-open' }, eye(38), eye(62)],
        ['g', { class: 'v v-closed', fill: 'none', stroke: DARK, 'stroke-width': 3, ...round },
          ['path', { d: 'M31 64 Q38 56 45 64' }], ['path', { d: 'M55 64 Q62 56 69 64' }]],
        ['g', { class: 'v v-half' },
          ['path', { d: 'M31 62 A7 7 0 0 0 45 62 Z', fill: DARK }], ['path', { d: 'M55 62 A7 7 0 0 0 69 62 Z', fill: DARK }]],
        ['ellipse', { cx: 27, cy: 72, rx: 5, ry: 3, fill: '#EE8DA2', opacity: 0.7 }],
        ['ellipse', { cx: 73, cy: 72, rx: 5, ry: 3, fill: '#EE8DA2', opacity: 0.7 }],
        ['g', { class: 'v v-smile' }, ['path', { d: 'M43 73 Q50 83 57 73 Z', fill: MOUTH }]],
        ['g', { class: 'v v-o' }, ['ellipse', { cx: 50, cy: 76, rx: 4, ry: 5, fill: MOUTH }]],
        ['g', { class: 'v v-chew' },
          ['path', { class: 'chew', d: 'M43 76 Q46.5 72 50 76 Q53.5 80 57 76', fill: 'none', stroke: MOUTH, 'stroke-width': 2.5, ...round }]],
        ['g', { class: 'v v-flat' }, ['line', { x1: 45, y1: 76, x2: 55, y2: 76, stroke: MOUTH, 'stroke-width': 2.5, ...round }]],
        ['g', { class: 'v v-big' }, ['path', { d: 'M41 72 Q50 88 59 72 Z', fill: MOUTH }]]]]];
}

// mascot('mulling', { size: 'live' }) → <span class="mullo st-mulling mullo--live"><svg>…
// size picks the width in app.css (mullo--record, --live, --empty, --card). mini = the
// designer's 100x100 drawing, unused since the record button lost its mascot (2026-10-10).
export function mascot(mood = 'idle', { mini: small = false, size } = {}) {
  const grad = `mullo-g${++copies}`;
  const root = document.createElement('span');
  root.className = ['mullo', `st-${MOODS.includes(mood) ? mood : 'idle'}`, size && `mullo--${size}`].filter(Boolean).join(' ');
  root.append(draw(small ? mini(grad) : full(grad)));
  return root;
}

// Change the mood of a mascot already on the page (the button stays, the face changes).
export function setMood(root, mood) {
  if (!root) return;
  for (const m of MOODS) root.classList.toggle(`st-${m}`, m === mood);
}
