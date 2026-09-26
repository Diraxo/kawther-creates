// Weight chart (SVG). Draws ONLY real saved weigh-ins: no interpolated "measurements", no invented points.
//   0 points  -> axes-free empty state
//   1 point   -> a single labelled dot (no line)
//   2 points  -> a straight segment (two points cannot honestly justify a curve)
//   3+ points -> a smooth monotone curve (never overshoots the real values)
// The x axis is a true date scale over the selected window, so the spacing reflects real time between entries.
import { $ } from '../lib/dom.js';
import { reducedMotion } from '../lib/motion.js';
import { daysBetween, parseDate } from '../domain/dates.js';
import { monotonePath, niceTicks } from './chart-math.js';

const NS = 'http://www.w3.org/2000/svg';
const W = 320, H = 200;
const M = { l: 36, r: 14, t: 16, b: 30 };

function el(name, attrs = {}, text) {
  const e = document.createElementNS(NS, name);
  Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
  if (text != null) e.textContent = text;
  return e;
}

const dayLabel = (d) => parseDate(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const kg = (v) => `${Number(v.toFixed(1))} kg`;

/**
 * @param {{ points: {d:string,w:number}[], goal:number, startWeight:number, from:string, to:string }} o
 *   from/to = the window's real first/last day.
 */
export function drawChart({ points, goal, startWeight, from, to }) {
  const svg = $('p-chart');
  const foot = $('p-chartfoot');
  svg.innerHTML = '';
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const n = points.length;

  if (n === 0) {
    svg.setAttribute('aria-label', 'Weight chart: no weigh-ins in this range yet');
    svg.appendChild(el('text', { x: W / 2, y: H / 2 - 6, 'text-anchor': 'middle', 'font-size': 13, 'font-weight': 700, fill: 'var(--ink)' }, 'No weigh-ins in this range'));
    svg.appendChild(el('text', { x: W / 2, y: H / 2 + 14, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--sub)' }, 'Add your weight in a check-in to start your chart.'));
    foot.textContent = '';
    return;
  }

  // ---- scales ----
  const vals = points.map((p) => p.w);
  const lo = Math.min(...vals, goal, startWeight);
  const hi = Math.max(...vals, goal, startWeight);
  const ticks = niceTicks(lo - 0.3, hi + 0.3);
  const yMin = ticks[0], yMax = ticks[ticks.length - 1];
  const spanDays = Math.max(0, daysBetween(from, to));
  const plotW = W - M.l - M.r, plotH = H - M.t - M.b;
  const x = (d) => M.l + (spanDays === 0 ? plotW / 2 : (daysBetween(from, d) / spanDays) * plotW);
  const y = (v) => M.t + (1 - (v - yMin) / (yMax - yMin || 1)) * plotH;
  const coords = points.map((p) => [x(p.d), y(p.w)]);

  // ---- grid + Y axis ----
  const grid = el('g', { 'aria-hidden': 'true' });
  ticks.forEach((tv) => {
    grid.appendChild(el('line', { x1: M.l, x2: W - M.r, y1: y(tv), y2: y(tv), stroke: 'var(--line)', 'stroke-width': 1 }));
    grid.appendChild(el('text', { x: M.l - 6, y: y(tv) + 3.5, 'text-anchor': 'end', 'font-size': 9.5, fill: 'var(--sub)' }, String(Number(tv.toFixed(1)))));
  });
  grid.appendChild(el('text', { x: M.l - 6, y: 9, 'text-anchor': 'end', 'font-size': 8.5, fill: 'var(--sub)' }, 'kg'));
  svg.appendChild(grid);

  // ---- X axis (real dates of the window) ----
  const xa = el('g', { 'aria-hidden': 'true' });
  const tickCount = spanDays === 0 ? 1 : Math.min(4, spanDays + 1);
  const seen = new Set();
  for (let i = 0; i < tickCount; i++) {
    const offset = tickCount === 1 ? 0 : Math.round((i * spanDays) / (tickCount - 1));
    const d = new Date(parseDate(from));
    d.setDate(d.getDate() + offset);
    const label = dayLabel(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    if (seen.has(label)) continue;
    seen.add(label);
    const px = spanDays === 0 ? M.l + plotW / 2 : M.l + (offset / spanDays) * plotW;
    const anchor = i === 0 && spanDays !== 0 ? 'start' : i === tickCount - 1 && spanDays !== 0 ? 'end' : 'middle';
    xa.appendChild(el('text', { x: px, y: H - 10, 'text-anchor': anchor, 'font-size': 9.5, fill: 'var(--sub)' }, label));
  }
  svg.appendChild(xa);

  // ---- reference lines: start + goal (labelled, distinct) ----
  const ref = el('g', { 'aria-hidden': 'true' });
  const startY = y(startWeight), goalY = y(goal);
  ref.appendChild(el('line', { x1: M.l, x2: W - M.r, y1: startY, y2: startY, stroke: 'var(--sub)', 'stroke-width': 1, 'stroke-dasharray': '2,4', opacity: 0.7 }));
  ref.appendChild(el('text', { x: W - M.r, y: startY + (Math.abs(startY - goalY) < 12 ? 11 : -4), 'text-anchor': 'end', 'font-size': 9, fill: 'var(--sub)' }, `Start ${kg(startWeight)}`));
  ref.appendChild(el('line', { x1: M.l, x2: W - M.r, y1: goalY, y2: goalY, stroke: 'var(--gold)', 'stroke-width': 1.25, 'stroke-dasharray': '5,4' }));
  ref.appendChild(el('text', { x: W - M.r, y: goalY + (goalY > startY ? 11 : -4), 'text-anchor': 'end', 'font-size': 9, 'font-weight': 700, fill: 'var(--gold)' }, `Goal ${kg(goal)}`));
  svg.appendChild(ref);

  // ---- data ----
  const animate = !reducedMotion();
  if (n >= 2) {
    const d = n === 2 ? `M${coords[0][0]},${coords[0][1]} L${coords[1][0]},${coords[1][1]}` : monotonePath(coords);
    const baseY = M.t + plotH;
    const grad = el('linearGradient', { id: 'gradFill', x1: 0, y1: 0, x2: 0, y2: 1 });
    grad.innerHTML = '<stop offset="0%" stop-color="var(--emerald)" stop-opacity="0.32"/><stop offset="100%" stop-color="var(--emerald)" stop-opacity="0"/>';
    const defs = el('defs');
    defs.appendChild(grad);
    svg.appendChild(defs);
    const fill = el('path', { d: `${d} L${coords[n - 1][0]},${baseY} L${coords[0][0]},${baseY} Z`, fill: 'url(#gradFill)', stroke: 'none', 'aria-hidden': 'true' });
    svg.appendChild(fill);
    const line = el('path', { d, fill: 'none', stroke: 'var(--emerald)', 'stroke-width': 2.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', pathLength: 1, 'aria-hidden': 'true' });
    svg.appendChild(line);
    if (animate) {
      line.setAttribute('stroke-dasharray', '1');
      line.setAttribute('stroke-dashoffset', '1');
      fill.style.opacity = '0';
      requestAnimationFrame(() => {
        line.style.transition = 'stroke-dashoffset .9s cubic-bezier(.2,.8,.2,1)';
        line.style.strokeDashoffset = '0';
        fill.style.transition = 'opacity .9s ease .2s';
        fill.style.opacity = '1';
      });
    }
  }

  // ---- points: focusable, labelled, with an accessible tooltip ----
  const pointsG = el('g');
  const tip = el('g', { class: 'chart-tip', 'aria-hidden': 'true', visibility: 'hidden', 'pointer-events': 'none' });
  const tipBg = el('rect', { rx: 6, height: 34, fill: 'var(--ink)' });
  const tipT1 = el('text', { 'font-size': 11, 'font-weight': 700, fill: 'var(--bg)' });
  const tipT2 = el('text', { 'font-size': 9, fill: 'var(--bg)', opacity: 0.8 });
  tip.append(tipBg, tipT1, tipT2);
  const showTip = (i) => {
    const [cx, cy] = coords[i];
    const t1 = kg(points[i].w), t2 = dayLabel(points[i].d);
    tipT1.textContent = t1;
    tipT2.textContent = t2;
    const w = Math.max(t1.length * 6.2, t2.length * 5) + 16;
    const tx = Math.max(2, Math.min(W - w - 2, cx - w / 2));
    const ty = cy - 44 < 0 ? cy + 12 : cy - 44;
    tipBg.setAttribute('width', w); tipBg.setAttribute('x', tx); tipBg.setAttribute('y', ty);
    tipT1.setAttribute('x', tx + 8); tipT1.setAttribute('y', ty + 14);
    tipT2.setAttribute('x', tx + 8); tipT2.setAttribute('y', ty + 27);
    tip.setAttribute('visibility', 'visible');
  };
  const hideTip = () => tip.setAttribute('visibility', 'hidden');
  coords.forEach((c, i) => {
    const isLast = i === n - 1;
    const g = el('g', { tabindex: 0, role: 'img', 'aria-label': `${dayLabel(points[i].d)}: ${kg(points[i].w)}${isLast ? ' (latest)' : ''}`, 'data-chart-point': i, style: 'outline:none; cursor:pointer' });
    const ring = el('circle', { cx: c[0], cy: c[1], r: 14, fill: 'transparent', class: 'chart-hit' });
    const dot = el('circle', { cx: c[0], cy: c[1], r: isLast ? 5 : 3.2, fill: isLast ? 'var(--emerald)' : 'var(--card)', stroke: 'var(--emerald)', 'stroke-width': 2 });
    g.append(ring, dot);
    g.addEventListener('mouseenter', () => showTip(i));
    g.addEventListener('mouseleave', hideTip);
    g.addEventListener('focus', () => showTip(i));
    g.addEventListener('blur', hideTip);
    g.addEventListener('click', () => showTip(i));
    g.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTip(); });
    if (animate) { g.style.opacity = '0'; g.style.transition = `opacity .35s ease ${0.25 + i * 0.04}s`; requestAnimationFrame(() => { g.style.opacity = '1'; }); }
    pointsG.appendChild(g);
  });
  // A soft pulse on the latest weigh-in so "you are here" catches the eye.
  if (animate) {
    const [px, py] = coords[n - 1];
    const pulse = el('circle', { cx: px, cy: py, r: 5, fill: 'none', stroke: 'var(--emerald)', 'stroke-width': 1.5, 'aria-hidden': 'true', 'pointer-events': 'none' });
    pulse.appendChild(el('animate', { attributeName: 'r', values: '5;13', dur: '2s', begin: '1s', repeatCount: 'indefinite' }));
    pulse.appendChild(el('animate', { attributeName: 'opacity', values: '0.7;0', dur: '2s', begin: '1s', repeatCount: 'indefinite' }));
    svg.appendChild(pulse);
  }
  svg.appendChild(pointsG);
  // Scrub: drag a finger or the mouse across the chart and the tooltip follows the nearest real weigh-in.
  const nearest = (evt) => {
    const box = svg.getBoundingClientRect();
    const px = ((evt.clientX - box.left) / box.width) * W;
    let best = 0;
    coords.forEach((c, i) => { if (Math.abs(c[0] - px) < Math.abs(coords[best][0] - px)) best = i; });
    return best;
  };
  svg.style.touchAction = 'pan-y';
  svg.onpointermove = (evt) => showTip(nearest(evt));
  svg.onpointerdown = (evt) => showTip(nearest(evt));
  svg.onpointerleave = (evt) => { if (evt.pointerType === 'mouse') hideTip(); };
  // Always-visible label on the latest weight so "current" is clear without interaction.
  const [lx, ly] = coords[n - 1];
  const nowLabel = `Now ${kg(points[n - 1].w)}`;
  const anchor = lx > W - 70 ? 'end' : 'middle';
  svg.appendChild(el('text', { x: anchor === 'end' ? lx + 4 : lx, y: ly - 11 < 10 ? ly + 20 : ly - 11, 'text-anchor': anchor, 'font-size': 10, 'font-weight': 700, fill: 'var(--emerald)', 'aria-hidden': 'true' }, nowLabel));
  svg.appendChild(tip);

  svg.setAttribute('aria-label', `Weight chart: ${n} weigh-in${n === 1 ? '' : 's'}, latest ${kg(points[n - 1].w)}, goal ${kg(goal)}`);
  foot.textContent = n === 1
    ? '1 weight entry · Keep checking in to reveal your trend.'
    : n === 2
      ? '2 weight entries · A trend line appears from 3 entries.'
      : `${n} weight entries`;
}
