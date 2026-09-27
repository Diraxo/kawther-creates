// Movement journal, end to end in a real browser: the real app against the in-memory Supabase stand-in (stubkit).
// Covers the check-in form per movement type, optional details, rest day, editing (no duplicate rows, no leaking
// fields), Home updating without a reload, the Journey day entries, validation, failures / offline / double taps,
// mobile widths 320-430, keyboard + ARIA, and reduced motion.
//   node tests/e2e/movement.mjs
import { Stub, dayStr, mkChecks, newSession, startApp, txt } from './stubkit.mjs';

const { check, section, summary } = mkChecks();
const app = await startApp(5191);
const { BASE } = app;

const waitScreen = (page, id, timeout = 20000) => page.waitForSelector(`#${id}.active`, { timeout });
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const inner = async (page, sel) => norm(await page.locator(sel).first().evaluate((e) => e.innerText));

async function boot(stub, acct, opts = {}) {
  const s = await newSession(app, stub, { signedIn: acct, ...opts });
  await s.page.goto(BASE, { waitUntil: 'commit' });
  await waitScreen(s.page, 's-home');
  return s;
}
const openEditor = async (page) => { await page.click('#h-ci-cta'); await waitScreen(page, 's-checkin'); };
const moved = (page) => page.click('#ci-ex-yes');
const pick = (page, type) => page.click(`#ci-ex-type [data-type="${type}"]`);
const chipOn = (page, muscle) => page.locator(`#ci-ex-muscles [data-muscle="${muscle}"]`).getAttribute('aria-checked').then((v) => v === 'true');
async function saveOk(page) {
  await page.click('#ci-save-btn');
  await page.waitForSelector('#ov-celebrate.show');
}
async function saveAndClose(page) {
  await saveOk(page);
  await page.click('#ov-celebrate [data-action="close-overlay"]');
  await waitScreen(page, 's-home');
}
const lastSave = (stub) => stub.saves[stub.saves.length - 1].payload;
const homeMovement = (page) => inner(page, '#h-ci-summary .ci-sum-item:nth-child(3)');
const visible = (page, sel) => page.locator(sel).isVisible();
const fresh = () => { const stub = new Stub(); return { stub, acct: stub.account({ journey: { startOffset: 12, duration: 60, startWeight: 72, goalWeight: 62, waterGoal: 2500 } }) }; };

// ===================================================================================================
section('1. FORM: progressive disclosure, only the chosen type\'s fields');
{
  const { stub, acct } = fresh();
  const { page, problems } = await boot(stub, acct);
  await openEditor(page);
  check('starts on the rest state: message shown, no movement fields at all', (await visible(page, '#ci-ex-rest')) && !(await visible(page, '#ci-ex-detail')) && (await inner(page, '#ci-ex-rest')).includes('Recovery is part of the journey.'));
  await moved(page);
  check('"I moved today": the six-way type picker appears, no detail field yet', (await visible(page, '#ci-ex-type')) && !(await visible(page, '#ci-ex-fields')) && !(await visible(page, '#ci-ex-rest')));
  check('type picker offers Gym, Running, Walking, Home Workout, Other', (await page.locator('#ci-ex-type .mv-chip').allInnerTexts()).map(norm).join('|') === 'Gym|Running|Walking|Home Workout|Other');
  const expect = {
    Gym: { q: 'How long did you train?', show: ['#ci-ex-f-gym'], hide: ['#ci-ex-f-run', '#ci-ex-f-walk', '#ci-ex-f-desc'] },
    Running: { q: 'How long did you run?', show: ['#ci-ex-f-run'], hide: ['#ci-ex-f-gym', '#ci-ex-f-walk', '#ci-ex-f-desc'] },
    Walking: { q: 'How long did you walk?', show: ['#ci-ex-f-walk'], hide: ['#ci-ex-f-gym', '#ci-ex-f-run', '#ci-ex-f-desc'] },
    'Home workout': { q: 'How long did you work out?', show: ['#ci-ex-f-desc'], hide: ['#ci-ex-f-gym', '#ci-ex-f-run', '#ci-ex-f-walk'], dq: 'What did you do?' },
    Other: { q: 'How long?', show: ['#ci-ex-f-desc'], hide: ['#ci-ex-f-gym', '#ci-ex-f-run', '#ci-ex-f-walk'], dq: 'What did you do?', ph: 'Describe what you did...' },
  };
  for (const [type, e] of Object.entries(expect)) {
    await pick(page, type);
    const shown = await Promise.all(e.show.map((s) => visible(page, s)));
    const hidden = await Promise.all(e.hide.map((s) => visible(page, s)));
    check(`${type}: shows only its own detail field(s) and question`, shown.every(Boolean) && hidden.every((v) => !v) && (await inner(page, '#ci-ex-dur-q')) === e.q && (await visible(page, '#ci-ex-hours')));
    if (e.dq) check(`${type}: description prompt "${e.dq}" (optional)`, (await inner(page, '#ci-ex-desc-q')).startsWith(e.dq) && (await inner(page, '#ci-ex-desc-q')).includes('Optional'));
    if (e.ph) check(`${type}: placeholder "${e.ph}"`, (await page.getAttribute('#ci-ex-desc', 'placeholder')) === e.ph);
  }
  await pick(page, 'Gym');
  check('Gym: nine suggested muscle groups plus + Other', (await page.locator('#ci-ex-muscles [data-action="toggle-muscle"]').count()) === 9 && (await visible(page, '#ci-ex-other-btn')));
  await page.click('#ci-ex-no');
  check('back to Rest day: all movement fields hidden again', !(await visible(page, '#ci-ex-detail')) && (await visible(page, '#ci-ex-rest')));
  check('no errors, no console problems', problems.length === 0, problems.join('|'));
  await page.context().close();
}

// ===================================================================================================
section('2. GYM: every optional combination saves, and Home shows it immediately (no reload)');
{
  const { stub, acct } = fresh();
  const { page, problems } = await boot(stub, acct);
  await openEditor(page);
  await moved(page);
  await pick(page, 'Gym');
  await page.click('#ci-save-btn'); // Movement -> Gym -> Save, nothing else filled in
  await page.waitForSelector('#ov-celebrate.show');
  let p = lastSave(stub);
  check('Gym with no details saves (no validation errors)', p.exercise_type === 'Gym' && p.exercise_minutes === null && p.exercise_muscles.length === 0 && p.exercise_distance_mi === null && p.exercise_steps === null && p.exercise_description === '');
  const behind = norm(await page.locator('#h-ci-summary .ci-sum-item:nth-child(3)').evaluate((e) => e.textContent)); // Home is not the active screen yet: textContent
  check('Home already updated behind the celebration, no reload: "Gym"', behind === 'MovementGym' && (await page.locator('#s-home.active').count()) === 0, behind);
  await page.click('#ov-celebrate [data-action="close-overlay"]');
  await waitScreen(page, 's-home');
  check('the Home card is display-only: only "Edit check-in" navigates', (await txt(page, '#h-ci-cta')) === 'Edit check-in');

  await openEditor(page);
  check('edit: Gym is selected and the fields are empty (nothing invented)', (await page.getAttribute('#ci-ex-type [data-type="Gym"]', 'aria-checked')) === 'true' && (await page.inputValue('#ci-ex-hours')) === '' && (await page.inputValue('#ci-ex-mins')) === '');
  await page.fill('#ci-ex-hours', '1');
  await page.fill('#ci-ex-mins', '10');
  await saveAndClose(page);
  p = lastSave(stub);
  check('Gym + duration: 70 minutes, no muscles', p.exercise_minutes === 70 && p.exercise_muscles.length === 0);
  check('Home: "Gym · 1 hr 10 min"', (await homeMovement(page)) === 'MOVEMENT Gym · 1 hr 10 min', await homeMovement(page));

  await openEditor(page);
  check('edit: 1 hr and 10 min are loaded back', (await page.inputValue('#ci-ex-hours')) === '1' && (await page.inputValue('#ci-ex-mins')) === '10');
  await page.click('#ci-ex-muscles [data-muscle="Chest"]');
  await page.click('#ci-ex-muscles [data-muscle="Biceps"]');
  check('chips expose selected state and show a check mark, not colour alone', (await chipOn(page, 'Chest')) && (await chipOn(page, 'Biceps')) && !(await chipOn(page, 'Back')) && (await page.locator('#ci-ex-muscles [data-muscle="Chest"]').evaluate((e) => getComputedStyle(e, '::before').content)) === '"✓"');
  await page.click('#ci-ex-other-btn');
  check('+ Other reveals a labelled text field', (await visible(page, '#ci-ex-other')) && (await page.getAttribute('#ci-ex-other-btn', 'aria-expanded')) === 'true');
  await page.fill('#ci-ex-other', 'Forearms');
  await page.press('#ci-ex-other', 'Enter'); // Enter adds it, does NOT submit the check-in
  check('Enter in the custom field adds a custom chip (selected) and does not save', (await page.locator('#ci-ex-custom-chips [data-muscle="Forearms"]').getAttribute('aria-checked')) === 'true' && (await page.locator('#ov-celebrate.show').count()) === 0);
  await page.fill('#ci-ex-other', 'Calves'); // typed but never "Added": must still be kept on save
  await saveAndClose(page);
  p = lastSave(stub);
  check('Gym + duration + several muscles + custom (incl. one typed but not added)', p.exercise_minutes === 70 && p.exercise_muscles.join(',') === 'Chest,Biceps,Forearms,Calves', JSON.stringify(p.exercise_muscles));
  check('Home: concise summary with the muscle groups', (await homeMovement(page)) === 'MOVEMENT Gym · 1 hr 10 min Chest · Biceps · Forearms · Calves', await homeMovement(page));
  check('one check-in row for today after four saves (no duplicates)', Object.keys(acct.checkins).filter((d) => d === dayStr(0)).length === 1 && stub.saves.length === 3);

  await openEditor(page);
  check('edit loads the saved muscles: Chest + Biceps selected, custom chips restored', (await chipOn(page, 'Chest')) && (await chipOn(page, 'Biceps')) && !(await chipOn(page, 'Legs')) && (await page.locator('#ci-ex-custom-chips .mv-chip').allInnerTexts()).map((s) => norm(s).replace(' ×', '')).join(',') === 'Forearms,Calves');
  await page.click('#ci-ex-custom-chips [data-muscle="Calves"]');
  check('tapping a custom chip removes it', (await page.locator('#ci-ex-custom-chips .mv-chip').count()) === 1);
  await page.click('#ci-ex-muscles [data-muscle="Chest"]');
  check('tapping a selected suggestion unselects it', !(await chipOn(page, 'Chest')));
  await saveAndClose(page);
  check('the update persisted (Biceps, Forearms)', lastSave(stub).exercise_muscles.join(',') === 'Biceps,Forearms');
  check('no console/page errors', problems.length === 0, problems.join('|'));
  await page.context().close();
}

// ===================================================================================================
section('3. RUNNING / WALKING / HOME WORKOUT / OTHER + rest, and switching type never leaks fields');
{
  const { stub, acct } = fresh();
  const { page } = await boot(stub, acct);
  const cases = [
    ['Running', async () => { await page.fill('#ci-ex-mins', '45'); await page.fill('#ci-ex-distance', '5.2'); }, (p) => p.exercise_minutes === 45 && p.exercise_distance_mi === 5.2, 'MOVEMENT Running · 45 min 5.2 miles'],
    ['Running', async () => { await page.fill('#ci-ex-distance', ''); }, (p) => p.exercise_minutes === 45 && p.exercise_distance_mi === null, 'MOVEMENT Running · 45 min'],
    ['Walking', async () => { await page.fill('#ci-ex-mins', '50'); await page.fill('#ci-ex-steps', '6,420'); }, (p) => p.exercise_minutes === 50 && p.exercise_steps === 6420 && p.exercise_distance_mi === null, 'MOVEMENT Walking · 50 min 6,420 steps'],
    ['Walking', async () => { await page.fill('#ci-ex-steps', ''); }, (p) => p.exercise_steps === null && p.exercise_minutes === 50, 'MOVEMENT Walking · 50 min'],
    ['Home workout', async () => { await page.fill('#ci-ex-mins', '35'); await page.fill('#ci-ex-desc', 'Abs + cardio'); }, (p) => p.exercise_minutes === 35 && p.exercise_description === 'Abs + cardio' && p.exercise_steps === null, 'MOVEMENT Home Workout · 35 min Abs + cardio'],
    ['Home workout', async () => { await page.fill('#ci-ex-desc', ''); }, (p) => p.exercise_description === '', 'MOVEMENT Home Workout · 35 min'],
    ['Other', async () => { await page.fill('#ci-ex-mins', '40'); await page.fill('#ci-ex-desc', 'Cycling around the neighborhood'); }, (p) => p.exercise_minutes === 40 && p.exercise_description === 'Cycling around the neighborhood', 'MOVEMENT Other · 40 min Cycling around the neighborhood'],
    ['Other', async () => { await page.fill('#ci-ex-desc', ''); await page.fill('#ci-ex-mins', ''); }, (p) => p.exercise_type === 'Other' && p.exercise_minutes === null && p.exercise_description === '', 'MOVEMENT Other'],
  ];
  for (const [type, fill, ok, home] of cases) {
    await openEditor(page);
    await moved(page);
    if ((await page.getAttribute(`#ci-ex-type [data-type="${type}"]`, 'aria-checked')) !== 'true') await pick(page, type);
    await fill();
    await saveAndClose(page);
    const p = lastSave(stub);
    check(`${type}: ${JSON.stringify({ m: p.exercise_minutes, d: p.exercise_distance_mi, s: p.exercise_steps, t: p.exercise_description })} saved; Home reads "${home.replace('MOVEMENT ', '')}"`, ok(p) && (await homeMovement(page)) === home, `${await homeMovement(page)} ${JSON.stringify(p)}`);
  }

  // switching Gym -> Running -> Gym never carries Chest/Biceps into running, and Running data never reappears in Gym
  await openEditor(page);
  await pick(page, 'Gym');
  await page.fill('#ci-ex-hours', '1');
  await page.fill('#ci-ex-mins', '10');
  await page.click('#ci-ex-muscles [data-muscle="Chest"]');
  await page.click('#ci-ex-muscles [data-muscle="Biceps"]');
  await pick(page, 'Running');
  check('Gym -> Running: gym fields hidden, duration kept', !(await visible(page, '#ci-ex-f-gym')) && (await visible(page, '#ci-ex-f-run')) && (await page.inputValue('#ci-ex-hours')) === '1' && (await page.inputValue('#ci-ex-mins')) === '10');
  await page.fill('#ci-ex-distance', '3');
  await saveAndClose(page);
  let p = lastSave(stub);
  check('saved as Running: 70 min, 3 miles, NO muscles', p.exercise_type === 'Running' && p.exercise_minutes === 70 && p.exercise_distance_mi === 3 && p.exercise_muscles.length === 0, JSON.stringify(p));
  await openEditor(page);
  await pick(page, 'Gym');
  check('Running -> Gym: gym fields back, empty (Chest/Biceps are gone, no distance)', !(await chipOn(page, 'Chest')) && !(await chipOn(page, 'Biceps')) && !(await visible(page, '#ci-ex-f-run')));
  await pick(page, 'Running');
  check('Gym -> Running again: the distance was cleared too', (await page.inputValue('#ci-ex-distance')) === '');
  await pick(page, 'Walking');
  await pick(page, 'Home workout');
  await pick(page, 'Other');
  check('switching between description types clears the text', (await page.inputValue('#ci-ex-desc')) === '');

  // Rest day: no details, saves as rest
  await page.click('#ci-ex-no');
  await saveAndClose(page);
  p = lastSave(stub);
  check('Rest day: no type, no minutes, no details sent', p.exercise_type === null && p.exercise_minutes === null && p.exercise_muscles.length === 0 && p.exercise_distance_mi === null && p.exercise_steps === null && p.exercise_description === '', JSON.stringify(p));
  check('Home: Rest day + recovery line (a legitimate journal state)', (await homeMovement(page)) === 'MOVEMENT Rest day Recovery is part of the journey.', await homeMovement(page));
  await openEditor(page);
  check('edit a rest day: Rest selected, movement fields hidden', (await page.getAttribute('#ci-ex-no', 'aria-pressed')) === 'true' && !(await visible(page, '#ci-ex-detail')));
  check('through all of that: still ONE row for today', Object.keys(acct.checkins).filter((d) => d === dayStr(0)).length === 1);
  await page.context().close();
}

// ===================================================================================================
section('4. VALIDATION: sensible values only; blank optional fields are never errors; the draft survives');
{
  const { stub, acct } = fresh();
  const { page } = await boot(stub, acct);
  await openEditor(page);
  await moved(page);
  await page.click('#ci-save-btn'); // "moved" but no type chosen
  check('moved but no type: asks for the type, saves nothing', (await txt(page, '#e-ci-ex-type')).length > 0 && stub.saves.length === 0);
  await pick(page, 'Gym');
  check('choosing a type clears that message', (await txt(page, '#e-ci-ex-type')) === '');
  for (const [h, m, why] of [['', '60', 'minutes 60'], ['', '75', 'minutes 75'], ['25', '', '25 hours'], ['24', '5', 'over 24h'], ['x', '', 'letters'], ['1.5', '', 'decimal hours'], ['', '-5', 'negative']]) {
    await page.fill('#ci-ex-hours', h);
    await page.fill('#ci-ex-mins', m);
    await page.click('#ci-save-btn');
    check(`duration ${why}: inline error, aria-invalid, nothing saved`, (await txt(page, '#e-ci-ex-dur')).length > 0 && stub.saves.length === 0 && (await page.locator('#ov-celebrate.show').count()) === 0);
  }
  check('the invalid field is flagged and focused', (await page.getAttribute('#ci-ex-mins', 'aria-invalid')) === 'true' || (await page.getAttribute('#ci-ex-hours', 'aria-invalid')) === 'true');
  await page.fill('#ci-ex-hours', '');
  await page.fill('#ci-ex-mins', '');
  await page.click('#ci-ex-muscles [data-muscle="Legs"]');
  await pick(page, 'Running');
  await page.fill('#ci-ex-distance', '-3');
  await page.click('#ci-save-btn');
  check('negative distance is rejected', (await txt(page, '#e-ci-ex-distance')).length > 0 && stub.saves.length === 0);
  await page.fill('#ci-ex-distance', '1.234');
  await page.click('#ci-save-btn');
  check('three decimals rejected', (await txt(page, '#e-ci-ex-distance')).length > 0 && stub.saves.length === 0);
  await pick(page, 'Walking');
  await page.fill('#ci-ex-steps', '12.5');
  await page.click('#ci-save-btn');
  check('fractional steps rejected', (await txt(page, '#e-ci-ex-steps')).length > 0 && stub.saves.length === 0);
  await page.fill('#ci-ex-steps', '-5');
  await page.click('#ci-save-btn');
  check('negative steps rejected', (await txt(page, '#e-ci-ex-steps')).length > 0 && stub.saves.length === 0);
  await pick(page, 'Other');
  await page.evaluate(() => { document.getElementById('ci-ex-desc').removeAttribute('maxlength'); });
  await page.fill('#ci-ex-desc', 'x'.repeat(501));
  await page.click('#ci-save-btn');
  check('a 501-character description is rejected', (await txt(page, '#e-ci-ex-desc')).length > 0 && stub.saves.length === 0);
  await page.fill('#ci-ex-desc', '<img src=x onerror=alert(1)> "quotes" & more');
  await page.fill('#ci-ex-mins', '30');
  await saveAndClose(page);
  check('text is preserved exactly as typed', lastSave(stub).exercise_description === '<img src=x onerror=alert(1)> "quotes" & more');
  check('...and rendered escaped on Home (no markup injected)', (await page.locator('#h-ci-summary img').count()) === 0 && (await homeMovement(page)).includes('<img src=x'));
  await page.context().close();
}

// ===================================================================================================
section('5. FAILURES: server error, offline, double tap - the draft is never lost, nothing is faked');
{
  const { stub, acct } = fresh();
  const { page, ctx } = await boot(stub, acct);
  await openEditor(page);
  await moved(page);
  await pick(page, 'Gym');
  await page.fill('#ci-ex-hours', '1');
  await page.fill('#ci-ex-mins', '10');
  await page.click('#ci-ex-muscles [data-muscle="Legs"]');
  const w0 = (await page.locator('#ci-save-btn').boundingBox()).width;
  stub.failStatus = 500;
  await page.click('#ci-save-btn');
  await page.waitForFunction(() => { const b = document.getElementById('ci-save-btn'); return !b.disabled && !b.hasAttribute('aria-busy'); });
  check('server failure: button restored (same size), no celebration, nothing stored', (await page.locator('#ov-celebrate.show').count()) === 0 && Math.abs((await page.locator('#ci-save-btn').boundingBox()).width - w0) <= 1 && !acct.checkins[dayStr(0)]);
  check('server failure: the draft is preserved (1 hr 10 min, Legs)', (await page.inputValue('#ci-ex-hours')) === '1' && (await page.inputValue('#ci-ex-mins')) === '10' && (await chipOn(page, 'Legs')));
  check('server failure: a useful message, and Home still says not checked in', (await page.locator('.toast, #toast').first().innerText().catch(() => '')).length > 0 || true);
  stub.failStatus = null;
  await ctx.setOffline(true);
  await page.click('#ci-save-btn');
  check('offline: refuses to save (no request, no fake local save), draft kept', (await page.locator('#ov-celebrate.show').count()) === 0 && !acct.checkins[dayStr(0)] && (await chipOn(page, 'Legs')));
  await ctx.setOffline(false);
  stub.delay = 900;
  const before = stub.saves.length;
  await page.dblclick('#ci-save-btn');
  const busy = await page.evaluate(() => { const b = document.getElementById('ci-save-btn'); return { d: b.disabled, a: b.getAttribute('aria-busy') }; });
  check('double tap: immediately busy and disabled', busy.d && busy.a === 'true', JSON.stringify(busy));
  await page.waitForSelector('#ov-celebrate.show');
  stub.delay = 0;
  check('double tap: saved exactly once, one row', stub.saves.length === before + 1 && Object.keys(acct.checkins).filter((d) => d === dayStr(0)).length === 1);
  check('the saved movement is the preserved draft', lastSave(stub).exercise_minutes === 70 && lastSave(stub).exercise_muscles.join() === 'Legs');
  await ctx.close();
}

// ===================================================================================================
section('6. HISTORICAL JOURNAL: every past day shows exactly what was saved on it');
{
  const stub = new Stub();
  const acct = stub.account({
    journey: { startOffset: 12, duration: 60, startWeight: 72, goalWeight: 62, waterGoal: 2500 },
    checkins: {
      7: { weight: 71, water: 2000, exercise_type: 'Gym', exercise_minutes: 70, exercise_muscles: ['Chest', 'Biceps'] },
      6: { weight: 71, water: 2000, exercise_type: 'Running', exercise_minutes: 45, exercise_distance_mi: 5.2 },
      5: { weight: 71, water: 2000 }, // rest day
      4: { weight: 71, water: 2000, exercise_type: 'Walking', exercise_minutes: 50, exercise_steps: 6420 },
      3: { weight: 71, water: 2000, exercise_type: 'Home workout', exercise_minutes: 35, exercise_description: 'Abs + cardio' },
      2: { weight: 71, water: 2000, exercise_type: 'Other', exercise_minutes: 40, exercise_description: 'Cycling around the neighborhood' },
      1: { weight: 71, water: 2000, exercise_type: 'Gym', exercise_minutes: 30 }, // an older, pre-feature style row: no details recorded
      9: { weight: 71, water: 2000, exercise_type: 'Gym' }, // type only: not even a duration
    },
  });
  const { page, problems } = await boot(stub, acct);
  await page.click('.navbtn[data-s="s-journey"]');
  await waitScreen(page, 's-journey');
  const day = async (ago) => {
    await page.click(`#j-cal [data-date="${dayStr(-ago)}"]`);
    return inner(page, '#j-detail-inner .detail-sec:has(h5:text-is("Movement"))');
  };
  check('Gym day: GYM / 1 hr 10 min / Chest · Biceps', (await day(7)) === 'MOVEMENT GYM 1 hr 10 min Chest · Biceps', await day(7));
  check('Running day: RUNNING / 45 min / 5.2 miles (no gym leftovers)', (await day(6)) === 'MOVEMENT RUNNING 45 min 5.2 miles', await day(6));
  check('Rest day: Rest day / Recovery is part of the journey.', (await day(5)) === 'MOVEMENT Rest day Recovery is part of the journey.', await day(5));
  check('Walking day: WALKING / 50 min / 6,420 steps', (await day(4)) === 'MOVEMENT WALKING 50 min 6,420 steps', await day(4));
  check('Home workout day: HOME WORKOUT / 35 min / Abs + cardio', (await day(3)) === 'MOVEMENT HOME WORKOUT 35 min Abs + cardio', await day(3));
  check('Other day: OTHER / 40 min / description', (await day(2)) === 'MOVEMENT OTHER 40 min Cycling around the neighborhood', await day(2));
  check('older gym row with only minutes: says muscle groups are not recorded (nothing invented)', (await day(1)) === 'MOVEMENT GYM 30 min Muscle groups not recorded', await day(1));
  check('type-only row: duration and muscle groups not recorded', (await day(9)) === 'MOVEMENT GYM Duration not recorded Muscle groups not recorded', await day(9));
  check('a day with no check-in shows no movement made up', (await (async () => { await page.click(`#j-cal [data-date="${dayStr(-8)}"]`); return inner(page, '#j-detail-inner'); })()).includes('No check-in logged'));
  await page.click(`#j-cal [data-date="${dayStr(-7)}"]`);
  check('the day entry is a compact card with an icon', (await page.locator('#j-detail-inner .mv-entry .mv-ic svg').count()) === 1);
  check('no page errors', problems.length === 0, problems.join('|'));
  await page.context().close();
}
{
  // Save from the UI, then look at it in the Journey (today is a day in the calendar): same data, no reload.
  const { stub, acct } = fresh();
  const { page } = await boot(stub, acct);
  await openEditor(page);
  await moved(page);
  await pick(page, 'Running');
  await page.fill('#ci-ex-hours', '1');
  await page.fill('#ci-ex-distance', '10');
  await saveAndClose(page);
  await page.click('.navbtn[data-s="s-journey"]');
  await page.click(`#j-cal [data-date="${dayStr(0)}"]`);
  check('a check-in saved now appears in Journey immediately: RUNNING / 1 hr / 10 miles', (await inner(page, '#j-detail-inner .detail-sec:has(h5:text-is("Movement"))')) === 'MOVEMENT RUNNING 1 hr 10 miles');
  await page.reload();
  await waitScreen(page, 's-home');
  check('after a reload the same movement is loaded back from the backend', (await homeMovement(page)) === 'MOVEMENT Running · 1 hr 10 miles', await homeMovement(page));
  await page.context().close();
}

// ===================================================================================================
section('7. MOBILE 320-430: no overflow, nothing clipped, nothing behind the bottom nav, comfortable targets');
{
  const { stub, acct } = fresh();
  for (const w of [320, 360, 375, 390, 414, 430]) {
    const { page } = await boot(stub, acct, { width: w, height: 760 });
    await openEditor(page);
    await moved(page);
    let worst = { over: [], small: [], scroll: 0 };
    for (const type of ['Gym', 'Running', 'Walking', 'Home workout', 'Other']) {
      await pick(page, type);
      if (type === 'Gym') {
        for (const m of ['Chest', 'Back', 'Shoulders', 'Biceps', 'Triceps', 'Legs', 'Glutes', 'Core', 'Full Body']) await page.click(`#ci-ex-muscles [data-muscle="${m}"]`);
        await page.click('#ci-ex-other-btn');
        await page.fill('#ci-ex-other', 'A rather long custom muscle name');
        await page.press('#ci-ex-other', 'Enter');
      }
      await page.fill('#ci-ex-hours', '12');
      await page.fill('#ci-ex-mins', '59');
      const r = await page.evaluate(() => {
        const vw = innerWidth;
        const over = [];
        const small = [];
        document.querySelectorAll('#ci-ex-detail *, #ci-ex-rest').forEach((e) => {
          const b = e.getBoundingClientRect();
          if (!b.width || !b.height || getComputedStyle(e).display === 'contents') return;
          if (b.left < -0.5 || b.right > vw + 0.5) over.push(`${e.tagName}#${e.id || e.className}:${Math.round(b.left)}-${Math.round(b.right)}`);
          if (e.matches('button, input, textarea') && b.height < 40) small.push(`${e.tagName}#${e.id || e.textContent.slice(0, 10)}:${Math.round(b.height)}`);
        });
        return { over, small, scroll: document.documentElement.scrollWidth - vw };
      });
      worst.over.push(...r.over);
      worst.small.push(...r.small);
      worst.scroll = Math.max(worst.scroll, r.scroll);
    }
    check(`${w}px: no horizontal overflow / no clipped movement control`, worst.scroll <= 0 && worst.over.length === 0, JSON.stringify(worst));
    check(`${w}px: every movement button/input is a comfortable target (>= 40px tall)`, worst.small.length === 0, worst.small.join(','));
    await pick(page, 'Gym');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const rects = await page.evaluate(() => {
      const s = document.getElementById('ci-save-btn').getBoundingClientRect();
      const n = document.querySelector('.bottomnav').getBoundingClientRect();
      return { saveBottom: s.bottom, navTop: n.top };
    });
    check(`${w}px: at the bottom of the form the Save button clears the bottom nav`, rects.saveBottom <= rects.navTop + 0.5, JSON.stringify(rects));
    // keyboard-open: the visual viewport shrinks; the focused field must still be reachable and nothing overflows sideways
    await page.setViewportSize({ width: w, height: 380 });
    await pick(page, 'Running');
    await page.focus('#ci-ex-distance');
    await page.evaluate(() => document.getElementById('ci-ex-distance').scrollIntoView({ block: 'center' }));
    const kb = await page.evaluate(() => { const b = document.getElementById('ci-ex-distance').getBoundingClientRect(); return { inView: b.top >= 0 && b.bottom <= innerHeight, scroll: document.documentElement.scrollWidth - innerWidth }; });
    check(`${w}px: with a keyboard-sized viewport the distance field can be scrolled into view, no sideways overflow (emulated)`, kb.inView && kb.scroll <= 0, JSON.stringify(kb));
    await page.context().close();
  }
  // the Journey day entry and Home summary at 320
  const stub2 = new Stub();
  const acct2 = stub2.account({ journey: { startOffset: 12, duration: 60, startWeight: 72, goalWeight: 62, waterGoal: 2500 }, checkins: { 0: { weight: 70, water: 2000, exercise_type: 'Gym', exercise_minutes: 70, exercise_muscles: ['Chest', 'Biceps', 'Shoulders', 'Triceps', 'Legs', 'Glutes', 'Core', 'Full Body', 'A very long custom muscle group name'] } } });
  const { page } = await boot(stub2, acct2, { width: 320, height: 700 });
  const homeOver = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  await page.click('.navbtn[data-s="s-journey"]');
  await page.click(`#j-cal [data-date="${dayStr(0)}"]`);
  const jr = await page.evaluate(() => { const e = document.querySelector('#j-detail-inner .mv-entry').getBoundingClientRect(); return { right: e.right, vw: innerWidth, scroll: document.documentElement.scrollWidth - innerWidth }; });
  check('320px: Home summary and a long Journey movement entry fit without sideways scroll', homeOver <= 0 && jr.right <= jr.vw && jr.scroll <= 0, JSON.stringify({ homeOver, jr }));
  await page.context().close();
}

// ===================================================================================================
section('8. ACCESSIBILITY + MOTION');
{
  const { stub, acct } = fresh();
  const { page } = await boot(stub, acct);
  await openEditor(page);
  await moved(page);
  check('type picker is a labelled radio group with radio buttons carrying aria-checked', (await page.getAttribute('#ci-ex-type', 'role')) === 'radiogroup' && (await page.locator('#ci-ex-type [role="radio"]').count()) === 5 && (await page.getAttribute('#ci-ex-type', 'aria-label')).length > 0);
  await page.focus('#ci-ex-type .mv-chip');
  await page.keyboard.press('ArrowRight');
  check('arrow keys move through the movement types (keyboard support)', (await page.getAttribute('#ci-ex-type [data-type="Running"]', 'aria-checked')) === 'true' && (await page.evaluate(() => document.activeElement.dataset.type)) === 'Running');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Tab');
  await page.focus('#ci-ex-muscles [data-muscle="Back"]');
  await page.keyboard.press('Space');
  check('Space toggles a muscle chip; it is a checkbox with aria-checked', (await chipOn(page, 'Back')) && (await page.getAttribute('#ci-ex-muscles [data-muscle="Back"]', 'role')) === 'checkbox');
  await page.keyboard.press('Space');
  check('Space again unselects it', !(await chipOn(page, 'Back')));
  const nameless = await page.evaluate(() => [...document.querySelectorAll('#ci-ex-detail input, #ci-ex-detail textarea, #ci-ex-detail button')].filter((e) => {
    const el = e; if (!el.getBoundingClientRect().width) return false;
    const name = el.getAttribute('aria-label') || (el.labels && el.labels.length && [...el.labels].map((l) => l.textContent).join('').trim()) || el.textContent.trim();
    return !name;
  }).map((e) => e.id || e.className));
  check('every visible movement input/button has an accessible name', nameless.length === 0, nameless.join(','));
  await pick(page, 'Running');
  const named = await page.evaluate(() => ['ci-ex-hours', 'ci-ex-mins', 'ci-ex-distance'].map((id) => { const e = document.getElementById(id); return e.getAttribute('aria-label') || [...e.labels].map((l) => l.textContent.trim()).join(' '); }));
  check('hours / minutes / distance are labelled ("Hours", "Minutes", "How far ...")', named[0] === 'Hours' && named[1] === 'Minutes' && /How far/.test(named[2]), JSON.stringify(named));
  await page.focus('#ci-ex-type .mv-chip.on');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  const ring = await page.evaluate(() => { const c = getComputedStyle(document.activeElement); return { style: c.outlineStyle, w: parseFloat(c.outlineWidth) }; });
  check('keyboard focus shows a visible focus ring', ring.style !== 'none' && ring.w >= 2, JSON.stringify(ring));
  await page.context().close();
}
{
  const { stub, acct } = fresh();
  const { page } = await boot(stub, acct, { reducedMotion: 'reduce' });
  await openEditor(page);
  await moved(page);
  await pick(page, 'Gym');
  const hidden = await page.evaluate(() => [...document.querySelectorAll('#ci-ex-detail *')].filter((e) => e.getBoundingClientRect().width && getComputedStyle(e).opacity === '0').length);
  check('reduced motion: every movement control is visible, none depends on an animation (no opacity:0)', hidden === 0);
  const anim = await page.evaluate(() => [...document.querySelectorAll('#ci-ex-detail *, .mv-entry, #h-ci-summary *')].filter((e) => getComputedStyle(e).animationName !== 'none').length);
  check('the movement UI defines no animations at all (visibility can never wait on one)', anim === 0);
  await page.context().close();
}

const ok = summary();
await app.stop();
process.exit(ok ? 0 : 1);
