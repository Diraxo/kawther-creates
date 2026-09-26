// Domain <-> Supabase row mapping. Pure functions, unit-tested; the Supabase
// repository is just I/O around these. Column names match supabase/schema.sql.
import { MEAL_CATEGORIES, to12, to24 } from '../domain/checkin.js';

export function journeyToRow(userId, j) {
  return {
    user_id: userId,
    start_date: j.start,
    duration_days: j.duration,
    start_weight: j.startWeight,
    goal_weight: j.goalWeight,
    water_goal_ml: j.waterGoal,
  };
}

export function rowToJourney(r) {
  return {
    completedOn: r.completed_on ?? null, // set once the next journey has started; a completed journey is never edited
    start: r.start_date,
    duration: r.duration_days,
    startWeight: Number(r.start_weight),
    goalWeight: Number(r.goal_weight),
    waterGoal: r.water_goal_ml,
    // Set after the original goal is achieved (see domain/goal.js); null until she chooses.
    postGoalMode: r.post_goal_mode ?? null,
    nextGoal: r.next_goal_weight == null ? null : Number(r.next_goal_weight),
  };
}

/** Columns written by `setPostGoal`. `new_goal` carries a weight; the other modes clear it. */
export function postGoalToRow(mode, nextGoal) {
  return { post_goal_mode: mode, next_goal_weight: mode === 'new_goal' ? nextGoal : null };
}

/** One check-in -> the checkins row plus its meal rows (checkin_id is added by the caller). */
export function checkinToRows(userId, date, c) {
  const meals = [];
  MEAL_CATEGORIES.forEach((cat) => {
    (c.meals[cat] || []).forEach((m, position) => {
      meals.push({
        user_id: userId,
        category: cat,
        name: m.name,
        notes: m.notes || '',
        eaten_at: to24(m.time),
        position,
      });
    });
  });
  return {
    checkin: {
      user_id: userId,
      checkin_date: date,
      mood: c.mood || null,
      weight_kg: c.weight ?? null,
      water_ml: c.water || 0,
      exercise_type: c.exercise ? c.exercise.type : null,
      exercise_minutes: c.exercise ? c.exercise.duration : null,
      exercise_unit: c.exercise ? c.exercise.unit || 'minutes' : 'minutes',
      notes: c.notes || '',
    },
    meals,
  };
}

/** Payload for the atomic `save_checkin` RPC (supabase/schema.sql): the day's row plus its meals. */
export function checkinToPayload(c) {
  const { checkin, meals } = checkinToRows(null, null, c);
  return {
    mood: checkin.mood,
    weight_kg: checkin.weight_kg,
    water_ml: checkin.water_ml,
    exercise_type: checkin.exercise_type,
    exercise_minutes: checkin.exercise_minutes,
    exercise_unit: checkin.exercise_unit,
    notes: checkin.notes,
    meals: meals.map(({ category, name, notes, eaten_at, position }) => ({ category, name, notes, eaten_at, position })),
  };
}

/** Arguments for the `create_journey` RPC. */
export function journeyToRpcArgs(j) {
  return {
    p_start: j.start,
    p_duration: j.duration,
    p_start_weight: j.startWeight,
    p_goal_weight: j.goalWeight,
    p_water_goal: j.waterGoal,
  };
}

/** checkins rows + meal rows -> { 'YYYY-MM-DD': checkin } */
export function rowsToCheckins(checkinRows, mealRows) {
  const byCheckin = new Map();
  [...mealRows]
    .sort((a, b) => a.position - b.position)
    .forEach((m) => {
      if (!byCheckin.has(m.checkin_id)) byCheckin.set(m.checkin_id, []);
      byCheckin.get(m.checkin_id).push(m);
    });
  const out = {};
  checkinRows.forEach((r) => {
    const meals = { breakfast: [], lunch: [], dinner: [], snacks: [] };
    (byCheckin.get(r.id) || []).forEach((m) => {
      meals[m.category].push({ name: m.name, notes: m.notes || '', time: to12(String(m.eaten_at).slice(0, 5)) });
    });
    out[r.checkin_date] = {
      mood: r.mood,
      weight: r.weight_kg == null ? null : Number(r.weight_kg),
      water: r.water_ml,
      meals,
      exercise: r.exercise_type
        ? { type: r.exercise_type, duration: r.exercise_minutes || 0, unit: r.exercise_unit === 'hours' ? 'hours' : 'minutes' }
        : null,
      notes: r.notes || '',
    };
  });
  return out;
}

/** Achievements that belong to ONE journey: an unlock dated before the current journey began is history, not current. */
export const JOURNEY_SCOPED = ['goal', 'journey'];

/** Picks the active journey (and the completed ones, oldest first) out of a user's journey rows. */
export function splitJourneys(rows) {
  const all = [...rows].sort((a, b) => (a.start_date < b.start_date ? -1 : a.start_date > b.start_date ? 1 : 0)).map(rowToJourney);
  return { journey: all.find((j) => !j.completedOn) || null, past: all.filter((j) => j.completedOn) };
}

/** Arguments for the `start_next_journey` RPC. `mode` is the chapter kind chosen on the Journey Complete screen. */
export function nextJourneyToRpcArgs(j, mode) {
  return { ...journeyToRpcArgs(j), p_mode: mode };
}

export function rowsToAchievements(rows, journey = null) {
  const unlocked = [];
  const unlockedDates = {};
  rows.forEach((r) => {
    if (journey && JOURNEY_SCOPED.includes(r.achievement_id) && r.unlocked_on < journey.start) return;
    unlocked.push(r.achievement_id);
    unlockedDates[r.achievement_id] = r.unlocked_on;
  });
  return { unlocked, unlockedDates };
}
