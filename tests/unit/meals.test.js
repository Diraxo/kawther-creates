// Meals: every meal belongs to the section it was added from, sections stay separate, changes never touch other meals,
// what is written to the database keeps the section, what is read back is grouped by it, and nothing about a meal's
// visibility depends on an animation. (The browser lifecycle is in tests/e2e/meals.mjs.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MAX_MEALS_PER_DAY, MEAL_CATEGORIES, emptyCheckin, mealCount, mealGroups, mealsWithAdded, mealsWithRemoved, mealsWithReplaced,
} from '../../src/domain/checkin.js';
import { checkinToPayload, rowsToCheckins } from '../../src/data/mappers.js';
import { mealEmptyHtml, mealGroupsHtml } from '../../src/lib/mealView.js';

const meal = (name, time = '8:30 AM', notes = '') => ({ name, notes, time });
const names = (meals, cat) => meals[cat].map((m) => m.name);

test('A-D. a meal is stored in the section it was added to, never inferred from its name or defaulted to breakfast', () => {
  let m = emptyCheckin().meals;
  m = mealsWithAdded(m, 'breakfast', meal('Egg'));
  m = mealsWithAdded(m, 'lunch', meal('Rice and chicken'));
  m = mealsWithAdded(m, 'dinner', meal('Pasta'));
  m = mealsWithAdded(m, 'snacks', meal('Banana'));
  assert.deepEqual(names(m, 'breakfast'), ['Egg']);
  assert.deepEqual(names(m, 'lunch'), ['Rice and chicken']);
  assert.deepEqual(names(m, 'dinner'), ['Pasta']);
  assert.deepEqual(names(m, 'snacks'), ['Banana']);
  // a "breakfast-sounding" meal added to dinner stays in dinner
  const d = mealsWithAdded(emptyCheckin().meals, 'dinner', meal('Eggs and toast'));
  assert.deepEqual(names(d, 'dinner'), ['Eggs and toast']);
  assert.equal(d.breakfast.length, 0);
});

test('an unknown section is refused (nothing is silently filed under breakfast)', () => {
  assert.throws(() => mealsWithAdded(emptyCheckin().meals, 'brunch', meal('x')), /Unknown meal section/);
  assert.throws(() => mealsWithAdded(emptyCheckin().meals, undefined, meal('x')), /Unknown meal section/);
});

test('E. several meals in one section all remain, in order; adding never replaces', () => {
  let m = emptyCheckin().meals;
  for (const n of ['Egg', 'Oatmeal', 'Banana']) m = mealsWithAdded(m, 'breakfast', meal(n));
  assert.deepEqual(names(m, 'breakfast'), ['Egg', 'Oatmeal', 'Banana']);
  assert.equal(mealCount({ meals: m }), 3);
});

test('F. meals in different sections stay separated', () => {
  let m = emptyCheckin().meals;
  m = mealsWithAdded(m, 'lunch', meal('Rice'));
  m = mealsWithAdded(m, 'lunch', meal('Chicken'));
  m = mealsWithAdded(m, 'snacks', meal('Yogurt'));
  assert.deepEqual([m.breakfast.length, m.lunch.length, m.dinner.length, m.snacks.length], [0, 2, 0, 1]);
});

test('changes are computed on a copy: the original is untouched (a failed save leaves the working state alone)', () => {
  const before = mealsWithAdded(emptyCheckin().meals, 'breakfast', meal('Egg'));
  const snapshot = JSON.stringify(before);
  mealsWithAdded(before, 'breakfast', meal('Oatmeal'));
  mealsWithReplaced(before, 'breakfast', 0, meal('Toast'));
  mealsWithRemoved(before, 'breakfast', 0);
  assert.equal(JSON.stringify(before), snapshot);
});

test('K. editing replaces in place: same section, same position, no duplicate', () => {
  let m = emptyCheckin().meals;
  for (const n of ['Egg', 'Oatmeal', 'Banana']) m = mealsWithAdded(m, 'breakfast', meal(n));
  m = mealsWithAdded(m, 'lunch', meal('Rice'));
  const edited = mealsWithReplaced(m, 'breakfast', 1, meal('Porridge'));
  assert.deepEqual(names(edited, 'breakfast'), ['Egg', 'Porridge', 'Banana']);
  assert.deepEqual(names(edited, 'lunch'), ['Rice']);
  assert.equal(mealCount({ meals: edited }), 4);
  assert.throws(() => mealsWithReplaced(m, 'breakfast', 9, meal('x')), /no longer exists/);
});

test('J. deleting removes only the selected meal', () => {
  let m = emptyCheckin().meals;
  for (const n of ['Egg', 'Oatmeal', 'Banana']) m = mealsWithAdded(m, 'breakfast', meal(n));
  m = mealsWithAdded(m, 'dinner', meal('Pasta'));
  const after = mealsWithRemoved(m, 'breakfast', 1);
  assert.deepEqual(names(after, 'breakfast'), ['Egg', 'Banana']);
  assert.deepEqual(names(after, 'dinner'), ['Pasta']);
  assert.throws(() => mealsWithRemoved(m, 'lunch', 0), /no longer exists/);
});

test('the daily limit matches the database (save_checkin refuses more than 30 meals)', () => {
  assert.equal(MAX_MEALS_PER_DAY, 30);
  assert.match(readFileSync('supabase/schema.sql', 'utf8'), /jsonb_array_length\(meals\) > 30/);
});

const FULL_DAY = {
  mood: 'good', weight: 70, water: 2000, exercise: null, notes: '',
  meals: {
    breakfast: [meal('Egg', '8:00 AM'), meal('Oatmeal', '9:15 AM', 'with honey')],
    lunch: [meal('Rice and chicken', '1:00 PM')],
    dinner: [meal('Pasta', '7:30 PM')],
    snacks: [meal('Banana', '4:00 PM')],
  },
};

test('what is sent to the database carries each meal\'s section, in that section\'s order', () => {
  const rows = checkinToPayload(FULL_DAY).meals;
  assert.deepEqual(rows.map((r) => [r.category, r.name, r.position]), [
    ['breakfast', 'Egg', 0], ['breakfast', 'Oatmeal', 1], ['lunch', 'Rice and chicken', 0], ['dinner', 'Pasta', 0], ['snacks', 'Banana', 0],
  ]);
});

test('G/H/I. rows read back from the database regroup into the same sections (reload preserves every meal)', () => {
  const rows = checkinToPayload(FULL_DAY).meals.map((r, i) => ({ id: i, checkin_id: 'c1', ...r, eaten_at: `${r.eaten_at}:00` }));
  // the database returns rows in any order: the section and position decide, not the row order
  const shuffled = [...rows].reverse();
  const back = rowsToCheckins([{ id: 'c1', checkin_date: '2026-10-05', mood: 'good', weight_kg: '70', water_ml: 2000, notes: '' }], shuffled)['2026-10-05'];
  assert.deepEqual(back.meals, FULL_DAY.meals);
});

test('M. two dates keep their own meals (rows join their check-in, not the whole table)', () => {
  const rows = [
    { id: 1, checkin_id: 'a', category: 'breakfast', name: 'Yesterday egg', notes: '', eaten_at: '08:00:00', position: 0 },
    { id: 2, checkin_id: 'b', category: 'breakfast', name: 'Today egg', notes: '', eaten_at: '08:00:00', position: 0 },
    { id: 3, checkin_id: 'b', category: 'lunch', name: 'Today rice', notes: '', eaten_at: '13:00:00', position: 0 },
  ];
  const days = rowsToCheckins([
    { id: 'a', checkin_date: '2026-10-04', water_ml: 0 }, { id: 'b', checkin_date: '2026-10-05', water_ml: 0 },
  ], rows);
  assert.deepEqual(days['2026-10-04'].meals.breakfast.map((m) => m.name), ['Yesterday egg']);
  assert.equal(days['2026-10-04'].meals.lunch.length, 0);
  assert.deepEqual(days['2026-10-05'].meals.breakfast.map((m) => m.name), ['Today egg']);
  assert.deepEqual(days['2026-10-05'].meals.lunch.map((m) => m.name), ['Today rice']);
});

test('I. the Journey groups a day into Breakfast, Lunch, Dinner, Snacks; empty sections are left out', () => {
  assert.deepEqual(mealGroups(FULL_DAY).map((g) => [g.label, g.items.map((m) => m.name)]), [
    ['Breakfast', ['Egg', 'Oatmeal']], ['Lunch', ['Rice and chicken']], ['Dinner', ['Pasta']], ['Snacks', ['Banana']],
  ]);
  const onlyDinner = { meals: { ...emptyCheckin().meals, dinner: [meal('Pasta')] } };
  assert.deepEqual(mealGroups(onlyDinner).map((g) => g.cat), ['dinner']);
  assert.deepEqual(mealGroups({ meals: {} }), []);
  assert.deepEqual(mealGroups(null), []);
  assert.deepEqual(MEAL_CATEGORIES, ['breakfast', 'lunch', 'dinner', 'snacks']);
});

test('the Journey markup shows every meal under its own heading, with notes, and escapes text', () => {
  const html = mealGroupsHtml({ meals: { ...FULL_DAY.meals, snacks: [meal('<img src=x onerror=alert(1)>')] } });
  const order = ['Breakfast', 'Lunch', 'Dinner', 'Snacks'].map((h) => html.indexOf(`<h6>${h}</h6>`));
  assert.ok(order.every((i) => i >= 0) && [...order].sort((a, b) => a - b).join() === order.join(), 'headings present and in order');
  for (const n of ['Egg', 'Oatmeal', 'Rice and chicken', 'Pasta', 'with honey']) assert.ok(html.includes(n), n);
  assert.ok(!html.includes('<img'), 'no injected markup');
  assert.ok(html.includes('&lt;img'));
  assert.equal(mealGroupsHtml({ meals: emptyCheckin().meals }), '<p class="muted">Nothing logged</p>');
});

test('N. an empty section reads as intentionally empty, per section', () => {
  assert.equal(mealEmptyHtml('breakfast'), '<div class="meal-empty">No breakfast logged yet</div>');
  assert.equal(mealEmptyHtml('snacks'), '<div class="meal-empty">No snacks logged yet</div>');
});

test('O. meal content never depends on an animation: no meal rule hides it or fades it in with a one-sided keyframe', () => {
  const css = ['checkin', 'checkin-refinements', 'journey-detail', 'polish', 'profile', 'home'].map((f) => readFileSync(`src/styles/${f}.css`, 'utf8')).join('\n');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, sel]) => /\.meal-/.test(sel));
  assert.ok(rules.length >= 5, 'meal rules found');
  for (const [, sel, body] of rules) {
    assert.ok(!/opacity\s*:\s*0(?![.\d])/.test(body), `${sel.trim()} must not set opacity:0`);
    assert.ok(!/animation/.test(body), `${sel.trim()} must not depend on an animation`);
  }
});
