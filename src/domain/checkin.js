// Check-in shape and helpers (pure).
import { formatExercise } from './movement.js';

export const MEAL_CATEGORIES = ['breakfast', 'lunch', 'dinner', 'snacks'];
export const MOODS = ['great', 'good', 'okay', 'tired', 'low'];

export function emptyCheckin() {
  return {
    mood: null,
    weight: null,
    water: 0,
    meals: { breakfast: [], lunch: [], dinner: [], snacks: [] },
    exercise: null,
    notes: '',
  };
}

export function cloneCheckin(c) {
  return JSON.parse(JSON.stringify(c));
}

export function nowTimeValue(d = new Date()) {
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/** '8:30 AM' -> '08:30' (falls back to the current time on bad input). */
export function to24(label) {
  const m = (label || '').match(/(\d+):(\d+)\s*([AP]M)/i);
  if (!m) return nowTimeValue();
  let h = parseInt(m[1], 10) % 12;
  if (/pm/i.test(m[3])) h += 12;
  return String(h).padStart(2, '0') + ':' + m[2];
}

/** '08:30' -> '8:30 AM' */
export function to12(val) {
  const [h, mi] = val.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  let hh = h % 12;
  if (hh === 0) hh = 12;
  return `${hh}:${String(mi).padStart(2, '0')} ${ap}`;
}

export function nowTimeLabel() {
  return to12(nowTimeValue());
}

// Movement (type, optional duration + details) lives in ./movement.js; formatExercise is re-exported for existing callers.
export { formatExercise };

/** Litres for display: 1.5 -> "1.5 L", 5 -> "5 L", 2.25 -> "2.25 L" (goal/amount, never rounded to misleading precision). */
export function formatLitres(ml) {
  return `${Number((ml / 1000).toFixed(2))} L`;
}

/** Number of meals logged across every category. */
export function mealCount(c) {
  return Object.values(c.meals || {}).reduce((n, list) => n + list.length, 0);
}

export const MEAL_LABELS = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snacks: 'Snacks' };
/** The database refuses more than this many meals for one day (save_checkin), so the form says so first. */
export const MAX_MEALS_PER_DAY = 30;

function assertCategory(cat) {
  if (!MEAL_CATEGORIES.includes(cat)) throw new Error(`Unknown meal section: ${cat}`);
}

/** A meals object is never mutated: each change returns a new one, so a failed save leaves the working copy untouched. */
function copyMeals(meals) {
  const out = {};
  MEAL_CATEGORIES.forEach((cat) => { out[cat] = [...((meals || {})[cat] || [])]; });
  return out;
}

/** `meal` joins the END of ITS OWN section (`cat` is explicit, never inferred from the name); every other meal is kept. */
export function mealsWithAdded(meals, cat, meal) {
  assertCategory(cat);
  const out = copyMeals(meals);
  out[cat].push(meal);
  return out;
}

/** Replaces the meal at `index` inside `cat`: same section, same position, no duplicate. */
export function mealsWithReplaced(meals, cat, index, meal) {
  assertCategory(cat);
  const out = copyMeals(meals);
  if (!out[cat][index]) throw new Error('That meal no longer exists.');
  out[cat][index] = meal;
  return out;
}

/** Removes only the meal at `index` inside `cat`. */
export function mealsWithRemoved(meals, cat, index) {
  assertCategory(cat);
  const out = copyMeals(meals);
  if (!out[cat][index]) throw new Error('That meal no longer exists.');
  out[cat].splice(index, 1);
  return out;
}

/** The saved meals of a day grouped for display, in the canonical order, sections with no meals left out. */
export function mealGroups(c) {
  return MEAL_CATEGORIES
    .map((cat) => ({ cat, label: MEAL_LABELS[cat], items: (c && c.meals && c.meals[cat]) || [] }))
    .filter((g) => g.items.length);
}

/**
 * What a saved check-in still leaves open, for the completion sheet. The check-in itself is always "complete" once
 * saved; this only reports personal goals that are unfinished (or done). Only applicable items are returned.
 * -> [{ id, done, text }]
 */
export function checkinGaps(c, waterGoalMl) {
  const items = [];
  const water = c.water || 0;
  if (water < waterGoalMl) {
    const left = Number(((waterGoalMl - water) / 1000).toFixed(2));
    items.push({ id: 'water', done: false, text: `Hydration: ${formatLitres(water)} / ${formatLitres(waterGoalMl)} — ${left} L to go` });
  } else {
    items.push({ id: 'water', done: true, text: `Hydration goal reached: ${formatLitres(water)} / ${formatLitres(waterGoalMl)}` });
  }
  if (c.exercise) items.push({ id: 'move', done: true, text: `Workout complete: ${formatExercise(c.exercise)}` });
  if (mealCount(c) === 0) items.push({ id: 'meals', done: false, text: 'Meals: Nothing logged yet' });
  if (!c.weight) items.push({ id: 'weight', done: false, text: 'Weight: not logged today' });
  return items;
}
