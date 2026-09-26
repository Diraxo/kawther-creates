// Check-in shape and helpers (pure).
export const MEAL_CATEGORIES = ['breakfast', 'lunch', 'dinner', 'snacks'];
export const MOODS = ['great', 'good', 'okay', 'tired', 'low'];
export const WORKOUT_TYPES = ['Walking', 'Running', 'Gym', 'Home workout', 'Other'];

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

// ---------- movement duration ----------
// Stored canonically as WHOLE MINUTES (exercise_minutes) plus the unit the user chose (exercise_unit), so the entry
// is shown back exactly as typed: "1 hr" stays "1 hr", "90 min" stays "90 min", "1.5 hr" stays "1.5 hr".
export const EXERCISE_UNITS = ['minutes', 'hours'];
export const MAX_EXERCISE_MINUTES = 1440;

/** Validates typed text for the given unit. Hours may be decimal (up to 2 places). -> { ok, minutes } | { ok:false, error } */
export function parseExerciseDuration(raw, unit) {
  const s = String(raw ?? '').trim().replace(',', '.');
  if (s === '') return { ok: false, error: 'Enter how long you moved.' };
  if (unit === 'hours') {
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return { ok: false, error: 'Use hours like 1 or 1.5.' };
  } else if (!/^\d+$/.test(s)) return { ok: false, error: 'Use whole minutes.' };
  const minutes = Math.round(Number(s) * (unit === 'hours' ? 60 : 1));
  if (minutes < 1) return { ok: false, error: 'Duration must be more than zero.' };
  if (minutes > MAX_EXERCISE_MINUTES) return { ok: false, error: 'That is more than 24 hours.' };
  return { ok: true, minutes };
}

/** The number to put back in the input when editing (in the entry's own unit). */
export function durationInputValue(ex) {
  if (!ex) return '';
  return ex.unit === 'hours' ? String(Number((ex.duration / 60).toFixed(2))) : String(ex.duration);
}

/** Human display in the entry's own unit: "30 min", "90 min", "1 hr", "1.5 hr". */
export function formatExerciseDuration(ex) {
  if (!ex) return '';
  return ex.unit === 'hours' ? `${durationInputValue(ex)} hr` : `${ex.duration} min`;
}

/** "Walking · 30 min" */
export function formatExercise(ex) {
  return ex ? `${ex.type} · ${formatExerciseDuration(ex)}` : '';
}

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
