import { $, $$ } from '../lib/dom.js';
import { reportDataError } from '../lib/dataError.js';
import { state } from '../state.js';
import { getRepo } from '../data/repository.js';
import { DEFAULT_WATER_GOAL, MAX_JOURNEY_DAYS, MIN_JOURNEY_DAYS, parseDuration } from '../domain/journey.js';
import { todayStr } from '../domain/dates.js';
import { go } from '../ui/router.js';
import { isBusy, withBusy } from '../ui/busy.js';

const validWeight = (v) => v && v >= 30 && v <= 300;

export function obStep2() {
  const v = parseFloat($('ob-start').value);
  $('e-ob-start').style.display = 'none';
  if (!validWeight(v)) { $('e-ob-start').style.display = 'block'; return; }
  state.onboarding.start = v;
  go('s-ob3');
}

export function obStep3() {
  const v = parseFloat($('ob-goal').value);
  $('e-ob-goal').style.display = 'none';
  if (!validWeight(v)) { $('e-ob-goal').style.display = 'block'; return; }
  state.onboarding.goal = v;
  go('s-ob4');
}

const durErr = () => $('e-ob-dur');

function showDurError(msg) {
  const err = durErr();
  err.textContent = msg || '';
  err.style.display = msg ? 'block' : 'none';
  $('ob-dur').setAttribute('aria-invalid', msg ? 'true' : 'false');
}

/** Validate the custom field; returns the day count or null (and shows the inline message). */
function readCustom(showEmpty) {
  const raw = $('ob-dur').value;
  if (!showEmpty && raw.trim() === '') { showDurError(''); return null; }
  const r = parseDuration(raw);
  showDurError(r.ok ? '' : r.error);
  return r.ok ? r.value : null;
}

export function pickDur(el) {
  const custom = el.dataset.d === 'custom';
  $$('#s-ob4 .dur-card, #s-ob4 .dur-custom-head').forEach((o) => {
    const on = o === el || (custom && o.id === 'dur-custom');
    o.classList.toggle('on', on);
    if (o.tagName === 'BUTTON') o.setAttribute('aria-pressed', String(o === el));
  });
  $('dur-custom').classList.toggle('on', custom);
  $('dur-custom-body').hidden = !custom;
  state.onboarding.custom = custom;
  if (custom) {
    state.onboarding.duration = readCustom(false);
    $('ob-dur').focus({ preventScroll: false });
  } else {
    showDurError('');
    state.onboarding.duration = Number(el.dataset.d);
  }
}

/** Live typing: keep only digits, revalidate, keep state in sync. */
export function onDurInput() {
  const input = $('ob-dur');
  const cleaned = input.value.replace(/[^\d]/g, '');
  const hadJunk = cleaned !== input.value;
  if (hadJunk) input.value = cleaned;
  const v = readCustom(false);
  if (hadJunk && v === null && cleaned === '') showDurError('Use whole numbers only.');
  state.onboarding.duration = v;
}

export function stepDur(el) {
  const input = $('ob-dur');
  const cur = parseInt(input.value, 10);
  const base = Number.isFinite(cur) ? cur : 45 - Number(el.dataset.n);
  const next = Math.min(MAX_JOURNEY_DAYS, Math.max(MIN_JOURNEY_DAYS, base + Number(el.dataset.n)));
  input.value = String(next);
  state.onboarding.duration = readCustom(true);
}

export function obStep4(btn) {
  const { custom } = state.onboarding;
  const duration = custom ? readCustom(true) : state.onboarding.duration;
  if (custom && duration === null) { $('ob-dur').focus(); return; }
  state.onboarding.duration = duration;
  return finishOnboarding(btn);
}

export async function finishOnboarding(btn) {
  if (isBusy(btn)) return;
  const { start, goal, duration } = state.onboarding;
  if (!parseDuration(duration).ok) return;
  const journey = { start: todayStr(), duration, startWeight: start, goalWeight: goal, waterGoal: DEFAULT_WATER_GOAL };
  try {
    await withBusy(btn, 'Starting your journey…', () => getRepo().createJourney(journey));
  } catch (e) {
    reportDataError(e, "Couldn't save your journey. Please try again.");
    return;
  }
  state.user.journey = journey;
  state.user.onboarded = true;
  $('suc-days').textContent = duration + ' DAYS';
  $('suc-start').textContent = journey.startWeight + ' kg';
  $('suc-goal').textContent = journey.goalWeight + ' kg';
  go('s-success');
}
