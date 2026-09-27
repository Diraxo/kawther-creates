import { $, $$ } from '../lib/dom.js';
import { reducedMotion } from '../lib/motion.js';
import { esc } from '../lib/format.js';
import { CHECK_SVG, OPEN_SVG, TRASH_SVG } from '../lib/icons.js';
import { toast } from '../lib/toast.js';
import { reportDataError } from '../lib/dataError.js';
import { celebrateAchievements } from '../ui/milestones.js';
import { showGoalExperience } from '../ui/goalExperience.js';
import { maybeCelebrateJourneyComplete } from '../ui/journeyComplete.js';
import { state } from '../state.js';
import { getRepo } from '../data/repository.js';
import { todayStr } from '../domain/dates.js';
import {
  MEAL_CATEGORIES, checkinGaps, cloneCheckin, durationInputValue, emptyCheckin, formatLitres, nowTimeLabel, nowTimeValue,
  parseExerciseDuration, to12, to24,
} from '../domain/checkin.js';
import { currentDayIndex, lastLoggedWeight, waterGoalOf, waterMessage } from '../domain/journey.js';
import { calcStreak } from '../domain/streak.js';
import { ACH_DEFS } from '../domain/achievements.js';
import { go } from '../ui/router.js';
import { closeOverlay, openOverlay } from '../ui/overlays.js';
import { isBusy, withBusy } from '../ui/busy.js';
import { isOffline } from '../ui/network.js';
import { renderHome } from './home.js';

// ---------- open / mood ----------
/**
 * Opens today's check-in. It ALWAYS inspects today's real check-in first: if one exists (loaded from Supabase into
 * state.user.checkins) the form opens in EDIT mode with every saved field, and saving updates that same row
 * (save_checkin upserts on (user_id, checkin_date)); otherwise it opens empty.
 */
export function openCheckin() {
  const { user } = state;
  const d = todayStr();
  const existing = user.checkins[d];
  state.editingExisting = !!existing;
  state.draft = existing ? cloneCheckin(existing) : emptyCheckin();
  const draft = state.draft;
  $('ci-title').textContent = "Today's check-in";
  $('ci-status').hidden = !existing;
  $('ci-save-btn').textContent = existing ? 'Update check-in' : 'Save check-in';
  $$('#ci-mood .mood').forEach((m) => m.classList.toggle('sel', m.dataset.m === draft.mood));
  // Editing today's saved check-in shows TODAY's saved weight. A brand-new check-in starts from the last weight she
  // actually logged (real repository data), so she only nudges it. Nothing is written until she taps Save.
  const logged = lastLoggedWeight(user);
  const carried = !existing && logged ? logged : null;
  $('ci-weight').value = existing ? (draft.weight || '') : (carried || '');
  $('ci-weight-prev').textContent = carried
    ? `From your last logged weight (${carried.toFixed(1)} kg). Adjust it if today is different.`
    : logged ? `Last logged: ${logged.toFixed(1)} kg` : `Starting weight: ${user.journey.startWeight.toFixed(1)} kg`;
  $('ci-notes').value = draft.notes || '';
  $('e-ci-water').textContent = '';
  updateWaterUI(true);
  MEAL_CATEGORIES.forEach(renderMeals);
  $('e-ci-ex-dur').textContent = '';
  $('ci-ex-dur').removeAttribute('aria-invalid');
  if (draft.exercise) {
    $('ci-ex-yes').classList.add('on');
    $('ci-ex-no').classList.remove('on');
    $('ci-ex-detail').style.display = 'block';
    $('ci-ex-type').value = draft.exercise.type;
    setUnitUI(draft.exercise.unit || 'minutes');
    $('ci-ex-dur').value = durationInputValue(draft.exercise); // the entry's own unit, exactly as it was saved
  } else {
    $('ci-ex-no').classList.add('on');
    $('ci-ex-yes').classList.remove('on');
    $('ci-ex-detail').style.display = 'none';
    $('ci-ex-type').selectedIndex = 0;
    setUnitUI('minutes');
    $('ci-ex-dur').value = '';
  }
  go('s-checkin');
}

export function pickMood(el) {
  $$('#ci-mood .mood').forEach((m) => m.classList.remove('sel'));
  el.classList.add('sel');
  state.draft.mood = el.dataset.m;
}

// ---------- hydration ----------
export function adjWater(n) {
  state.draft.water = Math.max(0, (state.draft.water || 0) + n);
  updateWaterUI(true);
}

const MAX_WATER_ML = 20000;

/** Typing in the litres field: keep digits + one decimal separator, mirror into the draft. */
export function onWaterInput() {
  const input = $('ci-water-input');
  const cleaned = input.value.replace(',', '.').replace(/[^\d.]/g, '').replace(/^(\d*\.\d*).*$/, '$1');
  if (cleaned !== input.value) input.value = cleaned;
  const v = parseFloat(cleaned);
  state.draft.water = Number.isFinite(v) ? Math.min(MAX_WATER_ML, Math.round(v * 1000)) : 0;
  $('e-ci-water').textContent = '';
  updateWaterUI(false);
}

/** 0.25 -> "0.25", 1.5 -> "1.5", 0 -> "0". */
const litresText = (ml) => String(Number((ml / 1000).toFixed(2)));

/** The number hugs its own digits, so "0.25 L / 5 L" reads as one compact metric (no fixed-width gap after the value). */
function fitWaterInput() {
  const input = $('ci-water-input');
  const shown = input.value || input.placeholder || '0';
  input.style.width = `${Math.max(1, shown.length) + 0.4}ch`;
}

/** `writeInput`: also rewrite the field (buttons/open); false while the user is typing in it. */
function updateWaterUI(writeInput) {
  const goal = waterGoalOf(state.user.journey);
  const water = state.draft.water || 0;
  if (writeInput) $('ci-water-input').value = water ? litresText(water) : '';
  fitWaterInput();
  $('ci-water-goal-num').textContent = String(Number((goal / 1000).toFixed(2)));
  $('ci-water-goal-label').textContent = formatLitres(goal);
  const { ratio, text, goalHit } = waterMessage(water, goal);
  $('ci-water-track').style.width = Math.min(100, ratio * 100) + '%';
  $('ci-water-msg').textContent = text;
  $('ci-water-msg').classList.toggle('goalhit', goalHit);
}

export function openGoalEdit() {
  $('goal-input').value = (waterGoalOf(state.user.journey) / 1000).toFixed(1);
  openOverlay('ov-goal');
}

export async function saveGoal(btn) {
  if (isBusy(btn)) return;
  const v = parseFloat($('goal-input').value);
  if (!v || v < 0.5 || v > 6) return;
  if (isOffline()) { toast("You're offline. Reconnect to save this.", 4000); return; }
  const ml = Math.round(v * 1000);
  try {
    await withBusy(btn, 'Saving…', () => getRepo().updateWaterGoal(ml));
  } catch (e) {
    reportDataError(e, "Couldn't save your goal. Please try again.");
    return;
  }
  state.user.journey.waterGoal = ml;
  updateWaterUI(false);
  closeOverlay('ov-goal');
}

// ---------- meals ----------
export function addMeal(cat) {
  state.meal = { category: cat, index: null };
  $('meal-name').value = '';
  $('meal-notes').value = '';
  $('meal-time').value = nowTimeValue();
  $('meal-modal-title').textContent = 'What did you eat?';
  $('meal-delete-btn').style.display = 'none';
  openOverlay('ov-meal');
}

export function editMeal(cat, i) {
  state.meal = { category: cat, index: i };
  const m = state.draft.meals[cat][i];
  $('meal-name').value = m.name;
  $('meal-notes').value = m.notes || '';
  $('meal-time').value = to24(m.time);
  $('meal-modal-title').textContent = 'Edit meal';
  $('meal-delete-btn').style.display = 'block';
  openOverlay('ov-meal');
}

export function confirmMeal() {
  const name = $('meal-name').value.trim();
  if (!name) return;
  const timeVal = $('meal-time').value;
  const obj = { name, notes: $('meal-notes').value.trim(), time: timeVal ? to12(timeVal) : nowTimeLabel() };
  const { category, index } = state.meal;
  if (index != null) state.draft.meals[category][index] = obj;
  else state.draft.meals[category].push(obj);
  renderMeals(category);
  closeOverlay('ov-meal');
}

export function deleteMealFromModal() {
  const { category, index } = state.meal;
  if (index != null) {
    state.draft.meals[category].splice(index, 1);
    renderMeals(category);
  }
  closeOverlay('ov-meal');
}

export function renderMeals(cat) {
  const el = $('ci-meal-' + cat);
  el.innerHTML = '';
  if (!(state.draft.meals[cat] || []).length) el.innerHTML = '<div class="meal-empty">Nothing logged yet</div>';
  (state.draft.meals[cat] || []).forEach((m, i) => {
    const row = document.createElement('div');
    row.className = 'meal-item';
    row.innerHTML = `<div class="meal-info" data-action="edit-meal" data-cat="${cat}" data-i="${i}" role="button" tabindex="0"><span>${esc(m.name)}</span><span style="color:var(--sub)">${esc(m.time)}</span></div><button class="meal-del" aria-label="Delete ${esc(m.name)}" data-action="ask-delete-meal" data-cat="${cat}" data-i="${i}">${TRASH_SVG}</button>`;
    el.appendChild(row);
  });
}

export function askDeleteMeal(btn, cat, i) {
  const row = btn.parentElement;
  row.classList.add('confirm');
  row.innerHTML = `<span style="color:var(--danger); font-weight:600;">Delete this?</span><div style="display:flex; gap:8px;"><button class="mini-btn" data-action="do-delete-meal" data-cat="${cat}" data-i="${i}">Delete</button><button class="mini-btn ghost2" data-action="cancel-delete-meal" data-cat="${cat}">Cancel</button></div>`;
}

export function doDeleteMeal(cat, i) {
  state.draft.meals[cat].splice(i, 1);
  renderMeals(cat);
}

// ---------- exercise ----------
export function setExercise(yes) {
  $('ci-ex-yes').classList.toggle('on', yes);
  $('ci-ex-no').classList.toggle('on', !yes);
  $('ci-ex-detail').style.display = yes ? 'block' : 'none';
  if (!yes) state.draft.exercise = null;
}

function setUnitUI(unit) {
  state.exUnit = unit;
  ['minutes', 'hours'].forEach((u) => {
    const b = $('ci-ex-unit-' + u);
    b.classList.toggle('on', u === unit);
    b.setAttribute('aria-checked', String(u === unit));
  });
  $('ci-ex-dur').placeholder = unit === 'hours' ? 'e.g. 1.5' : 'e.g. 30';
}

/** Switching unit converts what was typed (90 minutes -> 1.5 hours) so nobody converts in their head. */
export function setExUnit(unit) {
  const input = $('ci-ex-dur');
  const before = parseExerciseDuration(input.value, state.exUnit);
  setUnitUI(unit);
  if (before.ok) input.value = durationInputValue({ duration: before.minutes, unit });
  $('e-ci-ex-dur').textContent = '';
  input.removeAttribute('aria-invalid');
}

// ---------- save ----------
export async function saveCheckin(btn) {
  const { user } = state;
  btn = btn || $('ci-save-btn');
  const draft = state.draft;
  if (isBusy(btn)) return;

  // Validate first (nothing is sent, nothing is disabled, if the form isn't valid).
  if ($('ci-ex-yes').classList.contains('on')) {
    const r = parseExerciseDuration($('ci-ex-dur').value, state.exUnit);
    if (!r.ok) {
      $('e-ci-ex-dur').textContent = r.error;
      $('ci-ex-dur').setAttribute('aria-invalid', 'true');
      $('ci-ex-dur').focus();
      return;
    }
    draft.exercise = { type: $('ci-ex-type').value, duration: r.minutes, unit: state.exUnit };
  }
  const waterRaw = $('ci-water-input').value.trim();
  if (waterRaw !== '' && !/^(\d+\.?\d*|\.\d+)$/.test(waterRaw)) {
    $('e-ci-water').textContent = 'Enter litres like 1.5.';
    $('ci-water-input').focus();
    return;
  }
  if (isOffline()) {
    toast("You're offline. Reconnect to save this.", 4000); // never pretend it was saved; the draft stays on screen
    return;
  }

  const typedWeight = parseFloat($('ci-weight').value);
  // The weight field is what she sees (typed, or carried over from her last logged weight): that is what is saved.
  draft.weight = (typedWeight ? Math.round(typedWeight * 10) / 10 : null) || draft.weight || null;
  draft.notes = $('ci-notes').value.trim();
  const d = todayStr();
  const wasExisting = !!user.checkins[d];
  const prevWater = user.checkins[d] ? user.checkins[d].water || 0 : 0;

  let saved;
  try {
    saved = await withBusy(btn, wasExisting ? 'Updating…' : 'Saving…', () => getRepo().saveCheckin(d, draft));
  } catch (e) {
    reportDataError(e, "Couldn't save your check-in. Please try again."); // draft stays; nothing is shown as saved
    return;
  }
  if (!saved) return; // a second tap while the first save was in flight
  // Confirmed persisted: update the working copy and Home NOW, so nothing depends on a later navigation.
  user.checkins[d] = cloneCheckin(draft);
  const unlocked = applyUnlocked(saved.unlocked);
  renderHome();
  const streak = calcStreak(user.checkins, d);
  const goal = waterGoalOf(user.journey);
  $('cel-eyebrow').textContent = wasExisting ? 'Check-in updated' : 'Check-in complete';
  $('cel-streak').textContent = `Day ${currentDayIndex(user.journey, d)} of ${user.journey.duration} · ${streak} day streak`;
  // What is still open (or done) against the user's own goals: informative, never "you failed".
  $('cel-list').innerHTML = checkinGaps(draft, goal)
    .map((g) => `<li class="${g.done ? 'done' : 'open'}" data-gap="${g.id}">${g.done ? CHECK_SVG : OPEN_SVG}<span>${esc(g.text)}</span></li>`)
    .join('');
  openOverlay('ov-celebrate');
  if ((draft.water || 0) >= goal && prevWater < goal) setTimeout(() => toast('Hydration goal complete'), 700);
  celebrateUnlocked(unlocked);
  maybeCelebrateJourneyComplete();
}

/**
 * Celebrates what the DATABASE granted with this save. The browser never decides or persists an achievement: the server
 * derives them from the saved rows (supabase/schema.sql), so anything it did not grant is not celebrated.
 * The goal is dated to the day the weight was actually reached (not necessarily today), as reported by the server.
 */
function applyUnlocked(granted) {
  const { user } = state;
  const unlocked = [];
  for (const g of granted) {
    const a = ACH_DEFS.find((x) => x.id === g.id);
    if (!a || user.unlocked.includes(a.id)) continue;
    user.unlocked.push(a.id);
    user.unlockedDates[a.id] = g.date;
    unlocked.push(a);
  }
  return unlocked;
}

function celebrateUnlocked(unlocked) {
  const goalUnlocked = unlocked.find((a) => a.id === 'goal');
  const ordinary = unlocked.filter((a) => a.id !== 'goal');
  if (!goalUnlocked) { celebrateAchievements(ordinary); return; } // queued: shown one after another, in unlock order
  // The Goal Achievement Experience takes the whole screen; the small unlocks wait until it closes.
  setTimeout(() => showGoalExperience({ onClose: () => celebrateAchievements(ordinary) }), reducedMotion() ? 0 : 900);
}
