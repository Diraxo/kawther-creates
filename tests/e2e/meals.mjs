// Meals, end to end in a real browser: the real app against the in-memory Supabase stand-in (stubkit).
// The whole path: form -> confirm -> repository (save_checkin) -> stored rows -> reload -> check-in form -> Home -> Journey.
// Covers: every meal lands in ITS section and stays; several per section; edit / delete touch only that meal; nothing is
// lost by leaving the form or reloading; the Journey shows the same saved meals grouped by section; other dates are
// isolated; no duplicates (double tap); failures and offline; visible without any animation; empty sections; 320-430px.
//   node tests/e2e/meals.mjs
import { Stub, dayStr, mkChecks, newSession, startApp, txt } from './stubkit.mjs';

const { check, section, summary } = mkChecks();
const app = await startApp(5193);
const { BASE } = app;

const waitScreen = (page, id, timeout = 20000) => page.waitForSelector(`#${id}.active`, { timeout });
const fresh = (extra = {}) => {
  const stub = new Stub();
  return { stub, acct: stub.account({ journey: { startOffset: 12, duration: 60, startWeight: 72, goalWeight: 62, waterGoal: 2500 }, ...extra }) };
};
async function boot(stub, acct, opts = {}) {
  const s = await newSession(app, stub, { signedIn: acct, ...opts });
  await s.page.goto(BASE, { waitUntil: 'commit' });
  await waitScreen(s.page, 's-home');
  return s;
}
const openEditor = async (page) => { await page.click('#h-ci-cta'); await waitScreen(page, 's-checkin'); };
const closeEditor = async (page) => { await page.click('[aria-label="Close check-in"]'); await waitScreen(page, 's-home'); };
const sheetClosed = (page) => page.waitForFunction(() => !document.getElementById('ov-meal').classList.contains('show'));

async function addMeal(page, cat, name, { time = '08:30', notes = '' } = {}) {
  await page.click(`[data-action="add-meal"][data-cat="${cat}"]`);
  await page.waitForSelector('#ov-meal.show');
  const dest = await txt(page, '#meal-modal-cat');
  await page.fill('#meal-name', name);
  await page.fill('#meal-time', time);
  await page.fill('#meal-notes', notes);
  await page.click('#ov-meal [data-action="confirm-meal"]');
  await sheetClosed(page);
  return dest;
}
const names = (page, cat) => page.locator(`#ci-meal-${cat} .meal-name`).allInnerTexts();
const allSections = async (page) => Object.fromEntries(await Promise.all(['breakfast', 'lunch', 'dinner', 'snacks'].map(async (c) => [c, await names(page, c)])));
const sec = (o) => JSON.stringify(o);
const EMPTY = { breakfast: [], lunch: [], dinner: [], snacks: [] };

/** What the backend really holds for a day: { breakfast: ['Egg', ...], ... } in stored order. */
function stored(acct, date = dayStr(0)) {
  const row = acct.checkins[date];
  const out = { breakfast: [], lunch: [], dinner: [], snacks: [] };
  if (!row) return out;
  acct.meals.filter((m) => m.checkin_id === row.id).sort((a, b) => a.position - b.position).forEach((m) => out[m.category].push(m.name));
  return out;
}
const lastSave = (stub) => stub.saves[stub.saves.length - 1];

/** Truly visible: opacity 1, painted, has a size, and is what you hit when you look at its centre (nothing covers it). */
async function visibleEl(page, sel) {
  return page.locator(sel).first().evaluate((e) => {
    e.scrollIntoView({ block: 'center' });
    const cs = getComputedStyle(e);
    const r = e.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return cs.opacity === '1' && cs.visibility === 'visible' && cs.display !== 'none' && r.width > 20 && r.height > 20 && (e === hit || e.contains(hit));
  });
}
const visibleAll = (page, sel) => page.evaluate((s) => [...document.querySelectorAll(s)].every((e) => {
  e.scrollIntoView({ block: 'center' });
  const cs = getComputedStyle(e);
  const r = e.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return cs.opacity === '1' && cs.visibility === 'visible' && r.width > 20 && r.height > 10 && (e === hit || e.contains(hit));
}), sel);
const journeyGroups = (page) => page.evaluate(() => [...document.querySelectorAll('#j-detail-inner .meal-group')].map((g) => [g.querySelector('h6').textContent, [...g.querySelectorAll('.meal-name')].map((n) => n.textContent)]));
async function openJourneyDay(page, date) {
  await page.click('.navbtn[data-s="s-journey"]');
  await waitScreen(page, 's-journey');
  await page.click(`#j-cal [data-date="${date}"]`);
  await page.waitForSelector('#j-detail-inner .daystatus, #j-detail-inner .empty');
}

// ===================================================================================================
section('1. LIFECYCLE: one meal per section -> stays -> leave the form -> reload -> Journey -> delete -> reload');
const LIFE = { breakfast: ['Egg'], lunch: ['Rice'], dinner: ['Chicken'], snacks: ['Banana'] };
{
  const { stub, acct } = fresh();
  const { page, problems } = await boot(stub, acct);
  await openEditor(page);
  check('nothing is logged to start: four empty sections, no meal cards', sec(await allSections(page)) === sec(EMPTY) && (await page.locator('#s-checkin .meal-empty').count()) === 4);
  const dests = [];
  for (const [cat, name] of [['breakfast', 'Egg'], ['lunch', 'Rice'], ['dinner', 'Chicken'], ['snacks', 'Banana']]) {
    dests.push(await addMeal(page, cat, name));
    const now = await allSections(page);
    check(`${cat}: "${name}" shows immediately, in ${cat} only`, now[cat].join() === name && Object.entries(now).every(([c, l]) => c === cat || !l.includes(name)), sec(now));
    check(`${cat}: the card is really visible (opacity 1, painted, nothing covering it)`, await visibleEl(page, `#ci-meal-${cat} .meal-item`));
    const p = lastSave(stub).payload.meals;
    check(`${cat}: the backend was sent it as category "${cat}"`, p.filter((m) => m.name === name).length === 1 && p.find((m) => m.name === name).category === cat, JSON.stringify(p));
    check(`${cat}: it is stored in the backend under ${cat}`, stored(acct)[cat].join() === name, sec(stored(acct)));
  }
  check('the sheet named its destination each time (Breakfast, Lunch, Dinner, Snacks)', dests.join() === 'Breakfast,Lunch,Dinner,Snacks', dests.join());
  check('all four stay in their sections', sec(await allSections(page)) === sec(LIFE));
  check('one check-in row for today, four meals stored, nothing duplicated', Object.keys(acct.checkins).length === 1 && acct.meals.length === 4 && stub.saves.length === 4);

  await closeEditor(page);
  check('Home already counts them: "4 logged"', /Meals\s*4 logged/.test((await page.locator('#h-ci-summary').evaluate((e) => e.textContent.replace(/\s+/g, ' ')))));
  await openEditor(page);
  check('leave the form and come back: all four meals are still there, in their sections', sec(await allSections(page)) === sec(LIFE), sec(await allSections(page)));
  check('the status says this is the saved check-in being edited', (await page.locator('#ci-status').isVisible()) && (await txt(page, '#ci-save-btn')) === 'Update check-in');

  await page.reload();
  await waitScreen(page, 's-home');
  await openEditor(page);
  check('RELOAD: all four meals are loaded back from the backend into their sections', sec(await allSections(page)) === sec(LIFE), sec(await allSections(page)));
  check('RELOAD: and they are visible', (await visibleAll(page, '#s-checkin .meal-item')) && (await page.locator('#s-checkin .meal-item').count()) === 4);
  await closeEditor(page);

  await openJourneyDay(page, dayStr(0));
  check('JOURNEY (today): Breakfast / Lunch / Dinner / Snacks, each with its own meal', sec(await journeyGroups(page)) === sec([['Breakfast', ['Egg']], ['Lunch', ['Rice']], ['Dinner', ['Chicken']], ['Snacks', ['Banana']]]), sec(await journeyGroups(page)));
  check('JOURNEY: the meal cards are visible (not blank)', await visibleAll(page, '#j-detail-inner .meal-item'));
  check('JOURNEY: no empty "Nothing logged" placeholder next to real meals', !(await page.locator('#j-detail-inner').innerText()).includes('Nothing logged'));

  await page.click('.navbtn[data-s="s-home"]');
  await openEditor(page);
  await page.click('#ci-meal-breakfast [data-action="ask-delete-meal"]');
  check('delete asks first, then only that row changes', (await page.locator('#ci-meal-breakfast .do-nothing, #ci-meal-breakfast [data-action="do-delete-meal"]').count()) === 1 && (await allSections(page)).lunch.join() === 'Rice');
  await page.click('#ci-meal-breakfast [data-action="do-delete-meal"]');
  await page.waitForFunction(() => document.querySelectorAll('#ci-meal-breakfast .meal-empty').length === 1);
  check('deleting Egg removes only Egg; Rice, Chicken, Banana remain', sec(await allSections(page)) === sec({ ...LIFE, breakfast: [] }), sec(await allSections(page)));
  check('the deletion is stored in the backend', sec(stored(acct)) === sec({ ...LIFE, breakfast: [] }), sec(stored(acct)));
  await page.reload();
  await waitScreen(page, 's-home');
  await openEditor(page);
  check('RELOAD after delete: Egg stays deleted, the others stay', sec(await allSections(page)) === sec({ ...LIFE, breakfast: [] }));
  await openJourneyDay(page, dayStr(0)).catch(() => {});
  check('no console/page errors through the whole lifecycle', problems.length === 0, problems.join('|'));
  await page.context().close();
}

// ===================================================================================================
section('2. SEVERAL MEALS in one section; EDIT replaces in place; DELETE removes only the chosen meal');
{
  const { stub, acct } = fresh();
  const { page } = await boot(stub, acct);
  await openEditor(page);
  for (const n of ['Egg', 'Oatmeal', 'Banana']) await addMeal(page, 'breakfast', n);
  await addMeal(page, 'lunch', 'Rice');
  await addMeal(page, 'lunch', 'Chicken');
  await addMeal(page, 'dinner', 'Pasta');
  await addMeal(page, 'dinner', 'Salad');
  await addMeal(page, 'snacks', 'Apple');
  await addMeal(page, 'snacks', 'Yogurt');
  const want = { breakfast: ['Egg', 'Oatmeal', 'Banana'], lunch: ['Rice', 'Chicken'], dinner: ['Pasta', 'Salad'], snacks: ['Apple', 'Yogurt'] };
  check('every meal is visible under its own section, adding never replaced one', sec(await allSections(page)) === sec(want), sec(await allSections(page)));
  check('every meal card is visible', (await page.locator('#s-checkin .meal-item').count()) === 9 && (await visibleAll(page, '#s-checkin .meal-item')));
  check('stored: the same nine meals in the same sections', sec(stored(acct)) === sec(want), sec(stored(acct)));

  const savesBefore = stub.saves.length;
  await page.click('#ci-meal-breakfast .meal-info[data-i="1"]');
  await page.waitForSelector('#ov-meal.show');
  check('edit opens with the saved values and names the section', (await page.inputValue('#meal-name')) === 'Oatmeal' && (await txt(page, '#meal-modal-cat')) === 'Breakfast' && (await txt(page, '#meal-modal-title')) === 'Edit meal');
  await page.fill('#meal-name', 'Porridge');
  await page.click('#ov-meal [data-action="confirm-meal"]');
  await sheetClosed(page);
  check('edit: renamed in place, same section and position, nothing moved or duplicated', sec(await allSections(page)) === sec({ ...want, breakfast: ['Egg', 'Porridge', 'Banana'] }));
  check('edit: stored as an update (still 9 meals, still breakfast), one save', sec(stored(acct)) === sec({ ...want, breakfast: ['Egg', 'Porridge', 'Banana'] }) && acct.meals.length === 9 && stub.saves.length === savesBefore + 1);

  await page.click('#ci-meal-breakfast .meal-info[data-i="1"]');
  await page.waitForSelector('#ov-meal.show');
  await page.click('#meal-delete-btn');
  await sheetClosed(page);
  check('delete from the sheet: only Porridge goes; Egg + Banana stay; other sections untouched', sec(await allSections(page)) === sec({ ...want, breakfast: ['Egg', 'Banana'] }) && sec(stored(acct)) === sec({ ...want, breakfast: ['Egg', 'Banana'] }));

  await page.click('#ci-meal-dinner [data-action="ask-delete-meal"][data-i="0"]');
  await page.click('#ci-meal-dinner [data-action="cancel-delete-meal"]');
  check('cancelling the delete keeps the meal and saves nothing', (await names(page, 'dinner')).join() === 'Pasta,Salad' && stub.saves.length === savesBefore + 2);
  await page.click('#ci-meal-dinner [data-action="ask-delete-meal"][data-i="0"]');
  await page.click('#ci-meal-dinner [data-action="do-delete-meal"]');
  await page.waitForFunction(() => document.querySelectorAll('#ci-meal-dinner .meal-item').length === 1);
  check('delete from the row: only Pasta goes', (await names(page, 'dinner')).join() === 'Salad' && stored(acct).dinner.join() === 'Salad' && stored(acct).breakfast.join() === 'Egg,Banana');

  // Editing later, from a fresh load, must still update and not duplicate
  await page.reload();
  await waitScreen(page, 's-home');
  await openEditor(page);
  await page.click('#ci-meal-lunch .meal-info[data-i="0"]');
  await page.waitForSelector('#ov-meal.show');
  await page.fill('#meal-name', 'Brown rice');
  await page.fill('#meal-notes', 'with lentils');
  await page.click('#ov-meal [data-action="confirm-meal"]');
  await sheetClosed(page);
  check('after a reload, an edit still updates the saved meal (no duplicate) and keeps its notes', stored(acct).lunch.join() === 'Brown rice,Chicken' && acct.meals.length === 7 && (await page.locator('#ci-meal-lunch .meal-notes').first().innerText()) === 'with lentils');
  await page.context().close();
}

// ===================================================================================================
section('3. SAME SOURCE OF TRUTH + DATES: the Journey shows the saved meals of each day, and only that day');
{
  const { stub, acct } = fresh({
    checkins: {
      1: { weight: 71, water: 1000, meals: [{ category: 'breakfast', name: 'Yesterday oats', eaten_at: '08:00' }, { category: 'dinner', name: 'Yesterday soup', eaten_at: '19:00' }] },
      2: { weight: 71, water: 1000, meals: [{ category: 'snacks', name: 'Two days ago dates', eaten_at: '16:00' }] },
      3: { weight: 71, water: 1000, meals: [] },
    },
  });
  const { page } = await boot(stub, acct);
  await openEditor(page);
  check('today starts empty: yesterday\'s meals are not in today\'s form', sec(await allSections(page)) === sec(EMPTY));
  await addMeal(page, 'breakfast', 'Egg');
  await addMeal(page, 'breakfast', 'Oatmeal');
  await addMeal(page, 'lunch', 'Rice and chicken');
  await addMeal(page, 'dinner', 'Pasta');
  await addMeal(page, 'snacks', 'Banana');
  const today = await allSections(page);
  await closeEditor(page);
  await openJourneyDay(page, dayStr(0));
  const j = await journeyGroups(page);
  check('Journey today == what the check-in form shows (same sections, same meals, same order)', sec(j.map(([h, l]) => [h.toLowerCase(), l])) === sec(Object.entries(today).filter(([, l]) => l.length)), sec(j));
  check('Journey today: Breakfast Egg+Oatmeal, Lunch Rice and chicken, Dinner Pasta, Snacks Banana', sec(j) === sec([['Breakfast', ['Egg', 'Oatmeal']], ['Lunch', ['Rice and chicken']], ['Dinner', ['Pasta']], ['Snacks', ['Banana']]]));
  await page.click(`#j-cal [data-date="${dayStr(-1)}"]`);
  await page.waitForFunction(() => document.getElementById('j-detail-inner').innerText.includes('Yesterday oats'));
  check('Journey yesterday: only yesterday\'s meals (Breakfast, Dinner) - today\'s never leak in', sec(await journeyGroups(page)) === sec([['Breakfast', ['Yesterday oats']], ['Dinner', ['Yesterday soup']]]), sec(await journeyGroups(page)));
  await page.click(`#j-cal [data-date="${dayStr(-2)}"]`);
  await page.waitForFunction(() => document.getElementById('j-detail-inner').innerText.includes('Two days ago dates'));
  check('Journey 2 days ago: only its own snack', sec(await journeyGroups(page)) === sec([['Snacks', ['Two days ago dates']]]));
  await page.click(`#j-cal [data-date="${dayStr(-3)}"]`);
  await page.waitForFunction(() => document.getElementById('j-detail-inner').innerText.includes('Checked in'));
  check('a checked-in day without meals says "Nothing logged"', (await page.locator('#j-detail-inner').innerText()).includes('Nothing logged') && (await journeyGroups(page)).length === 0);
  check('yesterday\'s stored meals were not touched by logging today', sec(stored(acct, dayStr(-1))) === sec({ ...EMPTY, breakfast: ['Yesterday oats'], dinner: ['Yesterday soup'] }));
  await page.reload();
  await waitScreen(page, 's-home');
  await openJourneyDay(page, dayStr(0));
  check('after a reload the Journey still shows today\'s four sections', sec(await journeyGroups(page)) === sec([['Breakfast', ['Egg', 'Oatmeal']], ['Lunch', ['Rice and chicken']], ['Dinner', ['Pasta']], ['Snacks', ['Banana']]]));
  await page.context().close();
}

// ===================================================================================================
section('4. NO DUPLICATES + FAILURES: a double tap saves once; a failed or offline save keeps what she typed and shows nothing as saved');
{
  const { stub, acct } = fresh();
  const { page, ctx } = await boot(stub, acct);
  await openEditor(page);
  await page.click('[data-action="add-meal"][data-cat="lunch"]');
  await page.fill('#meal-name', 'Soup');
  stub.delay = 700;
  await page.dblclick('#ov-meal [data-action="confirm-meal"]');
  const busy = await page.evaluate(() => { const b = document.querySelector('#ov-meal [data-action="confirm-meal"]'); return { d: b.disabled, a: b.getAttribute('aria-busy') }; });
  check('double tap: the Save button is busy and disabled at once', busy.d && busy.a === 'true', JSON.stringify(busy));
  await sheetClosed(page);
  stub.delay = 0;
  check('double tap: saved exactly once - one request, one stored row, one card', stub.saves.length === 1 && acct.meals.length === 1 && (await names(page, 'lunch')).join() === 'Soup');

  stub.failStatus = 500;
  await page.click('[data-action="add-meal"][data-cat="dinner"]');
  await page.fill('#meal-name', 'Stew');
  await page.fill('#meal-notes', 'a note');
  await page.click('#ov-meal [data-action="confirm-meal"]');
  await page.waitForFunction(() => { const b = document.querySelector('#ov-meal [data-action="confirm-meal"]'); return !b.disabled && !b.hasAttribute('aria-busy'); });
  check('server error: the sheet stays open with what she typed, and the button works again', (await page.locator('#ov-meal.show').count()) === 1 && (await page.inputValue('#meal-name')) === 'Stew' && (await page.inputValue('#meal-notes')) === 'a note');
  check('server error: nothing is shown as saved, and nothing was stored', (await names(page, 'dinner')).length === 0 && stored(acct).dinner.length === 0);
  check('server error: the user is told', (await page.locator('#kc-toast').innerText().catch(() => '')).length > 0);
  stub.failStatus = null;
  const before = stub.saves.length;
  await page.click('#ov-meal [data-action="confirm-meal"]');
  await sheetClosed(page);
  check('retry after the error saves it once', (await names(page, 'dinner')).join() === 'Stew' && stored(acct).dinner.join() === 'Stew' && stub.saves.length === before + 1);

  await ctx.setOffline(true);
  await page.click('[data-action="add-meal"][data-cat="snacks"]');
  await page.fill('#meal-name', 'Nuts');
  await page.click('#ov-meal [data-action="confirm-meal"]');
  check('offline: refuses (no request, no fake local save), the sheet stays open', (await page.locator('#ov-meal.show').count()) === 1 && (await names(page, 'snacks')).length === 0 && stored(acct).snacks.length === 0);
  await ctx.setOffline(false);
  await page.click('#ov-meal [data-action="confirm-meal"]');
  await sheetClosed(page);
  check('back online: the same meal saves', stored(acct).snacks.join() === 'Nuts');

  stub.failStatus = 500;
  await page.click('#ci-meal-lunch [data-action="ask-delete-meal"]');
  await page.click('#ci-meal-lunch [data-action="do-delete-meal"]');
  await page.waitForFunction(() => document.querySelectorAll('#ci-meal-lunch .meal-item:not(.confirm)').length === 1);
  check('a failed delete puts the meal back, and it is still stored', (await names(page, 'lunch')).join() === 'Soup' && stored(acct).lunch.join() === 'Soup');
  stub.failStatus = null;

  // an empty name never saves
  const n = stub.saves.length;
  await page.click('[data-action="add-meal"][data-cat="breakfast"]');
  await page.click('#ov-meal [data-action="confirm-meal"]');
  check('an empty name saves nothing and keeps the sheet open', stub.saves.length === n && (await page.locator('#ov-meal.show').count()) === 1);
  await page.click('#ov-meal [data-action="close-overlay"]');
  await page.context().close();
}

// ===================================================================================================
section('5. FIRST MEAL of a day creates that day; achievements the server grants are celebrated with the full check-in save');
{
  const { stub, acct } = fresh();
  stub.grant = [{ id: 'first', on: dayStr(0) }];
  const { page } = await boot(stub, acct);
  await openEditor(page);
  await addMeal(page, 'breakfast', 'Egg');
  const p = lastSave(stub).payload;
  check('the first meal sends only that meal: no invented mood, weight or water', p.mood === null && p.weight_kg === null && p.water_ml === 0 && p.exercise_type === null && p.meals.length === 1);
  check('no celebration pops up over a meal sheet', (await page.locator('#ov-celebrate.show, #ov-milestone.show').count()) === 0);
  await page.click('#ci-mood [data-m="good"]');
  await page.fill('#ci-weight', '70.5');
  await page.click('#ci-save-btn');
  await page.waitForSelector('#ov-celebrate.show');
  const p2 = lastSave(stub).payload;
  check('the full save keeps the meal and adds the rest of the day', p2.mood === 'good' && p2.weight_kg === 70.5 && p2.meals.length === 1 && p2.meals[0].category === 'breakfast' && Object.keys(acct.checkins).length === 1);
  await page.waitForSelector('#ov-milestone.show');
  check('the achievement granted while saving the meal is celebrated now, not lost', (await txt(page, '#mi-title')) === 'First Step');
  await page.context().close();
}

// ===================================================================================================
section('6. VISIBLE WITHOUT ANIMATION: reduced motion, animations forced off, and both themes');
{
  const { stub, acct } = fresh();
  const { page } = await boot(stub, acct, { reducedMotion: 'reduce' });
  await openEditor(page);
  await addMeal(page, 'breakfast', 'Egg');
  check('reduced motion: the meal is visible the moment it is saved (no wait, no fade)', await visibleEl(page, '#ci-meal-breakfast .meal-item'));
  await page.addStyleTag({ content: '*,*::before,*::after{animation:none !important; transition:none !important;}' });
  check('with every animation switched off the meal is still visible', await visibleEl(page, '#ci-meal-breakfast .meal-item'));
  const anim = await page.evaluate(() => [...document.querySelectorAll('.meal-item, .meal-item *, .meal-empty')].map((e) => getComputedStyle(e).opacity + '|' + getComputedStyle(e).animationName));
  check('meal cards and empty states carry no animation and no reduced opacity', anim.every((a) => a.startsWith('1|none')), anim.join(' '));
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
    const ratio = await page.evaluate(() => {
      const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const rgba = (s) => { const m = s.match(/[\d.]+/g).map(Number); return [m[0], m[1], m[2], m[3] == null ? 1 : m[3]]; };
      const item = document.querySelector('#ci-meal-breakfast .meal-item');
      let under = [0, 0, 0];
      for (let e = item.parentElement; e; e = e.parentElement) { const c = rgba(getComputedStyle(e).backgroundColor); if (c[3] === 1) { under = c.slice(0, 3); break; } }
      const t = rgba(getComputedStyle(item).backgroundColor);
      const bg = under.map((u, i) => Math.round(t[i] * t[3] + u * (1 - t[3])));
      const one = (sel) => { const fg = rgba(getComputedStyle(item.querySelector(sel)).color); const [a, b] = [lum(fg), lum(bg)]; return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
      return { name: one('.meal-name'), time: one('.meal-time') };
    });
    check(`${theme} theme: the meal name and time are readable against the card (contrast >= 4.5)`, ratio.name >= 4.5 && ratio.time >= 4.5, JSON.stringify(ratio));
  }
  await page.context().close();
}
{
  // empty sections look deliberate, not like a broken black area
  const { stub, acct } = fresh();
  const { page } = await boot(stub, acct);
  await openEditor(page);
  const empties = await page.evaluate(() => [...document.querySelectorAll('#s-checkin .meal-empty')].map((e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return { t: e.textContent, h: Math.round(r.height), border: cs.borderTopStyle, o: cs.opacity }; }));
  check('four empty sections, each with a visible note ("No breakfast logged yet" ...) in a dashed placeholder', empties.map((e) => e.t).join('|') === 'No breakfast logged yet|No lunch logged yet|No dinner logged yet|No snacks logged yet' && empties.every((e) => e.border === 'dashed' && e.h >= 36 && e.h <= 70 && e.o === '1'), JSON.stringify(empties));
  check('empty sections keep a tappable "+ Add meal" / "+ Add snack"', (await page.locator('.addmeal').allInnerTexts()).join('|') === '+ Add meal|+ Add meal|+ Add meal|+ Add snack');
  await addMeal(page, 'lunch', 'Rice');
  check('a real meal replaces the empty note', (await page.locator('#ci-meal-lunch .meal-empty').count()) === 0 && (await page.locator('#ci-meal-lunch .meal-item').count()) === 1 && (await page.locator('#ci-meal-dinner .meal-empty').count()) === 1);
  await page.context().close();
}

// ===================================================================================================
section('7. MOBILE 320 / 375 / 390 / 430: nothing clipped, nothing overflowing, comfortable targets, keyboard-safe sheet');
{
  const LONG = 'Grilled chicken breast with roasted vegetables, brown rice and a very-long-unbroken-word-' + 'x'.repeat(60);
  const meals = [];
  for (const cat of ['breakfast', 'lunch', 'dinner', 'snacks']) {
    meals.push({ category: cat, name: LONG, notes: 'A longer note about how this meal felt, to make sure notes wrap and never push the card wider than the screen.', eaten_at: '12:30' });
    meals.push({ category: cat, name: 'Egg', notes: '', eaten_at: '08:05' });
    meals.push({ category: cat, name: 'Banana', notes: '', eaten_at: '10:45' });
  }
  const { stub, acct } = fresh({ checkins: { 0: { weight: 70, water: 1500, meals } } });
  for (const w of [320, 375, 390, 430]) {
    const { page } = await boot(stub, acct, { width: w, height: 760 });
    await openEditor(page);
    const r = await page.evaluate(() => {
      const vw = innerWidth;
      const over = [];
      const small = [];
      document.querySelectorAll('#s-checkin .meal-sec *').forEach((e) => {
        const b = e.getBoundingClientRect();
        if (!b.width || !b.height) return;
        if (b.left < -0.5 || b.right > vw + 0.5) over.push(`${e.className || e.tagName}:${Math.round(b.left)}-${Math.round(b.right)}`);
      });
      document.querySelectorAll('#s-checkin .meal-del, #s-checkin .addmeal, #s-checkin .meal-info').forEach((e) => {
        const b = e.getBoundingClientRect();
        if (b.height < 38 && !e.matches('.meal-info')) small.push(`${e.className}:${Math.round(b.height)}`);
        if (e.matches('.meal-del') && b.width < 38) small.push(`${e.className}-w:${Math.round(b.width)}`);
      });
      const cards = [...document.querySelectorAll('#s-checkin .meal-item')];
      const clipped = cards.filter((c) => c.scrollWidth > c.clientWidth + 1).length;
      return { over, small, clipped, scroll: document.documentElement.scrollWidth - vw, cards: cards.length };
    });
    check(`${w}px: 12 meal cards, no horizontal overflow, no card clipped`, r.cards === 12 && r.scroll <= 0 && r.over.length === 0 && r.clipped === 0, JSON.stringify(r));
    check(`${w}px: delete and Add buttons are comfortable tap targets (>= 38px)`, r.small.length === 0, r.small.join(','));
    check(`${w}px: every card is visible and readable`, await visibleAll(page, '#s-checkin .meal-item'));
    const guard = await page.evaluate(() => { window.scrollTo(0, document.body.scrollHeight); const s = document.getElementById('ci-save-btn').getBoundingClientRect(); const n = document.querySelector('.bottomnav').getBoundingClientRect(); return s.bottom <= n.top + 0.5; });
    check(`${w}px: at the end of the form the Save button clears the bottom nav`, guard);
    // the delete confirmation row fits too
    await page.locator('#s-checkin [data-action="ask-delete-meal"]').first().scrollIntoViewIfNeeded();
    await page.locator('#s-checkin [data-action="ask-delete-meal"]').first().click();
    const conf = await page.evaluate(() => { const c = document.querySelector('.meal-item.confirm'); const b = c.getBoundingClientRect(); return { right: b.right, vw: innerWidth, clipped: c.scrollWidth > c.clientWidth + 1, tall: [...c.querySelectorAll('button')].every((x) => x.getBoundingClientRect().height >= 34) }; });
    check(`${w}px: the "Delete this?" row fits and its buttons are tappable`, conf.right <= conf.vw && !conf.clipped && conf.tall, JSON.stringify(conf));
    await page.locator('.meal-item.confirm [data-action="cancel-delete-meal"]').click();
    // the add sheet with a keyboard-sized viewport
    await page.setViewportSize({ width: w, height: 380 });
    await page.click('[data-action="add-meal"][data-cat="snacks"]');
    await page.focus('#meal-notes');
    const kb = await page.evaluate(() => {
      const b = document.querySelector('#ov-meal [data-action="confirm-meal"]');
      b.scrollIntoView({ block: 'nearest' });
      const r = b.getBoundingClientRect();
      return { inView: r.top >= 0 && r.bottom <= innerHeight, scroll: document.documentElement.scrollWidth - innerWidth, size: Math.round(r.height) };
    });
    check(`${w}px: with a keyboard-sized viewport the sheet's Save button can be scrolled into view and is tappable`, kb.inView && kb.scroll <= 0 && kb.size >= 40, JSON.stringify(kb));
    await page.click('#ov-meal [data-action="close-overlay"]');
    await page.setViewportSize({ width: w, height: 760 });
    // Journey
    await openJourneyDay(page, dayStr(0));
    const jr = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth - innerWidth, right: Math.max(...[...document.querySelectorAll('#j-detail-inner .meal-item')].map((e) => e.getBoundingClientRect().right)), vw: innerWidth, groups: document.querySelectorAll('#j-detail-inner .meal-group').length }));
    check(`${w}px: the Journey day fits - four sections, no sideways scroll`, jr.groups === 4 && jr.scroll <= 0 && jr.right <= jr.vw, JSON.stringify(jr));
    check(`${w}px: Journey meal cards are visible`, await visibleAll(page, '#j-detail-inner .meal-item'));
    await page.context().close();
  }
}

const ok = summary();
await app.stop();
process.exit(ok ? 0 : 1);
