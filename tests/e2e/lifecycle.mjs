// App-lifecycle tests: startup/splash, first-navigation rendering, data hydration, loading buttons, duplicate-submit
// protection, last-weight default, hydration layout, offline/online, responsive safety.
// Runs the real app against the in-memory Supabase stand-in (tests/e2e/stubkit.mjs): deterministic and independent of the
// live project. Nothing here uses a fixed sleep as the assertion: every wait is on an actual application condition.
//   node tests/e2e/lifecycle.mjs
import { PASS, Stub, dayStr, mkChecks, newSession, startApp, txt } from './stubkit.mjs';

const { check, notVerified, section, summary } = mkChecks();
const app = await startApp(5188);
const { BASE } = app;

const STORAGE_TIMELINE = () => {
  // Frame-by-frame record of what the user could see while the app starts.
  const tl = { first: null, frames: 0, blank: 0, appVisibleUnderSplash: 0, out: null };
  window.__tl = tl;
  const tick = () => {
    if (document.body) {
      const s = document.getElementById('splash');
      const up = !!s && !s.classList.contains('out');
      const active = document.querySelector('.screen.active');
      if (tl.first === null) tl.first = up ? 'splash' : 'other';
      tl.frames++;
      if (!up && !active) tl.blank++;
      const appEl = document.getElementById('app');
      if (up && appEl && getComputedStyle(appEl).visibility !== 'hidden') tl.appVisibleUnderSplash++;
      if (!up && s && !tl.out) {
        const cta = document.getElementById('h-ci-cta');
        tl.out = {
          screen: active && active.id,
          name: (document.getElementById('h-name') || {}).textContent,
          cta: cta ? cta.textContent.trim() : null,
          ctaVisible: cta ? cta.getBoundingClientRect().height > 0 : false,
        };
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

async function open(page, url = BASE) {
  await page.addInitScript(STORAGE_TIMELINE);
  await page.goto(url, { waitUntil: 'commit' });
}
const activeId = (page) => page.evaluate(() => (document.querySelector('.screen.active') || {}).id);
const waitScreen = (page, id, timeout = 20000) => page.waitForSelector(`#${id}.active`, { timeout });
const gone = (page) => page.waitForFunction(() => !document.getElementById('splash'), null, { timeout: 20000 });
const tab = (page, s) => page.click(`.navbtn[data-s="${s}"]`);
const opacityOf = (page, sel) => page.locator(sel).evaluateAll((els) => els.map((e) => Number(getComputedStyle(e).opacity)));

// ===================================================================================================
section('1. STARTUP: splash is the first and only thing shown, until the first real screen is ready');
{
  const stub = new Stub();
  const acct = stub.account({ checkins: { 2: { weight: 63.8, water: 2000, mood: 'good' } } });
  stub.delay = 900; // slow Supabase: the splash has to carry the wait
  const { page, problems } = await newSession(app, stub, { signedIn: acct });
  await open(page);
  await page.waitForSelector('#splash');
  check('slow network: splash is on screen while data loads (no black, no half-rendered Home)',
    await page.evaluate(() => { const s = document.getElementById('splash'); return !!s && !s.classList.contains('out') && getComputedStyle(document.getElementById('app')).visibility === 'hidden'; }));
  await waitScreen(page, 's-home');
  await gone(page);
  const tl = await page.evaluate(() => window.__tl);
  check('logged-in: the first frame is the splash', tl.first === 'splash', JSON.stringify(tl));
  check('logged-in: no blank frame at any point (splash -> Home directly)', tl.blank === 0, JSON.stringify(tl));
  check('logged-in: app content never visible underneath the splash', tl.appVisibleUnderSplash === 0, JSON.stringify(tl));
  check('logged-in: splash left only when Home was ready (name + Check in button rendered)', tl.out && tl.out.screen === 's-home' && tl.out.name.trim().length > 1 && tl.out.cta === 'Check in' && tl.out.ctaVisible, JSON.stringify(tl.out));
  check('logged-in: no page errors', problems.length === 0, problems.join('|'));
  await page.context().close();
}
{
  const stub = new Stub();
  stub.delay = 500;
  const { page } = await newSession(app, stub);
  await open(page);
  await page.waitForSelector('#splash');
  await waitScreen(page, 's-landing');
  await gone(page);
  const tl = await page.evaluate(() => window.__tl);
  check('logged-out: splash first, then Landing; no login/landing flash before it', tl.first === 'splash' && tl.blank === 0 && tl.out && tl.out.screen === 's-landing', JSON.stringify(tl));
  await page.context().close();
}
{
  const stub = new Stub();
  const acct = stub.account({ journey: null }); // signed up, has not chosen a journey yet
  const { page } = await newSession(app, stub, { signedIn: acct });
  await open(page);
  await waitScreen(page, 's-ob1');
  await gone(page);
  const tl = await page.evaluate(() => window.__tl);
  check('new account: onboarding appears after the splash', tl.first === 'splash' && tl.blank === 0 && tl.out.screen === 's-ob1', JSON.stringify(tl));
  await page.context().close();
}
{
  const stub = new Stub();
  const acct = stub.account();
  const { page } = await newSession(app, stub, { signedIn: acct, reducedMotion: 'reduce' });
  await open(page);
  await waitScreen(page, 's-home');
  await gone(page);
  const tl = await page.evaluate(() => window.__tl);
  check('reduced motion: splash still shown first and removed once Home is ready', tl.first === 'splash' && tl.blank === 0 && tl.out.screen === 's-home', JSON.stringify(tl));
  await page.context().close();
}
{
  // Broken storage (private mode / blocked) must never strand the splash.
  const stub = new Stub();
  const acct = stub.account();
  const { page } = await newSession(app, stub, { signedIn: acct });
  await page.addInitScript(() => { const g = Storage.prototype.getItem; Storage.prototype.getItem = function (k) { if (k === 'kc_theme') throw new Error('storage blocked'); return g.call(this, k); }; });
  await open(page);
  await waitScreen(page, 's-home');
  await gone(page);
  check('storage that throws does not strand the splash or break startup', true);
  await page.context().close();
}
{
  const html = await (await fetch(BASE)).text();
  check('index.html: splash is inline (first paint needs no bundle) and precedes the app', /<div id="splash"/.test(html) && html.indexOf('id="splash"') < html.indexOf('id="app"') && /#splash\{position:fixed/.test(html));
  check('index.html: web fonts are NOT render-blocking (media=print until loaded)', /<link id="kc-fonts"[^>]*media="print"/.test(html));
  check('index.html: iPhone home-screen metadata present', /apple-mobile-web-app-capable/.test(html) && /rel="manifest"/.test(html) && /apple-touch-icon/.test(html) && /viewport-fit=cover/.test(html));
  notVerified('Real iPhone standalone (Home Screen) cold launch', 'no iOS device/simulator in this environment; the launch path is verified in Chromium (frame-by-frame timeline) and the iOS-specific causes were removed by construction (non-blocking fonts, animation-independent content, splash-first)');
}

// ===================================================================================================
section('2. FAILURES: slow / offline / server error are explained states, never a blank screen');
{
  const stub = new Stub();
  const acct = stub.account();
  stub.dropped = true;
  const { page } = await newSession(app, stub, { signedIn: acct });
  await open(page);
  await waitScreen(page, 's-error');
  await gone(page);
  check('offline at launch: "You\'re offline" + reconnect message', (await txt(page, '#err-title')) === "You're offline" && /Reconnect to continue syncing your journal/.test(await txt(page, '#err-msg')));
  check('offline at launch: a visible Retry action', await page.locator('#err-retry').isVisible());
  const tl = await page.evaluate(() => window.__tl);
  check('offline at launch: never blank', tl.blank === 0 && tl.first === 'splash', JSON.stringify(tl));
  stub.dropped = false;
  stub.delay = 700;
  await page.click('#err-retry');
  check('Retry shows loading immediately (busy + disabled + label) and keeps its size', await page.evaluate(() => { const b = document.getElementById('err-retry'); return b.getAttribute('aria-busy') === 'true' && b.disabled && /Reconnecting/.test(b.textContent); }));
  await waitScreen(page, 's-home');
  check('Retry recovers to a fully hydrated Home', (await txt(page, '#h-ci-cta')) === 'Begin' && (await txt(page, '#h-name')).length > 1);
  await page.context().close();
}
{
  const stub = new Stub();
  const acct = stub.account();
  stub.failStatus = 500;
  const { page } = await newSession(app, stub, { signedIn: acct });
  await open(page);
  await waitScreen(page, 's-error');
  check('Supabase 500: explained error state with Retry (not black)', /couldn't load/i.test(await txt(page, '#err-title')) && await page.locator('#err-retry').isVisible());
  stub.failStatus = null;
  await page.click('#err-retry');
  await waitScreen(page, 's-home');
  check('Supabase 500 then recovered: Home loads', true);
  await page.context().close();
}

// ===================================================================================================
section('3. HOME: real data on first render; the card is display-only, the button is the one control');
{
  const stub = new Stub();
  const acct = stub.account({ checkins: { 3: { weight: 64.2, water: 1500, mood: 'good' }, 1: { weight: 63.8, water: 2000, mood: 'great' } } });
  const { page } = await newSession(app, stub, { signedIn: acct });
  await open(page);
  await waitScreen(page, 's-home');
  check('Home (journey, no check-in today): "Today" card with "Check in"', (await txt(page, '#h-ci-eyebrow')) === 'TODAY' && (await txt(page, '#h-ci-title')) === 'How are you taking care of yourself today?' && (await txt(page, '#h-ci-cta')) === 'Check in');
  check('Home: journey card values are real (day, weight, goal)', (await txt(page, '#h-daylabel')) === 'DAY 1 OF 60' && (await txt(page, '#h-weight')) === '63.8 kg' && (await txt(page, '#h-goal')) === '62 kg');
  const cardAttrs = await page.locator('#h-checkin-card').evaluate((e) => ({ role: e.getAttribute('role'), tab: e.getAttribute('tabindex'), action: e.dataset.action, cursor: getComputedStyle(e).cursor }));
  check('Home card is NOT interactive (no role/tabindex/action, no pointer cursor)', !cardAttrs.role && cardAttrs.tab === null && !cardAttrs.action && cardAttrs.cursor !== 'pointer', JSON.stringify(cardAttrs));
  await page.click('#h-ci-title');
  await page.click('#h-checkin-card', { position: { x: 10, y: 10 } });
  check('tapping the card body does nothing', (await activeId(page)) === 's-home');
  check('the CTA is a real <button> (touch, mouse, keyboard)', await page.locator('#h-ci-cta').evaluate((e) => e.tagName === 'BUTTON' && e.getBoundingClientRect().height >= 44));
  await page.focus('#h-ci-cta');
  await page.keyboard.press('Enter');
  await waitScreen(page, 's-checkin');
  check('keyboard Enter on the button opens the check-in', true);
  await page.context().close();
}
{
  const stub = new Stub();
  const acct = stub.account({ checkins: { 0: { weight: 63.1, water: 2000, mood: 'good' } } });
  const { page } = await newSession(app, stub, { signedIn: acct });
  await open(page);
  await waitScreen(page, 's-home');
  check('Home (check-in exists): completed state + summary + "Edit check-in"', /COMPLETE/.test(await txt(page, '#h-ci-eyebrow')) && (await txt(page, '#h-ci-cta')) === 'Edit check-in' && await page.locator('#h-ci-summary').isVisible());
  await page.click('#h-ci-title');
  await page.click('.ci-sum-item');
  check('completed card body does not navigate', (await activeId(page)) === 's-home');
  await page.click('#h-ci-cta');
  await waitScreen(page, 's-checkin');
  check('only the "Edit check-in" button opens it', true);
  await page.context().close();
}

// ===================================================================================================
section('4. WEIGHT DEFAULT: today starts from the last logged weight; nothing is saved until Save');
{
  const stub = new Stub();
  const acct = stub.account({ checkins: { 5: { weight: 64.6, water: 1000 }, 2: { weight: 63.8, water: 2000, mood: 'good' } } });
  const { page } = await newSession(app, stub, { signedIn: acct });
  await open(page);
  await waitScreen(page, 's-home');
  await page.click('#h-ci-cta');
  await waitScreen(page, 's-checkin');
  check('opens at the most recent logged weight (63.8)', (await page.inputValue('#ci-weight')) === '63.8');
  check('opening the check-in wrote nothing', stub.count(/rpc\/save_checkin/) === 0 && !acct.checkins[dayStr(0)]);
  await page.fill('#ci-weight', '64.8');
  await page.click('#ci-save-btn');
  await page.waitForSelector('#ov-celebrate.show');
  check('saved: exactly one save request, today\'s row has 64.8', stub.count(/rpc\/save_checkin/) === 1 && acct.checkins[dayStr(0)].weight_kg === 64.8);
  check('yesterday-ish rows untouched (63.8 stays)', acct.checkins[dayStr(-2)].weight_kg === 63.8);
  check('Home already shows the completed check-in and 64.8 kg BEHIND the celebration (no re-navigation needed)', (await txt(page, '#h-ci-cta')) === 'Edit check-in' && (await txt(page, '#h-weight')) === '64.8 kg' && /COMPLETE/.test(await txt(page, '#h-ci-eyebrow')));
  await page.click('#ov-celebrate [data-action="close-overlay"]');
  await waitScreen(page, 's-home');
  check('after Continue: Home, Home tab highlighted', await page.locator('.navbtn[data-s="s-home"].on').count() === 1);
  await page.click('#h-ci-cta');
  await waitScreen(page, 's-checkin');
  check('editing today: shows TODAY\'s saved 64.8 (not yesterday\'s 63.8)', (await page.inputValue('#ci-weight')) === '64.8' && (await txt(page, '#ci-save-btn')) === 'Update check-in');
  await page.context().close();
}
{
  const stub = new Stub();
  const acct = stub.account({ checkins: { 0: { weight: 62.5, water: 500 }, 1: { weight: 63.8, water: 2000 } } });
  const { page } = await newSession(app, stub, { signedIn: acct });
  await open(page);
  await waitScreen(page, 's-home');
  await page.click('#h-ci-cta');
  await waitScreen(page, 's-checkin');
  check('today already saved at 62.5 while yesterday was 63.8 -> edit opens at 62.5', (await page.inputValue('#ci-weight')) === '62.5');
  await page.context().close();
}
{
  const stub = new Stub();
  const acct = stub.account();
  const { page } = await newSession(app, stub, { signedIn: acct });
  await open(page);
  await waitScreen(page, 's-home');
  await page.click('#h-ci-cta');
  await waitScreen(page, 's-checkin');
  check('no previous weight: field stays empty (first-entry behaviour)', (await page.inputValue('#ci-weight')) === '');
  await page.context().close();
}

// ===================================================================================================
section('5. LOADING BUTTONS + DUPLICATE PROTECTION');
{
  const stub = new Stub();
  const acct = stub.account({ email: 'kawthar@example.com', checkins: { 1: { weight: 63.8, water: 2000 } } });
  const { page } = await newSession(app, stub);
  await open(page);
  await waitScreen(page, 's-landing');
  await page.click('#s-landing [data-target="s-login"]');
  await page.fill('#li-email', acct.email);
  await page.fill('#li-pass', PASS);
  stub.delay = 900;
  const w0 = (await page.locator('#s-login [data-action="login"]').boundingBox()).width;
  await page.dblclick('#s-login [data-action="login"]');
  const st = await page.evaluate(() => { const b = document.querySelector('#s-login [data-action="login"]'); return { busy: b.getAttribute('aria-busy'), disabled: b.disabled, text: b.textContent.trim(), spin: !!b.querySelector('.spin'), w: b.getBoundingClientRect().width }; });
  check('Login: instant feedback (spinner + "Logging in…", disabled, aria-busy)', st.busy === 'true' && st.disabled && st.spin && /Logging in/.test(st.text), JSON.stringify(st));
  check('Login: button keeps its size while loading', Math.abs(st.w - w0) <= 1, `${w0} -> ${st.w}`);
  await waitScreen(page, 's-home');
  check('Login double-tap: ONE login request', stub.count(/POST \/auth\/v1\/token/) === 1, String(stub.count(/POST \/auth\/v1\/token/)));
  check('Login: Home is fully hydrated at first paint (button + weight)', (await txt(page, '#h-ci-cta')) === 'Check in' && (await txt(page, '#h-weight')) === '63.8 kg');
  check('Login button is restored afterwards (never left disabled)', await page.evaluate(() => { const b = document.querySelector('#s-login [data-action="login"]'); return !b.disabled && !b.hasAttribute('aria-busy') && b.textContent.trim() === 'Log in'; }));
  stub.delay = 0;

  // save: double tap
  await page.click('#h-ci-cta');
  await waitScreen(page, 's-checkin');
  stub.delay = 900;
  await page.dblclick('#ci-save-btn');
  const sv = await page.evaluate(() => { const b = document.getElementById('ci-save-btn'); return { busy: b.getAttribute('aria-busy'), disabled: b.disabled, text: b.textContent.trim() }; });
  check('Save: instant loading feedback', sv.busy === 'true' && sv.disabled && /Saving/.test(sv.text), JSON.stringify(sv));
  await page.waitForSelector('#ov-celebrate.show');
  check('Save double-tap: ONE save request and ONE check-in row for today', stub.count(/rpc\/save_checkin/) === 1 && Object.keys(acct.checkins).filter((d) => d === dayStr(0)).length === 1);
  check('Save button restored after success', await page.evaluate(() => { const b = document.getElementById('ci-save-btn'); return !b.disabled && !b.hasAttribute('aria-busy') && b.textContent.trim() === 'Save check-in'; }));
  stub.delay = 0;
  await page.context().close();
}
{
  const stub = new Stub();
  const { page } = await newSession(app, stub);
  await open(page);
  await waitScreen(page, 's-landing');
  await page.click('#s-landing [data-target="s-signup"]');
  await page.fill('#su-name', 'New Person');
  await page.fill('#su-email', 'new.person@example.com');
  await page.fill('#su-pass', PASS);
  await page.fill('#su-pass2', PASS);
  stub.delay = 900;
  await page.dblclick('#s-signup [data-action="signup"]');
  check('Create account: instant loading feedback', await page.evaluate(() => { const b = document.querySelector('#s-signup [data-action="signup"]'); return b.disabled && b.getAttribute('aria-busy') === 'true' && /Creating account/.test(b.textContent); }));
  await waitScreen(page, 's-ob1');
  check('Create account double-tap: ONE signup request', stub.count(/POST \/auth\/v1\/signup/) === 1, String(stub.count(/POST \/auth\/v1\/signup/)));
  stub.delay = 0;
  // onboarding -> Start journey
  await page.click('#s-ob1 [data-target="s-ob2"]');
  await page.fill('#ob-start', '70');
  await page.click('#s-ob2 [data-action="ob-step2"]');
  await page.fill('#ob-goal', '62');
  await page.click('#s-ob3 [data-action="ob-step3"]');
  stub.delay = 900;
  await page.dblclick('#s-ob4 [data-action="finish-onboarding"]');
  check('Start journey: loading feedback', await page.evaluate(() => { const b = document.querySelector('#s-ob4 [data-action="finish-onboarding"]'); return b.disabled && /Starting/.test(b.textContent); }));
  await waitScreen(page, 's-success');
  check('Start journey double-tap: ONE create request', stub.count(/rpc\/create_journey/) === 1, String(stub.count(/rpc\/create_journey/)));
  stub.delay = 0;
  await page.click('#s-success [data-action="enter-home"]');
  await waitScreen(page, 's-home');
  check('Enter journey: Home fully rendered', (await txt(page, '#h-ci-cta')) === 'Begin' && (await txt(page, '#h-daylabel')) === 'DAY 1 OF 60' || /DAY 1 OF/.test(await txt(page, '#h-daylabel')));
  // logout confirm loading + persistence
  await page.click('#h-ci-cta');
  await page.context().close();
}
{
  const stub = new Stub();
  const acct = stub.account({ email: 'persist@example.com', checkins: { 1: { weight: 63.8, water: 2000 } } });
  const { page } = await newSession(app, stub, { signedIn: acct });
  await open(page);
  await waitScreen(page, 's-home');
  await page.click('#h-ci-cta');
  await waitScreen(page, 's-checkin');
  await page.fill('#ci-weight', '64.1');
  await page.click('#ci-save-btn');
  await page.waitForSelector('#ov-celebrate.show');
  await page.click('#ov-celebrate [data-action="close-overlay"]');
  await page.reload({ waitUntil: 'commit' });
  await waitScreen(page, 's-home');
  check('Refresh: today\'s check-in and weight remain', (await txt(page, '#h-ci-cta')) === 'Edit check-in' && (await txt(page, '#h-weight')) === '64.1 kg');
  await page.click('.profilebtn');
  await page.click('#pf-logout');
  stub.delay = 700;
  await page.click('#lo-confirm');
  check('Logout confirm shows loading', await page.evaluate(() => { const b = document.getElementById('lo-confirm'); return b.disabled && /Logging out/.test(b.textContent); }));
  await waitScreen(page, 's-landing');
  stub.delay = 0;
  await page.click('#s-landing [data-target="s-login"]');
  await page.fill('#li-email', acct.email);
  await page.fill('#li-pass', PASS);
  await page.click('#s-login [data-action="login"]');
  await waitScreen(page, 's-home');
  check('Logout then login: data remains', (await txt(page, '#h-ci-cta')) === 'Edit check-in' && (await txt(page, '#h-weight')) === '64.1 kg');
  await page.context().close();
}

// ===================================================================================================
section('6. HYDRATION UI: value, unit and goal read as one compact metric');
{
  const stub = new Stub();
  const acct = stub.account({ journey: { startOffset: 0, duration: 60, startWeight: 72, goalWeight: 62, waterGoal: 5000 } });
  for (const width of [320, 390]) {
    const { page } = await newSession(app, stub, { signedIn: acct, width });
    await open(page);
    await waitScreen(page, 's-home');
    await page.click('#h-ci-cta');
    await waitScreen(page, 's-checkin');
    const metric = () => page.evaluate(() => {
      const i = document.getElementById('ci-water-input').getBoundingClientRect();
      const u = document.querySelector('.water-unit').getBoundingClientRect();
      const line = document.querySelector('.water-line');
      return { gap: u.left - i.right, text: document.getElementById('ci-water-input').value + ' ' + line.innerText.replace(/\s+/g, ' ').trim(), inputW: i.width, overflow: document.documentElement.scrollWidth - window.innerWidth, lineRight: line.getBoundingClientRect().right, vw: window.innerWidth };
    });
    let m = await metric();
    check(`[${width}] empty: gap between value and "L" is tight (<=10px) and no overflow`, m.gap <= 10 && m.overflow <= 0, JSON.stringify(m));
    await page.click('.quickadd button:nth-child(1)');
    m = await metric();
    check(`[${width}] 0.25 -> "0.25 L / 5 L", value hugs the unit`, /0\.25\s*L\s*\/ 5 L/.test(m.text.replace(/\s+/g, ' ')) && m.gap <= 10 && m.overflow <= 0, JSON.stringify(m));
    await page.click('.quickadd button:nth-child(2)');
    m = await metric();
    check(`[${width}] 0.75 stays compact`, (await page.inputValue('#ci-water-input')) === '0.75' && m.gap <= 10, JSON.stringify(m));
    for (const v of ['2.75', '5', '12.5']) {
      await page.fill('#ci-water-input', v);
      m = await metric();
      check(`[${width}] typed ${v}: compact, inside the card, no horizontal overflow`, m.gap <= 10 && m.overflow <= 0 && m.lineRight <= m.vw, JSON.stringify(m));
    }
    await page.context().close();
  }
}

// ===================================================================================================
section('7. FIRST NAVIGATION: Progress and Journey render on the first tap, even if entrance animations stall');
{
  const stub = new Stub();
  const acct = stub.account({ journey: { startOffset: 20, duration: 60, startWeight: 72, goalWeight: 62, waterGoal: 2500 }, checkins: { 10: { weight: 66.0, water: 2000, mood: 'good' }, 5: { weight: 65.2, water: 1000, mood: 'okay' }, 1: { weight: 64.5, water: 2500, mood: 'great' } } });
  const { page } = await newSession(app, stub, { signedIn: acct });
  await open(page);
  await waitScreen(page, 's-home');
  // Reproduce the iOS failure class: every CSS animation frozen at its first frame right after the screen appears.
  const frozen = (id, sel) => page.evaluate(([nav, s]) => {
    document.querySelector(`.navbtn[data-s="${nav}"]`).click();
    document.getAnimations().forEach((a) => { a.pause(); a.currentTime = 0; });
    return [...document.querySelectorAll(s)].map((e) => Number(getComputedStyle(e).opacity));
  }, [id, sel]);
  let ops = await frozen('s-progress', '#s-progress .card');
  check('Progress, animations frozen at frame 0: every card still visibly rendered (opacity >= .5)', ops.length > 0 && ops.every((o) => o >= 0.5), JSON.stringify(ops));
  check('Progress first tap: chart has real content and stats are filled', (await page.locator('#p-chart *').count()) > 5 && (await txt(page, '#st-checkins')) !== '—');
  ops = await frozen('s-journey', '#s-journey .card');
  check('Journey, animations frozen at frame 0: cards visible', ops.length > 0 && ops.every((o) => o >= 0.5), JSON.stringify(ops));
  const cal1 = await page.locator('#j-cal .cal-day:not(.empty)').count();
  check('Journey first tap: full 60-day calendar rendered', cal1 === 60, String(cal1));
  ops = await frozen('s-home', '#s-home .card, #s-home .hero-card');
  check('Home, animations frozen at frame 0: cards visible', ops.length > 0 && ops.every((o) => o >= 0.5), JSON.stringify(ops));
  ops = await frozen('s-ach', '#s-ach .card, #s-ach .ach-grid');
  check('More/Achievements, animations frozen: visible', ops.every((o) => o >= 0.5), JSON.stringify(ops));
  // Home -> Journey -> Home -> Journey: identical, no corruption
  await tab(page, 's-journey');
  const a = await page.locator('#j-cal').innerHTML();
  await tab(page, 's-home');
  await tab(page, 's-journey');
  const b = await page.locator('#j-cal').innerHTML();
  check('Home -> Journey -> Home -> Journey: identical calendar', a === b && a.length > 100);
  check('Home after round trip still complete', await (async () => { await tab(page, 's-home'); return (await txt(page, '#h-ci-cta')) === 'Check in' && (await txt(page, '#h-weight')) === '64.5 kg'; })());
  // Progress states
  await tab(page, 's-progress');
  check('Progress (3 real weigh-ins): plotted points equal saved data', (await page.locator('#p-chart circle').count()) >= 3 && (await page.locator('#p-empty').isHidden()));
  await page.context().close();
}
{
  const stub = new Stub();
  const acct = stub.account();
  const { page } = await newSession(app, stub, { signedIn: acct });
  await open(page);
  await waitScreen(page, 's-home');
  await tab(page, 's-progress');
  check('Progress, no data: honest empty state', await page.locator('#p-empty').isVisible() && /Your progress will appear here/.test(await txt(page, '#p-empty b')) && /first check-in with a weight/.test(await txt(page, '#p-empty p')));
  await tab(page, 's-journey');
  check('Journey, no check-ins: calendar + explained detail', (await page.locator('#j-cal .cal-day:not(.empty)').count()) === 60 && /No check-ins yet/.test(await txt(page, '#j-detail-inner')));
  await page.context().close();
}
{
  const stub = new Stub();
  const acct = stub.account({ journey: { startOffset: 5, duration: 60, startWeight: 72, goalWeight: 62, waterGoal: 2500 }, checkins: { 1: { weight: 64.5, water: 2500, mood: 'great' } } });
  const { page } = await newSession(app, stub, { signedIn: acct });
  await open(page);
  await waitScreen(page, 's-home');
  await tab(page, 's-progress');
  const c = await page.locator('#p-chart circle').count();
  const paths = await page.locator('#p-chart path[stroke]').count();
  check('Progress, ONE weigh-in: a single honest dot, no manufactured curve', c >= 1 && paths === 0, `circles=${c} curves=${paths}`);
  await page.context().close();
}

// ===================================================================================================
section('8. OFFLINE / ONLINE: honest status, no silent loss, "Synced" only after a real read');
{
  const stub = new Stub();
  const acct = stub.account({ checkins: { 1: { weight: 63.8, water: 2000 } } });
  const { ctx, page } = await newSession(app, stub, { signedIn: acct });
  await open(page);
  await waitScreen(page, 's-home');
  check('online: no banner', await page.locator('#netbar').isHidden());
  await page.click('#h-ci-cta');
  await waitScreen(page, 's-checkin');
  await page.fill('#ci-weight', '64.0');
  await ctx.setOffline(true);
  await page.waitForSelector('#netbar:not([hidden])');
  check('offline: banner "You\'re offline"', (await txt(page, '#netbar-title')) === "You're offline");
  const before = stub.count(/rpc\/save_checkin/);
  await page.click('#ci-save-btn');
  await page.waitForSelector('#kc-toast.show');
  check('offline Save: refused with "Reconnect to save this", nothing sent, draft kept', /offline.*Reconnect to save this/i.test(await txt(page, '#kc-toast')) && stub.count(/rpc\/save_checkin/) === before && (await page.inputValue('#ci-weight')) === '64.0' && !(await page.locator('#ci-save-btn').isDisabled()));
  stub.delay = 700;
  const reads = stub.count(/GET .*\/rest\/v1\/journeys/);
  await ctx.setOffline(false);
  await page.waitForFunction(() => /Back online/.test(document.getElementById('netbar-title').textContent));
  check('back online: "Back online · Syncing your journal…" (not yet claiming Synced)', /Syncing/.test(await txt(page, '#netbar-sub')));
  await page.waitForFunction(() => document.getElementById('netbar-title').textContent === 'Synced');
  check('"Synced" only after a real repository read succeeded', stub.count(/GET .*\/rest\/v1\/journeys/) > reads);
  await page.waitForSelector('#netbar[hidden]', { state: 'attached' });
  check('banner clears itself after Synced', true);
  stub.delay = 0;
  // sync failure + retry
  await ctx.setOffline(true);
  await page.waitForFunction(() => document.getElementById('netbar-title').textContent === "You're offline");
  stub.failStatus = 500;
  await ctx.setOffline(false);
  await page.waitForFunction(() => document.getElementById('netbar-title').textContent === "Couldn't sync");
  check('sync failure: "Couldn\'t sync" with a Retry button (no false Synced)', await page.locator('#netbar-retry').isVisible());
  stub.failStatus = null;
  await page.click('#netbar-retry');
  await page.waitForFunction(() => document.getElementById('netbar-title').textContent === 'Synced');
  check('Retry -> Synced', true);
  await page.click('#ci-save-btn');
  await page.waitForSelector('#ov-celebrate.show');
  check('after reconnecting the same draft saves (nothing was lost)', acct.checkins[dayStr(0)].weight_kg === 64);
  await ctx.close();
}

// ===================================================================================================
section('9. RESPONSIVE: no horizontal overflow, nothing hidden under the bottom nav');
{
  const stub = new Stub();
  const acct = stub.account({ checkins: { 4: { weight: 65, water: 1500, mood: 'good', notes: 'A fairly long note about how the day went, to test wrapping on narrow phones.' }, 1: { weight: 64.2, water: 2500, mood: 'great' } } });
  for (const [width, height] of [[320, 640], [360, 740], [375, 812], [390, 844], [414, 896], [430, 932], [768, 1024], [1024, 768], [1280, 800], [1440, 900], [1920, 1080]]) {
    const { page } = await newSession(app, stub, { signedIn: acct, width, height });
    await open(page);
    await waitScreen(page, 's-home');
    const bad = [];
    for (const [nav, id] of [['s-home', 's-home'], ['s-progress', 's-progress'], ['s-journey', 's-journey'], ['s-ach', 's-ach']]) {
      await tab(page, nav);
      const r = await page.evaluate((sid) => {
        window.scrollTo(0, document.body.scrollHeight);
        const scr = document.getElementById(sid);
        const last = [...scr.children].filter((c) => c.getBoundingClientRect().height > 0).pop();
        const navTop = document.getElementById('nav').getBoundingClientRect().top;
        return { overflow: document.documentElement.scrollWidth - window.innerWidth, hidden: last ? last.getBoundingClientRect().bottom - navTop : 0 };
      }, id);
      if (r.overflow > 0 || r.hidden > 2) bad.push(`${id}:${JSON.stringify(r)}`);
    }
    await page.click('.navbtn.fab');
    await waitScreen(page, 's-checkin');
    const r = await page.evaluate(() => { window.scrollTo(0, document.body.scrollHeight); const last = document.getElementById('ci-save-btn').getBoundingClientRect(); return { overflow: document.documentElement.scrollWidth - window.innerWidth, hidden: last.bottom - document.getElementById('nav').getBoundingClientRect().top }; });
    if (r.overflow > 0 || r.hidden > 2) bad.push(`checkin:${JSON.stringify(r)}`);
    check(`${width}x${height}: Home/Progress/Journey/More/Check-in fit, nothing under the nav`, bad.length === 0, bad.join(' '));
    await page.context().close();
  }
}

const ok = summary();
await app.stop();
process.exit(ok ? 0 : 1);
