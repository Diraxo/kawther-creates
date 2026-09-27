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
