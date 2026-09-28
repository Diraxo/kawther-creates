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
  MAX_MEALS_PER_DAY, MEAL_CATEGORIES, MEAL_LABELS, checkinGaps, cloneCheckin, emptyCheckin, formatLitres, mealCount, mealsWithAdded,
  mealsWithRemoved, mealsWithReplaced, nowTimeLabel, nowTimeValue, to12, to24,
} from '../domain/checkin.js';
import { MUSCLE_SUGGESTIONS, buildExercise, cleanMuscles, normalizeExercise, splitMinutes } from '../domain/movement.js';
import { currentDayIndex, lastLoggedWeight, waterGoalOf, waterMessage } from '../domain/journey.js';
import { calcStreak } from '../domain/streak.js';
import { ACH_DEFS } from '../domain/achievements.js';
import { go } from '../ui/router.js';
import { closeOverlay, openOverlay } from '../ui/overlays.js';
import { isBusy, withBusy } from '../ui/busy.js';
import { isOffline } from '../ui/network.js';
import { renderHome } from './home.js';
import { mealBodyHtml, mealEmptyHtml } from '../lib/mealView.js';

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
  loadMovementForm(draft.exercise); // today's saved movement, exactly as it was logged (or the rest state)
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
// A meal is saved the moment it is confirmed: it is written to today's check-in through the repository (the same
// save_checkin RPC, with only the meals changed), so it survives leaving the form and a reload, and the Journey reads
// the very same record. Every change is computed on a COPY (domain/checkin.js) and becomes the working state only after
// the backend confirmed it, so a failed save never leaves a meal on screen that was not stored.
let mealSaving = false; // one meal write at a time: a second would be computed from a stale list
/** Achievements the server granted while saving a meal: celebrated with the next full check-in save, never lost. */
const pendingUnlocks = new WeakMap();

async function persistMeals(next, btn) {
  const { user } = state;
  if (mealSaving) return false;
  if (isOffline()) { toast("You're offline. Reconnect to save this.", 4000); return false; }
  const d = todayStr();
  const base = user.checkins[d] ? cloneCheckin(user.checkins[d]) : emptyCheckin(); // the day as saved; only its meals change
  base.meals = next;
  mealSaving = true;
  let saved;
  try {
    saved = await withBusy(btn, 'Saving…', () => getRepo().saveCheckin(d, base));
  } catch (e) {
    reportDataError(e, "Couldn't save this meal. Please try again.");
    return false;
  } finally {
    mealSaving = false;
  }
  if (!saved) return false;
  user.checkins[d] = base;
  state.draft.meals = cloneCheckin({ meals: next }).meals;
  pendingUnlocks.set(user, [...(pendingUnlocks.get(user) || []), ...applyUnlocked(saved.unlocked)]);
  // The day now exists in the backend: the form is editing a saved check-in, and Home already reflects it.
  state.editingExisting = true;
  $('ci-status').hidden = false;
  $('ci-save-btn').textContent = 'Update check-in';
  renderHome();
  return true;
}

export function addMeal(cat) {
  if (mealCount(state.draft) >= MAX_MEALS_PER_DAY) { toast(`You can log up to ${MAX_MEALS_PER_DAY} meals a day.`, 4000); return; }
  state.meal = { category: cat, index: null };
  $('meal-name').value = '';
  $('meal-notes').value = '';
  $('meal-time').value = nowTimeValue();
  $('meal-modal-cat').textContent = MEAL_LABELS[cat]; // the destination is fixed by the section she tapped, and shown in the sheet
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
  $('meal-modal-cat').textContent = MEAL_LABELS[cat]; // editing never moves a meal to another section
  $('meal-modal-title').textContent = 'Edit meal';
  $('meal-delete-btn').style.display = 'block';
  openOverlay('ov-meal');
}

export async function confirmMeal(btn) {
  const name = $('meal-name').value.trim();
  if (!name) { $('meal-name').focus(); return; }
  const timeVal = $('meal-time').value;
  const obj = { name, notes: $('meal-notes').value.trim(), time: timeVal ? to12(timeVal) : nowTimeLabel() };
  const { category, index } = state.meal;
  const meals = state.draft.meals;
  const next = index != null ? mealsWithReplaced(meals, category, index, obj) : mealsWithAdded(meals, category, obj);
  if (!(await persistMeals(next, btn))) return; // the sheet stays open with what she typed
  renderMeals(category);
  closeOverlay('ov-meal');
}

export async function deleteMealFromModal(btn) {
  const { category, index } = state.meal;
  if (index == null) { closeOverlay('ov-meal'); return; }
  if (!(await persistMeals(mealsWithRemoved(state.draft.meals, category, index), btn))) return;
  renderMeals(category);
  closeOverlay('ov-meal');
}

export function renderMeals(cat) {
  const el = $('ci-meal-' + cat);
  el.innerHTML = '';
  const list = state.draft.meals[cat] || [];
  if (!list.length) el.innerHTML = mealEmptyHtml(cat);
  list.forEach((m, i) => {
    const row = document.createElement('div');
    row.className = 'meal-item';
    row.innerHTML = `<div class="meal-info" data-action="edit-meal" data-cat="${cat}" data-i="${i}" role="button" tabindex="0" aria-label="Edit ${esc(m.name)}">${mealBodyHtml(m)}</div><button class="meal-del" aria-label="Delete ${esc(m.name)}" data-action="ask-delete-meal" data-cat="${cat}" data-i="${i}">${TRASH_SVG}</button>`;
    el.appendChild(row);
  });
}

export function askDeleteMeal(btn, cat, i) {
  const row = btn.parentElement;
  row.classList.add('confirm');
  row.innerHTML = `<span class="meal-confirm-q">Delete this?</span><div class="meal-confirm-btns"><button class="mini-btn" data-action="do-delete-meal" data-cat="${cat}" data-i="${i}">Delete</button><button class="mini-btn ghost2" data-action="cancel-delete-meal" data-cat="${cat}">Cancel</button></div>`;
}

export async function doDeleteMeal(cat, i, btn) {
  await persistMeals(mealsWithRemoved(state.draft.meals, cat, i), btn);
  renderMeals(cat); // removed on success; if the save failed the meal row is simply restored
}

// ---------- movement ----------
// The form is DOM + state.exType / state.exMuscles. Only the fields that belong to the chosen type are shown, and
// buildExercise() (domain/movement.js) keeps only those on save, so nothing from another type can leak into a day.
const FIELD_IDS = ['ci-ex-hours', 'ci-ex-mins', 'ci-ex-distance', 'ci-ex-steps', 'ci-ex-desc'];
const ERROR_IDS = ['e-ci-ex-type', 'e-ci-ex-dur', 'e-ci-ex-distance', 'e-ci-ex-steps', 'e-ci-ex-desc'];
const TYPE_COPY = {
  Gym: { dur: 'How long did you train?' },
  Running: { dur: 'How long did you run?' },
  Walking: { dur: 'How long did you walk?' },
  'Home workout': { dur: 'How long did you work out?', desc: 'What did you do?', ph: 'e.g. Abs + 20 min cardio' },
  Other: { dur: 'How long?', desc: 'What did you do?', ph: 'Describe what you did...' },
};

function clearMovementErrors() {
  ERROR_IDS.forEach((id) => { $(id).textContent = ''; });
  FIELD_IDS.forEach((id) => $(id).removeAttribute('aria-invalid'));
}

/** Puts the saved movement (or the rest state) into the form. */
function loadMovementForm(exercise) {
  const ex = normalizeExercise(exercise);
  clearMovementErrors();
  FIELD_IDS.forEach((id) => { $(id).value = ''; });
  $('ci-ex-other').value = '';
  $('ci-ex-other-row').hidden = true;
  $('ci-ex-other-btn').setAttribute('aria-expanded', 'false');
  state.exMuscles = ex ? [...ex.muscles] : [];
  state.exType = null; // so the loaded values below are not treated as a type switch
  const { hours, minutes } = splitMinutes(ex ? ex.duration : null);
  $('ci-ex-hours').value = hours;
  $('ci-ex-mins').value = minutes;
  if (ex) {
    $('ci-ex-distance').value = ex.distance == null ? '' : String(ex.distance);
    $('ci-ex-steps').value = ex.steps == null ? '' : String(ex.steps);
    $('ci-ex-desc').value = ex.description;
  }
  setMoved(!!ex);
  applyMovementType(ex ? ex.type : null);
}

function setMoved(yes) {
  [['ci-ex-yes', yes], ['ci-ex-no', !yes]].forEach(([id, on]) => {
    $(id).classList.toggle('on', on);
    $(id).setAttribute('aria-pressed', String(on));
  });
  $('ci-ex-detail').hidden = !yes;
  $('ci-ex-rest').hidden = yes;
}

/** "I moved today" / "Rest day". Rest hides every movement field; nothing typed is sent for a rest day. */
export function setExercise(yes) {
  setMoved(yes);
  if (!yes) clearMovementErrors();
}

/** Shows only the chosen type's fields. */
function applyMovementType(type) {
  state.exType = type;
  $$('#ci-ex-type .mv-chip').forEach((b, i) => {
    const on = b.dataset.type === type;
    b.setAttribute('aria-checked', String(on));
    b.classList.toggle('on', on);
    b.tabIndex = on || (!type && i === 0) ? 0 : -1; // roving focus: the radio group is one tab stop
  });
  $('ci-ex-fields').hidden = !type;
  if (!type) return;
  const copy = TYPE_COPY[type];
  $('ci-ex-dur-q').textContent = copy.dur;
  $('ci-ex-f-gym').hidden = type !== 'Gym';
  $('ci-ex-f-run').hidden = type !== 'Running';
  $('ci-ex-f-walk').hidden = type !== 'Walking';
  $('ci-ex-f-desc').hidden = !copy.desc;
  if (copy.desc) {
    $('ci-ex-desc-q').innerHTML = `${copy.desc} <em>Optional</em>`;
    $('ci-ex-desc').placeholder = copy.ph;
  }
  if (type === 'Gym') renderMuscles();
}

/** Switching type keeps the duration (it applies to every type) and clears the details the new type does not use. */
export function pickMovementType(type) {
  if (type !== state.exType) {
    if (type !== 'Gym') { state.exMuscles = []; $('ci-ex-other').value = ''; }
    if (type !== 'Running') $('ci-ex-distance').value = '';
    if (type !== 'Walking') $('ci-ex-steps').value = '';
    $('ci-ex-desc').value = ''; // Home workout <-> Other keep nothing either: it is a different description
    const dur = ['ci-ex-hours', 'ci-ex-mins'];
    ERROR_IDS.forEach((id) => { $(id).textContent = ''; });
    [...FIELD_IDS].filter((id) => !dur.includes(id)).forEach((id) => $(id).removeAttribute('aria-invalid'));
  }
  $('e-ci-ex-type').textContent = '';
  applyMovementType(type);
}

// ----- muscle groups (Gym): suggested chips + any custom text, multiple selection -----
function renderMuscles() {
  const chosen = state.exMuscles.map((m) => m.toLowerCase());
  $$('#ci-ex-muscles [data-action="toggle-muscle"]').forEach((b) => {
    if (b.classList.contains('custom')) return;
    const on = chosen.includes(b.dataset.muscle.toLowerCase());
    b.setAttribute('aria-checked', String(on));
    b.classList.toggle('on', on);
  });
  const suggested = MUSCLE_SUGGESTIONS.map((m) => m.toLowerCase());
  $('ci-ex-custom-chips').innerHTML = state.exMuscles
    .filter((m) => !suggested.includes(m.toLowerCase()))
    .map((m) => `<button type="button" class="mv-chip sm on custom" role="checkbox" aria-checked="true" aria-label="${esc(m)}, custom. Tap to remove" data-action="toggle-muscle" data-muscle="${esc(m)}">${esc(m)}<span aria-hidden="true"> ×</span></button>`)
    .join('');
}

export function toggleMuscle(name) {
  const key = name.toLowerCase();
  const has = state.exMuscles.some((m) => m.toLowerCase() === key);
  state.exMuscles = has ? state.exMuscles.filter((m) => m.toLowerCase() !== key) : cleanMuscles([...state.exMuscles, name]);
  renderMuscles();
}

export function toggleOtherMuscle() {
  const row = $('ci-ex-other-row');
  row.hidden = !row.hidden;
  $('ci-ex-other-btn').setAttribute('aria-expanded', String(!row.hidden));
  if (!row.hidden) $('ci-ex-other').focus();
}

/** Adds what was typed as custom muscle group(s) ("Forearms, Calves" adds both). */
export function addCustomMuscle() {
  const input = $('ci-ex-other');
  state.exMuscles = cleanMuscles([...state.exMuscles, ...input.value.split(/[,;\n]/)]);
  input.value = '';
  renderMuscles();
  input.focus();
}

export function onMovementKeydown(e) {
  if (e.target.id === 'ci-ex-other' && e.key === 'Enter') { e.preventDefault(); addCustomMuscle(); return; }
  // Arrow keys move through the movement types, like any radio group.
  if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key) || !e.target.closest) return;
  const chips = $$('#ci-ex-type .mv-chip');
  const i = chips.indexOf(e.target);
  if (i < 0) return;
  e.preventDefault();
  const next = chips[(i + (['ArrowRight', 'ArrowDown'].includes(e.key) ? 1 : chips.length - 1)) % chips.length];
  next.focus();
  pickMovementType(next.dataset.type);
}

/** Reads the form -> { ok, exercise } (exercise null = rest day). Errors are shown only for values that are actually wrong. */
function readMovementForm() {
  if ($('ci-ex-no').classList.contains('on')) return { ok: true, exercise: null };
  if (!state.exType) {
    $('e-ci-ex-type').textContent = 'Choose what you did, or switch to Rest day.';
    $$('#ci-ex-type .mv-chip')[0].focus();
    return { ok: false };
  }
  if (state.exType === 'Gym' && $('ci-ex-other').value.trim()) addCustomMuscle(); // typed but not added yet: keep it, never lose it
  const r = buildExercise({
    type: state.exType, hours: $('ci-ex-hours').value, minutes: $('ci-ex-mins').value, muscles: state.exMuscles,
    distance: $('ci-ex-distance').value, steps: $('ci-ex-steps').value, description: $('ci-ex-desc').value,
  });
  if (r.ok) return r;
  clearMovementErrors();
  const where = {
    duration: ['e-ci-ex-dur', 'ci-ex-hours'], distance: ['e-ci-ex-distance', 'ci-ex-distance'],
    steps: ['e-ci-ex-steps', 'ci-ex-steps'], description: ['e-ci-ex-desc', 'ci-ex-desc'],
  };
  let first = null;
  Object.entries(r.errors).forEach(([k, msg]) => {
    $(where[k][0]).textContent = msg;
    $(where[k][1]).setAttribute('aria-invalid', 'true');
    first = first || $(where[k][1]);
  });
  if (first) first.focus();
  return { ok: false };
}

// ---------- save ----------
export async function saveCheckin(btn) {
  const { user } = state;
  btn = btn || $('ci-save-btn');
  const draft = state.draft;
  if (isBusy(btn)) return;

  // Validate first (nothing is sent, nothing is disabled, if the form isn't valid).
  const movement = readMovementForm();
  if (!movement.ok) return;
  draft.exercise = movement.exercise;
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
  const queued = pendingUnlocks.get(user) || []; // granted while saving meals: celebrated now, with this save
  pendingUnlocks.delete(user);
  const unlocked = [...queued, ...applyUnlocked(saved.unlocked)];
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
