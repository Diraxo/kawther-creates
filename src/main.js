// Style order matters: these are the prototype's stylesheet in source order.
import './styles/base.css';
import './styles/logo.css';
import './styles/forms.css';
import './styles/onboarding.css';
import './styles/home.css';
import './styles/checkin.css';
import './styles/progress.css';
import './styles/journey.css';
import './styles/achievements.css';
import './styles/nav.css';
import './styles/overlays.css';
import './styles/profile.css';
import './styles/checkin-refinements.css';
import './styles/journey-detail.css';
import './styles/feedback.css';
import './styles/polish.css';
import './styles/goal.css';
import './styles/complete.css';
import './styles/movement.css';

import { state } from './state.js';
import { $ } from './lib/dom.js';
import { classifyError } from './data/errors.js';
import { initRepository, getRepo } from './data/repository.js';
import { initTheme, setTheme } from './ui/theme.js';
import { go, onTab, showNav, tab } from './ui/router.js';
import { withBusy } from './ui/busy.js';
import { initNetwork, syncNow } from './ui/network.js';
import { closeOverlay } from './ui/overlays.js';
import { confirmLogout, doLogin, doLogout, doSignup, updateLoginButton, updateSignupButton } from './screens/auth.js';
import { finishOnboarding, obStep2, obStep3, obStep4, onDurInput, pickDur, stepDur } from './screens/onboarding.js';
import { enterHome, openRenew, renderHome } from './screens/home.js';
import { chooseGoalMode, goalNext, showGoalExperience, goalSkip, onNewGoalSubmit, replayGoal } from './ui/goalExperience.js';
import { journeyCompleteBack, journeyCompleteNext, onJourneyFormSubmit, pickChapter, showJourneyComplete } from './ui/journeyComplete.js';
import {
  addMeal, adjWater, askDeleteMeal, confirmMeal, deleteMealFromModal, doDeleteMeal, editMeal,
  onWaterInput, openCheckin, openGoalEdit, pickMood, renderMeals, saveCheckin, saveGoal, setExercise,
  pickMovementType, toggleMuscle, toggleOtherMuscle, addCustomMuscle, onMovementKeydown,
} from './screens/checkin.js';
import { applyCustomRange, renderProgress, setRange } from './screens/progress.js';
import { renderJourney, showDay } from './screens/journey.js';
import { openAchDetail, renderAch } from './screens/achievements.js';
import { openProfile, renderProfile } from './screens/profile.js';
import { doShare, openShare, saveShareImage } from './screens/share.js';
import { openPassword, savePassword } from './screens/password.js';
import { mfaCancel, mfaConfirm, mfaRemoveCancel, mfaRemoveConfirm, mfaRemoveStart, mfaStart, openMfa } from './screens/mfa.js';

// data-action name -> handler. Markup stays declarative; no inline onclick.
const actions = {
  go: (el) => {
    go(el.dataset.target);
    if (el.dataset.target === 's-login') updateLoginButton();
    else if (el.dataset.target === 's-signup') updateSignupButton();
  },
  reload: () => location.reload(),
  'retry-boot': (el) => withBusy(el, 'Reconnecting…', loadApp),
  tab: (el) => tab(el.dataset.s),
  signup: doSignup,
  login: doLogin,
  logout: doLogout,
  'confirm-logout': confirmLogout,
  'open-password': openPassword,
  'open-mfa': openMfa,
  'mfa-start': mfaStart,
  'mfa-confirm': mfaConfirm,
  'mfa-cancel': mfaCancel,
  'mfa-remove': (el) => mfaRemoveStart(el.dataset.id),
  'mfa-remove-confirm': mfaRemoveConfirm,
  'mfa-remove-cancel': mfaRemoveCancel,
  'open-renew': openRenew,
  'celebrate-again': replayGoal,
  'goal-choose': (el) => chooseGoalMode(el.dataset.mode, el),
  'change-goal-focus': () => showGoalExperience({ choicesOnly: true }),
  'reached-next': goalNext,
  'reached-skip': goalSkip,
  'reached-choose': (el) => chooseGoalMode(el.dataset.mode, el),
  'journey-complete-open': () => showJourneyComplete(),
  'journey-complete-next': journeyCompleteNext,
  'journey-complete-back': journeyCompleteBack,
  'chapter-choose': (el) => pickChapter(el.dataset.kind),
  'continue-journey': () => { closeOverlay('ov-renew'); openCheckin(); },
  'pick-move': (el) => pickMovementType(el.dataset.type),
  'toggle-muscle': (el) => toggleMuscle(el.dataset.muscle),
  'toggle-other-muscle': toggleOtherMuscle,
  'add-muscle': addCustomMuscle,
  'apply-custom-range': applyCustomRange,
  'do-share': doShare,
  'save-share-image': saveShareImage,
  'ob-step2': obStep2,
  'ob-step3': obStep3,
  'pick-dur': pickDur,
  'dur-step': stepDur,
  'finish-onboarding': obStep4,
  'enter-home': enterHome,
  'open-profile': openProfile,
  'open-share': openShare,
  'set-theme': (el) => setTheme(el.dataset.t),
  'open-checkin': openCheckin,
  'pick-mood': pickMood,
  'edit-goal': openGoalEdit,
  'save-goal': saveGoal,
  'adj-water': (el) => adjWater(Number(el.dataset.n)),
  'add-meal': (el) => addMeal(el.dataset.cat),
  'edit-meal': (el) => editMeal(el.dataset.cat, Number(el.dataset.i)),
  'ask-delete-meal': (el) => askDeleteMeal(el, el.dataset.cat, Number(el.dataset.i)),
  'do-delete-meal': (el) => doDeleteMeal(el.dataset.cat, Number(el.dataset.i)),
  'cancel-delete-meal': (el) => renderMeals(el.dataset.cat),
  'confirm-meal': confirmMeal,
  'delete-meal-modal': deleteMealFromModal,
  'set-exercise': (el) => setExercise(el.dataset.yes === 'true'),
  'save-checkin': saveCheckin,
  'set-range': setRange,
  'show-day': (el) => showDay(el.dataset.date, Number(el.dataset.num), el),
  'open-ach': (el) => openAchDetail(el.dataset.id),
  'close-overlay': (el) => closeOverlay(el.dataset.target),
  'toggle-pw': (el) => {
    const input = el.parentElement.querySelector('input');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    el.setAttribute('aria-pressed', String(show));
    el.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  },
};

document.addEventListener('input', (e) => {
  if (e.target.id === 'ob-dur') onDurInput();
  else if (e.target.id === 'ci-water-input') onWaterInput();
});
document.addEventListener('submit', (e) => {
  if (e.target.id === 'pw-form') savePassword(e);
  else if (e.target.id === 'rc-newgoal') onNewGoalSubmit(e);
  else if (e.target.id === 'jc-form') onJourneyFormSubmit(e);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'p-custom-days') { e.preventDefault(); applyCustomRange(); }
  onMovementKeydown(e);
});

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const fn = actions[el.dataset.action];
  if (fn) fn(el, e);
});

// Keyboard: Enter or Space activates any non-native control (role="button" divs), like a real button.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const el = e.target.closest && e.target.closest('[data-action]');
  if (e.key === ' ' && e.target !== el) return; // never swallow a space typed inside a nested field
  if (el && !['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) {
    e.preventDefault();
    el.click();
  }
});

/** Resolves after the next paint (with a fallback for hidden tabs, where rAF never fires). */
const afterPaint = () => new Promise((resolve) => {
  const t = setTimeout(resolve, 300);
  requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(t); resolve(); }));
});

/** Fade the branded splash out once the first real screen has actually been painted (no artificial delay). */
async function hideSplash() {
  const el = document.getElementById('splash');
  if (!el) return;
  await afterPaint();
  el.classList.add('out');
  setTimeout(() => el.remove(), 500);
}

function showLoadError({ title, message, fatal = false }) {
  state.status = 'error';
  $('err-retry').dataset.action = fatal ? 'reload' : 'retry-boot'; // a misconfigured build can only be fixed by reloading
  showNav(false);
  $('err-title').textContent = title;
  $('err-msg').textContent = message;
  go('s-error');
}

/** What went wrong, in words she can act on. Never a blank screen, never substitute data. */
function describeLoadError(e) {
  const offline = navigator.onLine === false || classifyError(e).code === 'NETWORK';
  return offline
    ? { title: "You're offline", message: 'Reconnect to continue syncing your journal.' }
    : { title: "We couldn't load your journal", message: 'Something went wrong on our side. Please try again.' };
}

/**
 * Restores the session, loads the user's data and routes to the right first screen. Used by boot AND by the error
 * screen's Retry. Whatever happens, some real screen ends up active: the destination, or an explained error.
 */
async function loadApp() {
  state.status = 'loading';
  try {
    const user = await getRepo().getSession();
    if (user) {
      state.user = user;
      state.status = 'ready';
      if (user.onboarded) enterHome();
      else { showNav(false); go('s-ob1'); }
    } else {
      state.user = null;
      state.status = 'signed-out';
      showNav(false);
      go('s-landing');
    }
  } catch (e) {
    console.error(e);
    showLoadError(describeLoadError(e));
  }
}

async function boot() {
  try {
    initTheme();
  } catch (e) {
    console.error(e); // a broken theme must never keep the splash up forever
  }
  try {
    await initRepository();
  } catch (e) {
    console.error(e);
    showLoadError({ title: "We couldn't load your journal", message: "This app isn't configured correctly. Please contact support.", fatal: true });
    await hideSplash();
    return;
  }
  await loadApp();
  await hideSplash();
}

/** Re-render whichever data screen is showing after fresh data was merged in (never while she is mid-edit). */
function rerenderVisible(hasSession) {
  if (!hasSession) {
    state.user = null;
    state.status = 'signed-out';
    showNav(false);
    document.querySelectorAll('.overlay.show').forEach((o) => o.classList.remove('show'));
    go('s-login');
    updateLoginButton();
    return;
  }
  if (!state.user || document.querySelector('.overlay.show')) return;
  const active = document.querySelector('.screen.active');
  const render = { 's-home': renderHome, 's-progress': renderProgress, 's-journey': renderJourney, 's-ach': renderAch, 's-profile': renderProfile }[active && active.id];
  if (render) render();
}

initNetwork({ afterSync: rerenderVisible });
// Coming back to the app after a while (or the next day): quietly re-read her data so Home never shows a stale "today".
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  if (hiddenAt && Date.now() - hiddenAt > 60000 && state.status === 'ready') syncNow({ silent: true });
});
// A page restored from the back/forward cache never re-runs boot(): start clean, splash first.
window.addEventListener('pageshow', (e) => { if (e.persisted) location.reload(); });

onTab('s-progress', renderProgress);
onTab('s-journey', renderJourney);
onTab('s-ach', renderAch);
boot();
