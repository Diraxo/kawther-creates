import { $, $$ } from '../lib/dom.js';
import { animateValue, reducedMotion } from '../lib/motion.js';
import { state } from '../state.js';
import { todayStr } from '../domain/dates.js';
import { MAX_CUSTOM_RANGE, RANGE_PRESETS, chartPoints, progressStats } from '../domain/metrics.js';
import { lastLoggedWeight, waterGoalOf } from '../domain/journey.js';
import { formatLitres } from '../domain/checkin.js';
import { drawChart } from '../ui/chart.js';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Which chip represents the current selection ('7', '14', ..., 'all' or 'custom'). */
function activeChip(sel) {
  if (sel.kind === 'all') return 'all';
  return RANGE_PRESETS.includes(sel.days) && !sel.custom ? String(sel.days) : 'custom';
}

/** The user can only look back as far as their own journey is long. */
const journeyLength = () => Math.min(MAX_CUSTOM_RANGE, state.user.journey.duration);

/** Keep the selection inside the journey (e.g. the default 30 days on a 14-day journey becomes the 14-day chip). */
function clampRange() {
  const sel = state.progressRange;
  const max = journeyLength();
  if (sel.kind === 'days' && sel.days > max) {
    state.progressRange = RANGE_PRESETS.includes(max) ? { kind: 'days', days: max } : { kind: 'all' };
  }
}

function syncChips() {
  clampRange();
  const active = activeChip(state.progressRange);
  const max = journeyLength();
  $$('#p-ranges .rchip').forEach((c) => {
    const r = c.dataset.r;
    // Presets longer than the journey are hidden; "All" is redundant when a preset already equals the journey.
    c.hidden = /^\d+$/.test(r) && Number(r) > max;
    if (r === 'all') c.hidden = RANGE_PRESETS.includes(max);
    const on = r === active;
    c.classList.toggle('on', on);
    c.setAttribute('aria-pressed', String(on));
  });
  $('p-custom').hidden = active !== 'custom';
}

function afterSwitch() {
  const chartEl = $('p-chart');
  if (reducedMotion()) { renderProgress(); return; }
  chartEl.style.transition = 'opacity .18s ease';
  chartEl.style.opacity = '0';
  setTimeout(() => {
    try { renderProgress(); } finally { chartEl.style.opacity = '1'; } // the chart can never be left invisible
  }, 170);
}

export function setRange(el) {
  const r = el.dataset.r;
  $('e-p-custom').textContent = '';
  $('e-p-custom').style.display = 'none';
  if (r === 'custom') {
    const cur = state.progressRange;
    state.progressRange = { kind: 'days', days: cur.kind === 'days' ? cur.days : 45, custom: true };
    syncChips();
    $('p-custom-days').value = String(state.progressRange.days);
    $('p-custom-days').focus();
    return;
  }
  state.progressRange = r === 'all' ? { kind: 'all' } : { kind: 'days', days: Number(r) };
  afterSwitch();
}

/** Custom range: whole days, 1..journey length (you can't look back further than the journey exists). */
export function applyCustomRange() {
  const raw = $('p-custom-days').value.trim();
  const max = Math.min(MAX_CUSTOM_RANGE, state.user.journey.duration);
  let err = '';
  if (!/^\d+$/.test(raw)) err = 'Enter a whole number of days.';
  else if (Number(raw) < 1) err = 'Choose at least 1 day.';
  else if (Number(raw) > max) err = `Your journey is ${max} days, so choose ${max} or fewer.`;
  $('e-p-custom').textContent = err;
  $('e-p-custom').style.display = err ? 'block' : 'none';
  $('p-custom-days').setAttribute('aria-invalid', err ? 'true' : 'false');
  if (err) return;
  state.progressRange = { kind: 'days', days: Number(raw), custom: true };
  afterSwitch();
}

const signed = (v, d = 1) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d);

export function renderProgress() {
  const { user, progressRange } = state;
  const s = progressStats(user, progressRange, todayStr());
  const win = s.window;
  syncChips();

  $('p-start').textContent = user.journey.startWeight;
  const logged = lastLoggedWeight(user);
  const hasCheckins = Object.keys(user.checkins).length > 0;
  $('p-empty').style.display = hasCheckins ? 'none' : 'block';
  $('p-now').textContent = logged ? logged.toFixed(1) : '—';
  $('p-goal').textContent = user.journey.goalWeight;

  // ---- what the selected window really covers ----
  const isAll = win.kind === 'all';
  $('p-rangetitle').textContent = isAll ? `All time · ${plural(win.elapsed, 'day')}` : `${win.days}-day view`;
  let sub = `${s.checkinCount} of ${isAll ? win.elapsed : win.days} days recorded`;
  if (!isAll && !win.complete) sub += ` · You're on day ${win.journeyDay} of your journey. More progress will appear as you continue.`;
  $('p-rangesub').textContent = sub;

  // ---- stats: computed only from real data inside the window, counted up from what was showing ----
  animateValue($('st-change'), s.windowChange, (v) => `${signed(v)} kg`);
  $('st-change-lbl').textContent = s.windowChange == null ? 'Needs 2 weigh-ins in view' : 'Change in this view';
  animateValue($('st-streak'), s.streak, (v) => plural(Math.round(v), 'day'));
  $('st-streak-lbl').textContent = s.streakInfo.status === 'interrupted'
    ? `Streak paused · best ${s.streakInfo.best}`
    : s.streakInfo.best > s.streak ? `Current streak · best ${s.streakInfo.best}` : 'Current streak';
  $('st-checkins').textContent = `${s.checkinCount} of ${isAll ? win.elapsed : win.days}`;
  animateValue($('st-workouts'), s.workouts, (v) => String(Math.round(v)));
  animateValue($('st-water'), s.avgWaterMl == null ? null : s.avgWaterMl / 1000, (v) => `${v.toFixed(1)} L`);
  $('st-water-lbl').textContent = s.avgWaterMl == null ? 'Average water' : `Average water · goal ${formatLitres(waterGoalOf(user.journey))}`;
  animateValue($('st-consistency'), s.consistency, (v) => `${Math.round(v)}%`);
  $('st-consistency-lbl').textContent = s.consistency == null ? 'Consistency' : `Consistency · of ${plural(win.elapsed, 'elapsed day')}`;

  drawChart({
    points: chartPoints(user, s.inRange),
    goal: user.journey.goalWeight,
    startWeight: user.journey.startWeight,
    from: win.start,
    to: win.end,
  });
}
