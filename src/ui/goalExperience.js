// The Goal Achievement Experience: a full-screen celebration (recognition -> recap -> trophy), then "what now?".
// Sequencing lives in domain/goalSequence.js; every word comes from domain/goal.js. This file only drives the DOM.
// Closing at any point is safe: the achievement is already saved, and Home keeps offering the choice.
import { $ } from '../lib/dom.js';
import { animateValue, reducedMotion } from '../lib/motion.js';
import { reportDataError } from '../lib/dataError.js';
import { toast } from '../lib/toast.js';
import { state } from '../state.js';
import { getRepo } from '../data/repository.js';
import { goalAchievement, goalCopy, parseNextGoal } from '../domain/goal.js';
import { PHASE_MS, createSequence, phasesFor } from '../domain/goalSequence.js';
import { closeOverlay, onOverlayClosed, openOverlay } from './overlays.js';
import { isBusy, withBusy } from './busy.js';
import { renderHome } from '../screens/home.js';

const ID = 'ov-reached';
let seq = null;
let timer = null;
let afterClose = null;
let copy = null;

const firstName = () => (state.user.name || '').trim().split(/\s+/)[0] || '';

function fill(a, c) {
  $('rc-num').textContent = c.weight.replace(' kg', '');
  $('rc-early').textContent = c.earlyBadge;
  $('rc-range').textContent = c.range;
  $('rc-change').textContent = c.change;
  $('rc-change-l').textContent = a.change >= 0 ? 'gained' : 'lost';
  $('rc-days').textContent = c.dayText;
  $('rc-pct').textContent = c.journeyLine;
  const name = firstName();
  $('rc-you').textContent = name ? `YOU DID IT, ${name.toUpperCase()}.` : 'YOU DID IT.';
  $('rc-reached').textContent = c.reachedLine;
  $('rc-trophy').textContent = c.trophyLine;
  $('rc-left').textContent = c.remaining > 0
    ? `You still have ${c.remaining} ${c.remaining === 1 ? 'day' : 'days'} left in your journey.`
    : 'Your journey is complete. Choose how to carry it forward.';
  $('rc-maintain-w').textContent = `${a.goalWeight} kg`;
}

/** Counts the big number from her starting weight up (or down) to the weight she reached. */
function countUp(a) {
  const el = $('rc-num');
  el._v = a.startWeight;
  animateValue(el, a.weight, (v) => v.toFixed(1), { duration: 2200 });
}

function announce(phase, a, c) {
  const text = {
    recognition: `Goal reached. ${c.weight}. ${c.earlyBadge.toLowerCase()}.`,
    recap: `${c.range}. ${c.change} in ${c.dayText}. ${c.journeyLine}.`,
    trophy: `Goal achieved. ${c.reachedLine}. ${c.trophyLine}.`,
    choices: 'Your original goal is complete. Choose what comes next.',
  }[phase];
  $('rc-live').textContent = text;
}

function render() {
  clearTimeout(timer);
  const phase = seq.phase;
  const root = $(ID).querySelector('.rc');
  root.dataset.phase = phase;
  root.querySelectorAll('.rc-phase').forEach((s) => {
    const on = s.dataset.phase === phase;
    s.hidden = !on;
    s.setAttribute('aria-hidden', String(!on));
  });
  const a = goalAchievement(state.user);
  const c = goalCopy(a);
  if (phase === 'recognition') countUp(a);
  announce(phase, a, c);
  const last = seq.last;
  $('rc-skip').hidden = last;
  $('rc-next').hidden = phase === 'choices';
  $('rc-next').textContent = last ? 'Done' : 'Continue';
  $('rc-later').hidden = phase !== 'choices';
  if (phase === 'choices') showOptions();
  const ms = PHASE_MS[phase];
  if (ms && !reducedMotion()) timer = setTimeout(goalNext, ms);
}

function showOptions() {
  $('rc-options').hidden = false;
  $('rc-newgoal').hidden = true;
}

/** Opens the experience. `replay` skips the choices; `choicesOnly` shows just the choices (used from Home). */
export function showGoalExperience({ replay = false, choicesOnly = false, onClose = null } = {}) {
  const a = goalAchievement(state.user);
  if (!a) return;
  copy = goalCopy(a);
  fill(a, copy);
  afterClose = onClose;
  seq = createSequence(phasesFor({ replay, choicesOnly }));
  $(ID).classList.toggle('still', reducedMotion());
  openOverlay(ID);
  render();
}

export function goalNext() {
  if (!seq) return;
  seq.advance();
  if (seq.finished) closeOverlay(ID);
  else render();
}

export function goalSkip() {
  if (!seq) return;
  seq.skip();
  render();
}

export const replayGoal = () => showGoalExperience({ replay: true });

/** Persists her choice, updates the working copy, and returns to Home. */
export async function applyPostGoal(mode, nextGoal = null, btn = null) {
  try {
    await withBusy(btn, 'Saving…', () => getRepo().setPostGoal(mode, nextGoal));
  } catch (e) {
    reportDataError(e, "Couldn't save your choice. Please try again.");
    return false;
  }
  const j = state.user.journey;
  j.postGoalMode = mode;
  j.nextGoal = mode === 'new_goal' ? nextGoal : null;
  renderHome();
  toast({ new_goal: `New goal set: ${nextGoal} kg`, maintain: `Maintaining ${j.goalWeight} kg`, journal: 'Journaling on. No weight goal.' }[mode]);
  return true;
}

/** From the choices (in the overlay or from Home): new goal opens the weight form, the others save straight away. */
export async function chooseGoalMode(mode, btn = null) {
  if (isBusy(btn)) return;
  if (mode === 'new_goal') {
    if (!$(ID).classList.contains('show')) showGoalExperience({ choicesOnly: true });
    $('rc-options').hidden = true;
    $('rc-newgoal').hidden = false;
    $('rc-newgoal-err').textContent = '';
    const input = $('rc-newgoal-input');
    input.value = state.user.journey.nextGoal || '';
    input.focus();
    return;
  }
  if (await applyPostGoal(mode, null, btn)) closeOverlay(ID);
}

export async function onNewGoalSubmit(e) {
  e.preventDefault();
  const r = parseNextGoal($('rc-newgoal-input').value, state.user.journey);
  $('rc-newgoal-err').textContent = r.ok ? '' : r.error;
  $('rc-newgoal-input').setAttribute('aria-invalid', String(!r.ok));
  if (!r.ok) return;
  const submit = $('rc-newgoal-save');
  if (isBusy(submit)) return;
  if (await applyPostGoal('new_goal', r.value, submit)) closeOverlay(ID);
}

onOverlayClosed(ID, () => {
  clearTimeout(timer);
  seq = null;
  const next = afterClose;
  afterClose = null;
  renderHome();
  if (next) next();
});
