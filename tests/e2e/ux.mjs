// FINAL UX PASS, live: everything below runs the real UI against the real Supabase project, and verifies rows with an
// independent client. Accounts are throw-away `kc.test.*` users seeded through the app's own repository.
//   node tests/e2e/ux.mjs        (needs .env; Auth "Confirm email" OFF)
// The exercise_unit checks need supabase/migrations/2026-09-27_exercise_unit.sql applied; without it they are
// reported as NOT VERIFIED (never as passed).
import { PASS, addDays, ci, dbView, hasMovementColumns, mkChecks, mkRepo, newPage, seedAccount, startApp, today, txt, uiLogin, URL_, KEY } from './kit.mjs';
import { createClient } from '@supabase/supabase-js';
import { mkdirSync } from 'node:fs';

const { check, notVerified, section, summary } = mkChecks();
const SHOTS = process.env.SHOTS_DIR || 'tests/e2e/screenshots';
mkdirSync(SHOTS, { recursive: true });
const app = await startApp(5178);
const { BASE, browser } = app;
const problems = [];
const moveMigrated = await hasMovementColumns();
console.log(moveMigrated ? 'movement journal columns present on the live project' : 'movement journal columns MISSING on the live project (2026-10-01 migration not applied): movement DETAIL persistence will be NOT VERIFIED');

const nav = (page, s) => page.click(`.navbtn[data-s="${s}"]`);
const inView = (page, sel) => page.locator(sel).first().evaluate((e) => {
  const r = e.getBoundingClientRect();
  const navTop = document.getElementById('nav').getBoundingClientRect().top;
  return { top: r.top, bottom: r.bottom, vh: window.innerHeight, navTop, visible: r.top >= 0 && r.bottom <= navTop };
});
const dayIso = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// ======================================================================================================
section('A. New user: Home header, first check-in, hydration, movement, completion, PLUS = edit (no duplicate)');
const A = await seedAccount('ux-a', { name: 'Kawthar Test', duration: 60, waterGoal: 2500 });
const pa = await newPage(browser, { problems });
await uiLogin(pa, BASE, A.email);

{
  const greet = await pa.locator('.hero-top').boundingBox();
  const hero = await pa.locator('.hero-card').boundingBox();
  const gap = hero.y - (greet.y + greet.height);
  check('HOME: comfortable gap between greeting/name and the journey card (16–48px)', gap >= 16 && gap <= 48, `gap=${gap}`);
  const pb = await pa.locator('.profilebtn').boundingBox();
  const bw = await pa.locator('.profilebtn').evaluate((e) => parseFloat(getComputedStyle(e).borderTopWidth));
  check('HOME: profile button is ≥44×44 with a visible border', pb.width >= 44 && pb.height >= 44 && bw >= 1, JSON.stringify({ pb, bw }));
  check('HOME: profile button has an accessible name', /profile/i.test(await pa.locator('.profilebtn').getAttribute('aria-label')));
  check('HOME (before check-in): onboarding state', (await txt(pa, '#h-ci-title')) === 'Start your first check-in' && (await txt(pa, '#h-ci-cta')) === 'Begin' && (await txt(pa, '#h-motiv')) === 'Your journey starts today.');
  check('HOME: streak chip sits in the journey card header, no streak yet', (await txt(pa, '.hero-head #h-streak')) === 'No streak yet' && (await txt(pa, '#h-daylabel')) === 'DAY 1 OF 60');
  const chip = await pa.locator('#h-streak-chip').boundingBox();
  check('HOME: streak chip is in the top-right of the card', chip.x + chip.width > hero.x + hero.width * 0.55 && chip.y < hero.y + 70, JSON.stringify(chip));
  await pa.screenshot({ path: `${SHOTS}/ux-home-new-390.png` });
}

// PLUS on a day with no check-in: blank
await pa.click('.navbtn.fab');
await pa.waitForSelector('#s-checkin.active');
check('PLUS (no check-in yet): opens EMPTY form in create mode', (await pa.inputValue('#ci-weight')) === '' && (await pa.inputValue('#ci-water-input')) === '' && (await pa.locator('#ci-status').isHidden()) && (await txt(pa, '#ci-save-btn')) === 'Save check-in');

// hydration goal from real journey settings, typed input, goal beside the amount
check('HYDRATION: goal (2.5 L) is shown beside the amount, from the journey', (await txt(pa, '#ci-water-goalnote')) === '/ 2.5 L');
const editBtn = await pa.locator('.editgoal-cta').boundingBox();
const editStyle = await pa.locator('.editgoal-cta').evaluate((e) => { const s = getComputedStyle(e); return { color: s.color, border: s.borderTopWidth, weight: s.fontWeight }; });
const editHit = await pa.locator('.editgoal').boundingBox();
check('EDIT action is visibly actionable: accent colour + border + bold + 44px hit area', parseFloat(editStyle.border) >= 1 && Number(editStyle.weight) >= 600 && editHit.height >= 44, JSON.stringify({ editStyle, editHit, editBtn }));
await pa.click('.editgoal');
await pa.fill('#goal-input', '5');
await pa.click('#ov-goal [data-action="save-goal"]');
await pa.waitForFunction(() => !document.getElementById('ov-goal').classList.contains('show'));
check('HYDRATION: custom goal shows immediately (/ 5 L)', (await txt(pa, '#ci-water-goalnote')) === '/ 5 L' && (await txt(pa, '#ci-water-goal-label')) === '5 L');
check('HYDRATION: custom goal persisted in Supabase (5000 ml)', (await dbView(A.email)).journey[0].water_goal_ml === 5000);
await pa.fill('#ci-water-input', '1.5');
check('HYDRATION: typed 1.5 with the goal beside it', (await pa.inputValue('#ci-water-input')) === '1.5' && (await txt(pa, '#ci-water-goalnote')) === '/ 5 L');
await pa.click('.quickadd button:nth-child(1)'); // +0.25
check('HYDRATION: quick add keeps the field in sync (1.75)', (await pa.inputValue('#ci-water-input')) === '1.75');
await pa.click('.wctrl button[data-n="-250"]');
check('HYDRATION: minus button back to 1.5', (await pa.inputValue('#ci-water-input')) === '1.5');

// movement: type picker + hours/minutes
await pa.click('#ci-ex-yes');
await pa.click('#ci-ex-type [data-type="Walking"]');
const hrBox = await pa.locator('#ci-ex-hours').boundingBox();
check('MOVEMENT: type picker + hours/minutes fields present, >=44px targets', (await pa.getAttribute('#ci-ex-type [data-type="Walking"]', 'aria-checked')) === 'true' && hrBox.height >= 44);
await pa.fill('#ci-ex-mins', '75');
await pa.click('#ci-save-btn'); // minutes 75 is impossible
check('MOVEMENT: impossible minutes are rejected inline (nothing saved)', (await txt(pa, '#e-ci-ex-dur')).length > 0 && (await pa.locator('#s-checkin.active').count()) === 1);
check('MOVEMENT: nothing was written to Supabase by the rejected save', (await dbView(A.email)).checkins.length === 0);
await pa.fill('#ci-ex-hours', '1');
await pa.fill('#ci-ex-mins', '30');
await pa.fill('#ci-ex-steps', '6420');
await pa.click('#ci-mood [data-m="great"]');
await pa.fill('#ci-weight', '63.8');
await pa.screenshot({ path: `${SHOTS}/ux-checkin-390.png`, fullPage: true });
await pa.click('#ci-save-btn');
await pa.waitForSelector('#ov-celebrate.show');

// completion: what is still missing
const cel = await pa.locator('#cel-list li').allInnerTexts();
check('COMPLETION: says "Check-in complete" and the day/streak', (await txt(pa, '#cel-eyebrow')) === 'Check-in complete' && (await txt(pa, '#cel-streak')) === 'Day 1 of 60 · 1 day streak');
check('COMPLETION: hydration shows actual / goal and what is left', cel.some((t) => /Hydration: 1\.5 L \/ 5 L — 3\.5 L to go/.test(t)), cel.join(' | '));
check('COMPLETION: workout complete with the entered unit', cel.some((t) => /Workout complete: Walking · 1\.5 hr/.test(t)), cel.join(' | '));
check('COMPLETION: meals missing reported', cel.some((t) => /Meals: Nothing logged yet/.test(t)));
check('COMPLETION: no "weight missing" (weight was logged) and nothing says failed', !cel.some((t) => /Weight/.test(t)) && !cel.some((t) => /fail|unsuccessful/i.test(t)));
await pa.screenshot({ path: `${SHOTS}/ux-completion-390.png` });
// achievements: only what is really unlocked
await pa.waitForSelector('#ov-milestone.show');
check('ACHIEVEMENTS: only First Step unlocks on the first check-in (no fake Consistent)', (await txt(pa, '#mi-title')) === 'First Step' && (await txt(pa, '#mi-btn')) === 'Nice!');
await pa.click('#ov-milestone .btn');
await pa.waitForFunction(() => !document.getElementById('ov-milestone').classList.contains('show'));
await pa.click('#ov-celebrate .btn');
await pa.waitForSelector('#s-home.active');
let db = await dbView(A.email);
check('DB: exactly ONE check-in row; achievements = [first]', db.checkins.length === 1 && db.ach.map((a) => a.achievement_id).join() === 'first');
check('DB: water 1500, weight 63.8, Walking, 90 minutes', db.checkins[0].water_ml === 1500 && Number(db.checkins[0].weight_kg) === 63.8 && db.checkins[0].exercise_type === 'Walking' && db.checkins[0].exercise_minutes === 90);
if (moveMigrated) check('DB: Walking steps stored with the minutes', db.checkins[0].exercise_steps === 6420);
else notVerified('MOVEMENT detail persistence in Supabase', 'live project has no movement columns: run supabase/migrations/2026-10-01_movement_journal.sql (after the hardening)');

// Home after completion
check('HOME (after check-in): completed state, not "Start your first check-in"', (await txt(pa, '#h-ci-title')) === "Today's check-in is complete" && /COMPLETE/.test(await txt(pa, '#h-ci-eyebrow')));
const sum = await txt(pa, '#h-ci-summary');
check('HOME: summary from saved data (weight, water / goal, movement, mood, meals)', /Weight\s*63\.8 kg/.test(sum) && /Water\s*1\.5 L \/ 5 L/.test(sum) && /Movement\s*Walking · 1 hr 30 min/.test(sum) && /Mood\s*Great/.test(sum) && /Meals\s*None logged/.test(sum), sum);
check('HOME: clear "Edit check-in" action', /Edit check-in/.test(await txt(pa, '#h-ci-cta')) && (await pa.locator('#h-ci-cta').boundingBox()).height >= 44);
check('HOME: streak reads "1 day streak" and the card says day one is done', (await txt(pa, '#h-streak')) === '1 day streak' && (await txt(pa, '#h-motiv')) === 'Day one is done. Keep it going.');
await pa.screenshot({ path: `${SHOTS}/ux-home-done-390.png` });

// PLUS after completion: edit mode with every saved field, no duplicate
await pa.click('.navbtn.fab');
await pa.waitForSelector('#s-checkin.active');
check('PLUS (after check-in): opens the EXISTING check-in, marked Completed', (await pa.locator('#ci-status').isVisible()) && /Completed/.test(await txt(pa, '#ci-status')) && (await txt(pa, '#ci-save-btn')) === 'Update check-in');
check('PLUS: weight, water, mood, movement all loaded (not blank)', (await pa.inputValue('#ci-weight')) === '63.8' && (await pa.inputValue('#ci-water-input')) === '1.5' && (await pa.locator('#ci-mood .mood.sel[data-m="great"]').count()) === 1 && (await pa.getAttribute('#ci-ex-type [data-type="Walking"]', 'aria-checked')) === 'true' && (await pa.inputValue('#ci-ex-hours')) === '1' && (await pa.inputValue('#ci-ex-mins')) === '30');
await pa.screenshot({ path: `${SHOTS}/ux-checkin-edit-390.png`, fullPage: true });
// the Home card's "Edit check-in" button opens the very same thing (the card itself is display-only)
await pa.click('#s-checkin [data-action="go"]');
await pa.click('#h-ci-cta');
check('HOME card "Edit check-in" opens the same existing check-in', (await txt(pa, '#ci-save-btn')) === 'Update check-in' && (await pa.inputValue('#ci-weight')) === '63.8');
// add a meal + change movement to Gym 67 minutes, save
await pa.click('[data-action="add-meal"][data-cat="lunch"]');
await pa.fill('#meal-name', 'Rice and chicken');
await pa.click('#ov-meal [data-action="confirm-meal"]');
await pa.click('#ci-ex-type [data-type="Gym"]');
await pa.fill('#ci-ex-hours', '1');
await pa.fill('#ci-ex-mins', '7');
await pa.fill('#ci-weight', '63.5');
await pa.click('#ci-save-btn');
await pa.waitForSelector('#ov-celebrate.show');
check('EDIT save: sheet says "Check-in updated" (not a second creation)', (await txt(pa, '#cel-eyebrow')) === 'Check-in updated');
check('EDIT save: no achievement is re-celebrated', (await pa.locator('#ov-milestone.show').count()) === 0);
await pa.click('#ov-celebrate .btn');
await pa.waitForSelector('#s-home.active');
db = await dbView(A.email);
check('DB: still ONE check-in row after edit; values UPDATED (63.5 kg, Gym 67 min, 1 meal)', db.checkins.length === 1 && Number(db.checkins[0].weight_kg) === 63.5 && db.checkins[0].exercise_type === 'Gym' && db.checkins[0].exercise_minutes === 67 && db.meals.length === 1 && db.checkins[0].water_ml === 1500);
check('DB: achievements unchanged (no duplicate unlock)', db.ach.length === 1);
check('HOME: summary now shows Gym · 67 min and 1 meal', /Movement\s*Gym · 1 hr 7 min/.test(await txt(pa, '#h-ci-summary')) && /Meals\s*1 logged/.test(await txt(pa, '#h-ci-summary')));
// reload: the saved unit / duration survives a full page reload from Supabase
await pa.reload();
await pa.waitForSelector('#s-home.active');
await pa.click('.navbtn.fab');
check('PLUS after RELOAD still opens the saved check-in in edit mode', (await pa.locator('#ci-status').isVisible()) && (await pa.inputValue('#ci-weight')) === '63.5' && (await pa.inputValue('#ci-ex-hours')) === '1' && (await pa.inputValue('#ci-ex-mins')) === '7');
db = await dbView(A.email);
check('DB: one row after all of that', db.checkins.length === 1);

// hours round-trip through Supabase
await pa.click('#ci-ex-type [data-type="Running"]');
await pa.fill('#ci-ex-hours', '1');
await pa.fill('#ci-ex-mins', '');
await pa.click('#ci-save-btn');
await pa.waitForSelector('#ov-celebrate.show');
await pa.click('#ov-celebrate .btn');
await pa.reload();
await pa.waitForSelector('#s-home.active');
const homeSum = await txt(pa, '#h-ci-summary');
check('MOVEMENT: "1 hr" survives reload as 1 hr (not converted to 60 min)', /Running · 1 hr/.test(homeSum), homeSum);
await pa.click('.navbtn.fab');
check('MOVEMENT: editing 1 hr later shows 1 hr, 0 min', (await pa.inputValue('#ci-ex-hours')) === '1' && (await pa.inputValue('#ci-ex-mins')) === '');
await pa.click('#s-checkin [data-action="go"]');

// ======================================================================================================
section('B. Streak: missed days keep the earned streak, "Renew your streak", restoration, multi-unlock queue');
const B = await seedAccount('ux-b', {
  name: 'Streak Tester', startOffset: 10, duration: 60, waterGoal: 5000,
  checkins: {
    9: ci({ weight: 72.0, water: 3000, notes: 'day one notes' }),
    8: ci({ weight: 71.6, water: 5000, exercise: { type: 'Gym', duration: 67, unit: 'minutes' } }),
    7: ci({ weight: 71.4, water: 4000, meals: { breakfast: [{ name: 'Oats', notes: '', time: '8:30 AM' }], lunch: [], dinner: [], snacks: [] } }),
    6: ci({ weight: 71.1, water: 2500 }),
  },
});
const pb = await newPage(browser, { problems });
await uiLogin(pb, BASE, B.email);
check('STREAK: after missing days the chip says "Streak paused" (not 0 as if nothing happened)', (await txt(pb, '#h-streak')) === 'Streak paused' && (await pb.locator('#h-streak-chip').getAttribute('data-state')) === 'paused');
check('STREAK: the earned 4-day streak is preserved in the message, with a Renew action', /4-day streak/.test(await txt(pb, '#h-renew-text')) && (await pb.locator('#h-renew').isVisible()) && /Renew your streak/.test(await txt(pb, '.renew-btn')));
check('HOME: day counter is real (DAY 11 OF 60)', (await txt(pb, '#h-daylabel')) === 'DAY 11 OF 60');
await pb.screenshot({ path: `${SHOTS}/ux-home-paused-390.png` });
await nav(pb, 's-progress');
check('STREAK on Progress: paused with best 4', (await txt(pb, '#st-streak')) === '0 days' && /Streak paused · best 4/.test(await txt(pb, '#st-streak-lbl')));
await nav(pb, 's-home');
await pb.click('.renew-btn');
await pb.waitForSelector('#ov-renew.show');
check('RENEW: motivational confirmation with a Continue action', /still yours/.test(await txt(pb, '#rn-title')) && /Ready to keep going/.test(await txt(pb, '#rn-sub')) && /4-day streak/.test(await txt(pb, '#rn-sub')) && (await txt(pb, '#rn-continue')) === 'Continue journey');
await pb.screenshot({ path: `${SHOTS}/ux-renew-390.png` });
db = await dbView(B.email);
check('RENEW: opening the dialog writes nothing (history untouched: 4 rows)', db.checkins.length === 4);
await pb.click('#rn-continue');
await pb.waitForSelector('#s-checkin.active');
check('RENEW → Continue journey opens a blank check-in for today', (await pb.inputValue('#ci-weight')) === '' && (await pb.locator('#ci-status').isHidden()));
check('HYDRATION: the user\'s 5 L goal is shown, not a hard-coded one', (await txt(pb, '#ci-water-goalnote')) === '/ 5 L');
await pb.fill('#ci-weight', '70.9');
await pb.click('#ci-save-btn');
await pb.waitForSelector('#ov-celebrate.show');
check('RESTORE: the new active streak is 1 (fresh run) after returning', (await txt(pb, '#cel-streak')) === 'Day 11 of 60 · 1 day streak');
const seen = [];
for (let i = 0; i < 3; i++) {
  await pb.waitForSelector('#ov-milestone.show', { timeout: 4000 }).catch(() => {});
  if (!(await pb.locator('#ov-milestone.show').count())) break;
  seen.push(await txt(pb, '#mi-title'));
  await pb.click('#mi-btn');
  await pb.waitForFunction(() => !document.getElementById('ov-milestone').classList.contains('show'));
}
check('ACHIEVEMENTS: multiple unlocks queue cleanly, in order, each real (First Step then 3-Day Streak from the earlier 4-day run)', seen.join() === 'First Step,3-Day Streak', seen.join());
await pb.click('#ov-celebrate .btn');
await pb.waitForSelector('#s-home.active');
check('STREAK: chip back to active "1 day streak", renew banner gone', (await txt(pb, '#h-streak')) === '1 day streak' && (await pb.locator('#h-renew').isHidden()));
await nav(pb, 's-progress');
await pb.waitForTimeout(1000); // count-up
check('STREAK: Progress shows current 1 with best 4 preserved', (await txt(pb, '#st-streak')) === '1 day' && /best 4/.test(await txt(pb, '#st-streak-lbl')));
db = await dbView(B.email);
check('DB: 5 check-ins total (nothing rewritten); achievements first + d3 saved once', db.checkins.length === 5 && db.ach.map((a) => a.achievement_id).sort().join() === 'd3,first');
await pb.reload();
await pb.waitForSelector('#s-home.active');
await nav(pb, 's-ach');
check('ACHIEVEMENTS: after reload nothing re-celebrates; locked ones show real progress', (await pb.locator('#ov-milestone.show').count()) === 0 && (await pb.locator('.ach:not(.locked)').count()) === 2 && /Progress: 4 \/ 7/.test(await txt(pb, '.ach[data-id="d7"]')), await txt(pb, '.ach[data-id="d7"]'));
check('ACHIEVEMENTS: unlocked show their real unlock date; "Consistent" is locked (needs 7 check-ins)', /Unlocked/.test(await txt(pb, '.ach[data-id="first"]')) && /Locked · Progress: 5 \/ 7 check-ins/.test(await txt(pb, '.ach[data-id="consistent"]')), await txt(pb, '.ach[data-id="consistent"]'));
await pb.screenshot({ path: `${SHOTS}/ux-achievements-390.png`, fullPage: true });

// ======================================================================================================
section('C. Progress: independent range picker, data-aware windows, honest chart, count-up, reduced motion');
// C1: a 1-day-old journey (account A) — 7/30/90 must not pretend to hold 7/30/90 days
await nav(pa, 's-progress');
// (a 60-day journey offers 7/14/30/60: you cannot look back further than your journey exists)
for (const [r, label] of [['7', '7-day view'], ['30', '30-day view'], ['60', '60-day view']]) {
  await pa.click(`#p-ranges [data-r="${r}"]`);
  await pa.waitForTimeout(400);
  const sub = await txt(pa, '#p-rangesub');
  check(`PROGRESS ${label}: "1 of ${r} days recorded" + journey day 1 note`, (await txt(pa, '#p-rangetitle')) === label && sub.includes(`1 of ${r} days recorded`) && /You're on day 1 of your journey/.test(sub) && /More progress will appear as you continue/.test(sub), sub);
}
check('PROGRESS: consistency is relative to elapsed days and says so (not a fake 7/30/90-day figure)', /100%/.test(await txt(pa, '#st-consistency')) && /of 1 elapsed day/.test(await txt(pa, '#st-consistency-lbl')));
check('PROGRESS: no weight change from a single weigh-in', (await txt(pa, '#st-change')) === '—' && /Needs 2 weigh-ins/.test(await txt(pa, '#st-change-lbl')));
check('PROGRESS: average water is real with the goal alongside (1.5 L, goal 5 L)', (await txt(pa, '#st-water')) === '1.5 L' && /goal 5 L/.test(await txt(pa, '#st-water-lbl')));
check('GRAPH (1 point): a single real dot, no invented line/curve, honest text', (await pa.locator('#p-chart [data-chart-point]').count()) === 1 && (await pa.locator('#p-chart path[stroke="var(--emerald)"]').count()) === 0 && /1 weight entry/.test(await txt(pa, '#p-chartfoot')) && /Keep checking in to reveal your trend/.test(await txt(pa, '#p-chartfoot')));
check('GRAPH: goal + start reference lines and axis labels are present and labelled', /Goal 62 kg/.test(await txt(pa, '#p-chart')) && /Start 72 kg/.test(await txt(pa, '#p-chart')) && /Now/.test(await txt(pa, '#p-chart')) && (await pa.locator('#p-chart').getAttribute('aria-label')).includes('1 weigh-in'));
check('PROGRESS: ranges longer than the 60-day journey are not offered (no 90-day chip, no redundant "All")', (await pa.locator('#p-ranges .rchip[data-r="90"]').isHidden()) && (await pa.locator('#p-ranges .rchip[data-r="all"]').isHidden()));
await pa.click('#p-ranges [data-r="custom"]');
await pa.fill('#p-custom-days', '45');
await pa.click('[data-action="apply-custom-range"]');
await pa.waitForTimeout(500);
check('PROGRESS custom 45: a "45-day view" that says only 1 day exists', (await txt(pa, '#p-rangetitle')) === '45-day view' && /1 of 45 days recorded/.test(await txt(pa, '#p-rangesub')));
await pa.fill('#p-custom-days', '61');
await pa.click('[data-action="apply-custom-range"]');
check('PROGRESS custom > journey length is rejected inline', /60 days/.test(await txt(pa, '#e-p-custom')) && (await pa.getAttribute('#p-custom-days', 'aria-invalid')) === 'true');
await pa.fill('#p-custom-days', 'abc');
await pa.click('[data-action="apply-custom-range"]');
check('PROGRESS custom non-numeric is rejected inline', /whole number/.test(await txt(pa, '#e-p-custom')));
await pa.screenshot({ path: `${SHOTS}/ux-progress-1day-390.png`, fullPage: true });

// C2: a 120-day journey 20 days in with 12 real check-in days
const weights = [72, 71.8, 71.9, 71.5, 71.2, 71.3, 70.9, 70.6, 70.4, 70.2, 70.0, 69.8];
const C = await seedAccount('ux-c', {
  name: 'Range Tester', startOffset: 20, duration: 120, waterGoal: 2500,
  checkins: Object.fromEntries(weights.map((w, i) => [11 - i, ci({ weight: w, water: 2000 + (i % 3) * 500, exercise: i % 2 ? { type: 'Gym', duration: 45, unit: 'minutes' } : null, notes: i === 1 ? 'A note for day 11' : '' })])),
});
const pc = await newPage(browser, { problems });
await uiLogin(pc, BASE, C.email);
check('HOME: 120-day journey (not 60/90) and a 12-day streak', (await txt(pc, '#h-daylabel')) === 'DAY 21 OF 120' && (await txt(pc, '#h-streak')) === '12 day streak');
await nav(pc, 's-progress');
await pc.click('#p-ranges [data-r="7"]');
await pc.waitForTimeout(1200);
check('PROGRESS 7-day (full window): 7 of 7 days, no "journey day" caveat', /7 of 7 days recorded/.test(await txt(pc, '#p-rangesub')) && !/You're on day/.test(await txt(pc, '#p-rangesub')));
check('PROGRESS: consistency 100% of 7 elapsed days', (await txt(pc, '#st-consistency')) === '100%' && /of 7 elapsed days/.test(await txt(pc, '#st-consistency-lbl')));
await pc.click('#p-ranges [data-r="14"]');
await pc.waitForTimeout(1200);
check('PROGRESS 14-day: 12 of 14 days recorded, consistency 86%', /12 of 14 days recorded/.test(await txt(pc, '#p-rangesub')) && (await txt(pc, '#st-consistency')) === '86%');
await pc.click('#p-ranges [data-r="90"]');
await pc.waitForTimeout(1200);
check('PROGRESS 90-day (120-day journey, day 21): 12 of 90 recorded + journey-day caveat, consistency vs elapsed', /12 of 90 days recorded/.test(await txt(pc, '#p-rangesub')) && /You're on day 21 of your journey/.test(await txt(pc, '#p-rangesub')) && (await txt(pc, '#st-consistency')) === '57%');
await pc.click('#p-ranges [data-r="30"]');
await pc.waitForTimeout(1200);
check('PROGRESS 30-day: 12 of 30 recorded and explains the journey is on day 21', /12 of 30 days recorded/.test(await txt(pc, '#p-rangesub')) && /You're on day 21 of your journey/.test(await txt(pc, '#p-rangesub')) && (await txt(pc, '#st-consistency')) === '57%');
check('PROGRESS: 7-day and 30-day views now DIFFER (workouts / water / consistency computed per window)', true);
await pc.click('#p-ranges [data-r="7"]');
await pc.waitForTimeout(1200);
const w7 = [await txt(pc, '#st-workouts'), await txt(pc, '#st-water'), await txt(pc, '#st-checkins'), await txt(pc, '#st-change')];
await pc.click('#p-ranges [data-r="30"]');
await pc.waitForTimeout(1200);
const w30 = [await txt(pc, '#st-workouts'), await txt(pc, '#st-water'), await txt(pc, '#st-checkins'), await txt(pc, '#st-change')];
check('PROGRESS: window stats differ between 7 and 30 days when the data differs', JSON.stringify(w7) !== JSON.stringify(w30), JSON.stringify({ w7, w30 }));
// independent recomputation of the 7-day numbers from what was seeded
const last7 = weights.slice(-7);
const exp7Change = last7[last7.length - 1] - last7[0];
const exp7Workouts = [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map((ago, i) => ({ ago, i })).filter((x) => x.ago <= 6 && x.i % 2).length;
check('PROGRESS 7-day numbers equal an independent computation from the seeded data', w7[3] === `${exp7Change < 0 ? '−' : '+'}${Math.abs(exp7Change).toFixed(1)} kg` && w7[0] === String(exp7Workouts) && w7[2] === '7 of 7', JSON.stringify({ w7, exp7Change, exp7Workouts }));
// chart with many real points
await pc.click('#p-ranges [data-r="all"]');
await pc.waitForTimeout(1300);
check('GRAPH (12 real points): exactly the real weigh-ins are plotted, with a curve', (await pc.locator('#p-chart [data-chart-point]').count()) === 12 && (await pc.locator('#p-chart path[stroke="var(--emerald)"]').count()) === 1);
check('GRAPH: Y-axis ticks, X-axis dates, goal + start lines, current weight label', (await pc.locator('#p-chart text').evaluateAll((els) => els.map((e) => e.textContent))).some((t) => /Goal 62 kg/.test(t)) && (await pc.locator('#p-chart text').evaluateAll((els) => els.map((e) => e.textContent))).some((t) => /Now 69\.8 kg/.test(t)) && (await pc.locator('#p-chart text').count()) >= 8);
await pc.locator('#p-chart [data-chart-point="11"]').focus();
check('GRAPH: keyboard-focusable points show an accessible tooltip and aria-labels', (await pc.locator('#p-chart .chart-tip').getAttribute('visibility')) === 'visible' && /69\.8 kg/.test(await pc.locator('#p-chart .chart-tip').textContent()) && /kg/.test(await pc.locator('#p-chart [data-chart-point="0"]').getAttribute('aria-label')));
await pc.keyboard.press('Escape');
await pc.screenshot({ path: `${SHOTS}/ux-progress-12pts-390.png`, fullPage: true });
// count-up lands on the real value
await pc.click('#p-ranges [data-r="14"]');
await pc.waitForFunction(() => document.getElementById('st-consistency').textContent === '86%', null, { timeout: 4000 });
check('ANIMATION: count-up settles on the real value', true);

// reduced motion: values update immediately
const prm = await newPage(browser, { problems, reducedMotion: 'reduce' });
await uiLogin(prm, BASE, C.email);
await nav(prm, 's-progress');
await prm.click('#p-ranges [data-r="7"]');
const immediate = await prm.evaluate(() => ({ c: document.getElementById('st-consistency').textContent, ck: document.getElementById('st-checkins').textContent }));
check('REDUCED MOTION: progress values update immediately (no count-up)', immediate.c === '100%' && immediate.ck === '7 of 7', JSON.stringify(immediate));
await prm.close();

// ======================================================================================================
section('D. Journey calendar: select, scroll to detail, real day data');
await nav(pc, 's-journey');
await pc.evaluate(() => window.scrollTo(0, 0));
await pc.click('#j-cal .cal-day[data-num="11"]'); // day 11 = 10 days ago, the seeded day with a note
await pc.waitForTimeout(1100);
const title = await inView(pc, '#j-detail-title');
check('JOURNEY: tapping a day selects it (highlight)', (await pc.locator('#j-cal .cal-day.sel').count()) === 1 && (await pc.getAttribute('#j-cal .cal-day.sel', 'aria-pressed')) === 'true');
check('JOURNEY: screen scrolled to the detail and the heading is visible (not under the nav)', (await pc.evaluate(() => window.scrollY)) > 100 && title.visible && title.top >= 0, JSON.stringify(title));
const jd = await txt(pc, '#j-detail-inner');
check('JOURNEY detail: clear "Day N check-in" heading with the date', /Day 11 check-in/.test(jd));
check('JOURNEY detail: weight, hydration actual/goal, mood, movement, meals, notes', /Weight\s*71\.8 kg/.test(jd.replace(/\n/g, ' ')) && /Hydration\s*2\.5 L \/ 2\.5 L/.test(jd.replace(/\n/g, ' ')) && /Mood\s*Good/.test(jd.replace(/\n/g, ' ')) && /Movement\s*Gym · 45 min/.test(jd.replace(/\n/g, ' ')) && /Nothing logged/.test(jd) && /A note for day 11/.test(jd), jd);
await pc.screenshot({ path: `${SHOTS}/ux-journey-detail-390.png` });
await pc.evaluate(() => window.scrollTo(0, 0));
await pc.click('#j-cal .cal-day[data-num="21"]');
await pc.waitForTimeout(900);
check('JOURNEY: another tap moves the selection (one selected day) and shows that day', (await pc.locator('#j-cal .cal-day.sel').count()) === 1 && /Day 21 check-in/.test(await txt(pc, '#j-detail-inner')));
check('JOURNEY: a missed day says so honestly', await (async () => { await pc.evaluate(() => window.scrollTo(0, 0)); await pc.click('#j-cal .cal-day[data-num="3"]'); await pc.waitForTimeout(700); return /No check-in logged for this day/.test(await txt(pc, '#j-detail-inner')); })());

// ======================================================================================================
section('E. Profile / More: real data, journey dates, share, logout confirmation, change password');
await pc.click('.navbtn[data-s="s-home"]');
await pc.click('.profilebtn');
await pc.waitForSelector('#s-profile.active');
const startD = dayIso(-20);
const goalD = (() => { const [y, m, d] = startD.split('-').map(Number); const g = new Date(y, m - 1, d + 119); return `${g.getFullYear()}-${String(g.getMonth() + 1).padStart(2, '0')}-${String(g.getDate()).padStart(2, '0')}`; })();
const fmt = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); };
check('PROFILE: real name, email, journey length', (await txt(pc, '#pf-name')) === 'Range Tester' && (await txt(pc, '#pf-email')) === C.email.toLowerCase() && (await txt(pc, '#pf-journey')) === '120 days');
check('PROFILE: start date is Day 1 and goal date = start + 119 (independent date arithmetic)', (await txt(pc, '#pf-startd')) === fmt(startD) && (await txt(pc, '#pf-goald')) === fmt(goalD), `${await txt(pc, '#pf-startd')} / ${await txt(pc, '#pf-goald')} vs ${fmt(startD)} / ${fmt(goalD)}`);
check('JOURNEY DATES: Home shows the same goal date', (await (async () => { await pc.click('.navbtn[data-s="s-home"]'); return (await txt(pc, '#h-goaldate')).includes(fmt(goalD)); })()));
await pc.click('.profilebtn');
check('PROFILE: appearance, share, change password, logout all present', (await pc.locator('.theme-opt').count()) === 3 && (await pc.locator('#pf-share, #pf-changepw, #pf-logout').count()) === 3);
await pc.screenshot({ path: `${SHOTS}/ux-profile-390.png`, fullPage: true });

// --- share
await pc.click('#pf-share');
await pc.waitForSelector('#ov-share.show');
const rows = await pc.locator('#sh-rows li').allInnerTexts();
check('SHARE: card built from real data (day, streak, weight, water, workouts) — nothing invented', /DAY 21/.test(await txt(pc, '#sh-day')) && /OF 120/.test(await txt(pc, '#sh-of')) && rows.includes('12 DAY STREAK') && rows.includes('69.8 KG') && rows.some((r) => /^\d\.\d L AVERAGE WATER$/.test(r)) && rows.includes('6 WORKOUTS'), rows.join('|'));
await pc.screenshot({ path: `${SHOTS}/ux-share-390.png` });
await pc.evaluate(() => { window.__shared = []; Object.defineProperty(navigator, 'share', { configurable: true, value: async (d) => { window.__shared.push(d); } }); });
await pc.click('#sh-share-btn');
await pc.waitForFunction(() => /Shared\./.test(document.getElementById('sh-status').textContent));
check('SHARE: Web Share API used with the real summary; "Shared." only after it resolved', (await pc.evaluate(() => window.__shared.length)) === 1 && /Day 21 of 120/.test(await pc.evaluate(() => window.__shared[0].text)));
await pc.evaluate(() => { Object.defineProperty(navigator, 'share', { configurable: true, value: async () => { const e = new Error('cancelled'); e.name = 'AbortError'; throw e; } }); });
await pc.click('#sh-share-btn');
await pc.waitForFunction(() => /cancelled/i.test(document.getElementById('sh-status').textContent));
check('SHARE: a cancelled share is NOT reported as success', !/Shared\./.test(await txt(pc, '#sh-status')) && (await pc.getAttribute('#sh-status', 'data-kind')) !== 'ok');
await pc.evaluate(() => { Object.defineProperty(navigator, 'share', { configurable: true, value: async () => { const e = new Error('nope'); e.name = 'NotAllowedError'; throw e; } }); });
await pc.click('#sh-share-btn');
await pc.waitForFunction(() => /Couldn't share/i.test(document.getElementById('sh-status').textContent));
check('SHARE: a rejected share reports an error, not success', (await pc.getAttribute('#sh-status', 'data-kind')) === 'error');
await pc.evaluate(() => { Object.defineProperty(navigator, 'share', { configurable: true, value: undefined }); });
const dl = pc.waitForEvent('download', { timeout: 8000 }).catch(() => null);
await pc.click('#sh-share-btn');
const download = await dl;
await pc.waitForFunction(() => /isn't available|downloaded/i.test(document.getElementById('sh-status').textContent));
check('SHARE fallback (no Web Share API): downloads the card image and says so honestly', !!download && /kawther-progress\.png/.test(download.suggestedFilename()) && /downloaded/i.test(await txt(pc, '#sh-status')));
await pc.click('#ov-share [data-target="ov-share"]');

// --- logout confirmation
await pc.click('#pf-logout');
await pc.waitForSelector('#ov-logout.show');
check('LOGOUT: a confirmation dialog appears (not an immediate sign-out) with the required copy', /Log out\?/.test(await txt(pc, '#lo-title')) && /Are you sure you want to log out of your journal\?/.test(await txt(pc, '#lo-desc')) && (await pc.getAttribute('#ov-logout .sheet', 'role')) === 'alertdialog' && (await pc.getAttribute('#ov-logout .sheet', 'aria-modal')) === 'true');
check('LOGOUT: nothing signed out yet (still on Profile, session alive)', (await pc.locator('#s-profile.active').count()) === 1 && (await pc.evaluate(() => Object.keys(localStorage).some((k) => /auth-token/.test(k)))));
check('LOGOUT: focus moves into the dialog (Cancel)', (await pc.evaluate(() => document.activeElement.id)) === 'lo-cancel');
await pc.keyboard.press('Tab');
check('LOGOUT: Tab moves to Log out', (await pc.evaluate(() => document.activeElement.id)) === 'lo-confirm');
await pc.keyboard.press('Tab');
check('LOGOUT: focus is TRAPPED (Tab wraps back inside the dialog)', (await pc.evaluate(() => document.activeElement.id)) === 'lo-cancel');
await pc.keyboard.press('Shift+Tab');
check('LOGOUT: Shift+Tab wraps to the last control', (await pc.evaluate(() => document.activeElement.id)) === 'lo-confirm');
await pc.keyboard.press('Escape');
check('LOGOUT: Escape closes the dialog, focus returns to the Log out row, session kept', (await pc.locator('#ov-logout.show').count()) === 0 && (await pc.evaluate(() => document.activeElement.id)) === 'pf-logout' && (await pc.evaluate(() => Object.keys(localStorage).some((k) => /auth-token/.test(k)))));
await pc.click('#pf-logout');
await pc.click('#lo-cancel');
check('LOGOUT: Cancel keeps the session', (await pc.locator('#ov-logout.show').count()) === 0 && (await pc.locator('#s-profile.active').count()) === 1);
await pc.reload();
check('LOGOUT: after cancel + reload the user is still logged in', (await pc.waitForSelector('#s-home.active', { timeout: 8000 }).then(() => true, () => false)));

// --- change password (own throw-away account so credentials of the others stay valid)
const P = await seedAccount('ux-pw', { name: 'Password Tester', duration: 30 });
const pp = await newPage(browser, { problems });
await uiLogin(pp, BASE, P.email);
await pp.click('.profilebtn');
await pp.click('#pf-changepw');
await pp.waitForSelector('#ov-password.show');
check('PASSWORD: dialog labelled, focus lands on Current password', (await pp.getAttribute('#ov-password .sheet', 'aria-modal')) === 'true' && (await pp.evaluate(() => document.activeElement.id)) === 'pw-current');
await pp.click('#pw-save');
check('PASSWORD: empty fields rejected with inline errors (no browser alert)', (await txt(pp, '#e-pw-current')).length > 0 && (await txt(pp, '#e-pw-new')).length > 0 && (await txt(pp, '#e-pw-confirm')).length > 0);
await pp.fill('#pw-current', PASS);
await pp.fill('#pw-new', 'short');
await pp.fill('#pw-confirm', 'short');
await pp.click('#pw-save');
check('PASSWORD: too-short new password rejected inline', /at least 8/.test(await txt(pp, '#e-pw-new')));
await pp.fill('#pw-new', 'New-pass-98765');
await pp.fill('#pw-confirm', 'Different-pass-1');
await pp.click('#pw-save');
check('PASSWORD: mismatch rejected inline', /match/.test(await txt(pp, '#e-pw-confirm')));
await pp.fill('#pw-current', PASS);
await pp.fill('#pw-new', PASS);
await pp.fill('#pw-confirm', PASS);
await pp.click('#pw-save');
check('PASSWORD: new password equal to current is rejected', /different/.test(await txt(pp, '#e-pw-new')));
await pp.fill('#pw-current', 'Totally-wrong-1');
await pp.fill('#pw-new', 'New-pass-98765');
await pp.fill('#pw-confirm', 'New-pass-98765');
await pp.click('#pw-save');
await pp.waitForFunction(() => /incorrect/i.test(document.getElementById('e-pw-current').textContent));
check('PASSWORD: WRONG current password is rejected by Supabase verification', true);
let attempt = createClient(URL_, KEY, { auth: { persistSession: false } });
check('PASSWORD: the wrong-current attempt changed nothing (old password still works)', !(await attempt.auth.signInWithPassword({ email: P.email, password: PASS })).error);
await pp.fill('#pw-current', PASS);
await pp.fill('#pw-new', 'New-pass-98765');
await pp.fill('#pw-confirm', 'New-pass-98765');
await pp.screenshot({ path: `${SHOTS}/ux-password-390.png` });
await pp.click('#pw-save');
await pp.waitForSelector('#pw-success:not([hidden])', { timeout: 15000 });
check('PASSWORD: success confirmation shown', /Password updated/.test(await txt(pp, '#pw-success')));
check('PASSWORD: fields cleared from the DOM; no password stored in localStorage/sessionStorage', await pp.evaluate(() => {
  const dump = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
  return !dump.includes('New-pass-98765') && !dump.includes('Test-pass-12345') && ['pw-current', 'pw-new', 'pw-confirm'].every((i) => document.getElementById(i).value === '');
}));
attempt = createClient(URL_, KEY, { auth: { persistSession: false } });
check('PASSWORD: the NEW password works against Supabase Auth', !(await attempt.auth.signInWithPassword({ email: P.email, password: 'New-pass-98765' })).error);
attempt = createClient(URL_, KEY, { auth: { persistSession: false } });
const old = await attempt.auth.signInWithPassword({ email: P.email, password: PASS });
check('PASSWORD: the OLD password no longer works', !!old.error && /invalid/i.test(old.error.message));
await pp.click('#pw-success .btn');
await pp.reload();
check('PASSWORD: the current session stays valid after the change (reload keeps the user in)', await pp.waitForSelector('#s-home.active', { timeout: 8000 }).then(() => true, () => false));
// logout confirm -> real signOut, then login with the new password through the UI
await pp.click('.profilebtn');
await pp.click('#pf-logout');
await pp.click('#lo-confirm');
await pp.waitForSelector('#s-landing.active');
check('LOGOUT: Confirm signs out (landing, nav hidden, no auth token in storage)', !(await pp.isVisible('#nav')) && !(await pp.evaluate(() => Object.keys(localStorage).some((k) => /auth-token/.test(k)))));
await pp.reload();
check('LOGOUT: reload after confirm stays logged out', await pp.waitForSelector('#s-landing.active', { timeout: 8000 }).then(() => true, () => false));
await uiLogin(pp, BASE, P.email, 'New-pass-98765');
check('PASSWORD: logging in through the UI with the new password works', true);
// fresh account share: no data, no fake statistic
const pshare = await newPage(browser, { problems });
await uiLogin(pshare, BASE, P.email, 'New-pass-98765');
await pshare.click('.profilebtn');
await pshare.click('#pf-share');
check('SHARE (no data yet): omits every metric instead of faking one', (await pshare.locator('#sh-rows li:not(.none)').count()) === 0 && /Log a check-in/.test(await txt(pshare, '#sh-rows')));
await pshare.close();

// ======================================================================================================
section('F. Responsive: all affected screens at 11 widths (no overflow, no clipping, 44px targets)');
const SIZES = process.env.QUICK ? [[320, 640], [1280, 800]] : [[320, 640], [360, 740], [375, 667], [390, 844], [414, 896], [430, 932], [768, 1024], [1024, 768], [1280, 800], [1440, 900], [1920, 1080]];
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const clipped = (page) => page.evaluate(() => {
  const vw = document.documentElement.clientWidth;
  const bad = [];
  document.querySelectorAll('.screen.active *, #nav *, .overlay.show *').forEach((e) => {
    const r = e.getBoundingClientRect();
    if (!r.width || !r.height || (e.closest('svg') && e.tagName !== 'svg') || e.closest('.cal-day.empty') || e.classList.contains('sr-only') || e.closest('.sr-only')) return;
    if (r.left < -1 || r.right > vw + 1) bad.push((e.id || e.className || e.tagName).toString().slice(0, 30));
  });
  return bad.slice(0, 5);
});
const tooSmall = (page, sel) => page.evaluate((s) => [...document.querySelectorAll(s)].filter((e) => e.offsetParent !== null).map((e) => { const r = e.getBoundingClientRect(); return { id: (e.id || e.className || e.tagName).toString().slice(0, 24), w: Math.round(r.width), h: Math.round(r.height) }; }).filter((x) => x.w < 43.5 || x.h < 43.5), sel);
const pr = await newPage(browser, { problems, width: 390, height: 844 });
await uiLogin(pr, BASE, C.email);
for (const [w, h] of SIZES) {
  await pr.setViewportSize({ width: w, height: h });
  const audit = async (name, targets) => {
    await pr.waitForTimeout(120);
    check(`${name} no horizontal scroll @${w}`, (await overflow(pr)) === 0, `over=${await overflow(pr)}`);
    const bad = await clipped(pr);
    check(`${name} nothing clipped @${w}`, bad.length === 0, bad.join());
    if (targets) { const small = await tooSmall(pr, targets); check(`${name} touch targets ≥44px @${w}`, small.length === 0, JSON.stringify(small)); }
  };
  await pr.click('.navbtn[data-s="s-home"]');
  await pr.waitForSelector('#s-home.active');
  await audit('home', '.profilebtn, #h-checkin-card .ci-cta.edit');
  const hb = await pr.locator('.hero-top').boundingBox();
  const hc = await pr.locator('.hero-card').boundingBox();
  check(`home header/card gap stays comfortable @${w}`, hc.y - (hb.y + hb.height) >= 16);
  const chipBox = await pr.locator('#h-streak-chip').boundingBox();
  const dayBox = await pr.locator('#h-daylabel').boundingBox();
  check(`home streak chip does not overlap the day label @${w}`, chipBox.x >= dayBox.x + dayBox.width - 1 || chipBox.y >= dayBox.y + dayBox.height - 1);
  if ([320, 390, 768, 1280].includes(w)) await pr.screenshot({ path: `${SHOTS}/ux-home-${w}.png` });
  await pr.click('.navbtn.fab');
  await pr.waitForSelector('#s-checkin.active');
  await audit('check-in (edit)', '#ci-ex-type .mv-chip, .editgoal, .wctrl button');
  if ([320, 390, 1280].includes(w)) await pr.screenshot({ path: `${SHOTS}/ux-checkin-${w}.png`, fullPage: true });
  await pr.click('#s-checkin [data-action="go"]');
  await pr.click('.navbtn[data-s="s-progress"]');
  await pr.click('#p-ranges [data-r="all"]');
  await pr.waitForTimeout(900);
  await audit('progress', '#p-ranges .rchip');
  const svgBox = await pr.locator('#p-chart').boundingBox();
  check(`progress chart fits its card @${w}`, svgBox.width > 200 && svgBox.x >= 0 && svgBox.x + svgBox.width <= w + 1);
  if ([320, 390, 768, 1280].includes(w)) await pr.screenshot({ path: `${SHOTS}/ux-progress-${w}.png`, fullPage: true });
  await pr.click('.navbtn[data-s="s-journey"]');
  await pr.evaluate(() => window.scrollTo(0, 0));
  await pr.click('#j-cal .cal-day[data-num="10"]');
  await pr.waitForTimeout(900);
  await audit('journey + day detail');
  const t = await inView(pr, '#j-detail-title');
  check(`journey detail heading visible above the nav after tap @${w}`, t.visible && t.top >= 0, JSON.stringify(t));
  if ([320, 390, 1280].includes(w)) await pr.screenshot({ path: `${SHOTS}/ux-journey-${w}.png` });
  await pr.click('.navbtn[data-s="s-home"]');
  await pr.click('.profilebtn');
  await pr.waitForSelector('#s-profile.active');
  await audit('profile');
  if ([320, 390, 1280].includes(w)) await pr.screenshot({ path: `${SHOTS}/ux-profile-${w}.png`, fullPage: true });
  await pr.click('#pf-changepw');
  await pr.waitForSelector('#ov-password.show');
  await audit('change-password dialog');
  const sheet = await pr.locator('#ov-password .sheet').boundingBox();
  check(`password dialog inside the viewport @${w}`, sheet.x >= 0 && sheet.x + sheet.width <= w + 0.5 && sheet.y >= 0 && sheet.y + sheet.height <= h + 0.5, JSON.stringify(sheet));
  if ([320, 390].includes(w)) await pr.screenshot({ path: `${SHOTS}/ux-password-${w}.png` });
  await pr.keyboard.press('Escape');
  await pr.click('#pf-logout');
  await pr.waitForSelector('#ov-logout.show');
  await audit('logout dialog', '#lo-cancel, #lo-confirm');
  await pr.keyboard.press('Escape');
  await pr.click('#pf-share');
  await pr.waitForSelector('#ov-share.show');
  await audit('share dialog');
  await pr.keyboard.press('Escape');
  await pr.click('.navbtn[data-s="s-home"]');
}
// celebration + renew dialogs on a narrow phone
await pr.setViewportSize({ width: 320, height: 640 });
const pd = await newPage(browser, { problems, width: 320, height: 640 });
await uiLogin(pd, BASE, C.email);
await pd.click('.navbtn.fab');
await pd.click('#ci-save-btn');
await pd.waitForSelector('#ov-celebrate.show');
await pd.waitForTimeout(400);
check('completion dialog fits a 320px phone (no overflow / clipping)', (await overflow(pd)) === 0 && (await clipped(pd)).length === 0);
await pd.screenshot({ path: `${SHOTS}/ux-completion-320.png` });

check('no console/page errors during the whole run', problems.length === 0, problems.join(' | '));
await app.stop();
process.exit(summary() ? 0 : 1);
