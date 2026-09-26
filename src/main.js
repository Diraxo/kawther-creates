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

import { state } from './state.js';
import { $ } from './lib/dom.js';
import { classifyError } from './data/errors.js';
import { initRepository, getRepo } from './data/repository.js';
import { initTheme, setTheme } from './ui/theme.js';
import { go, onTab, showNav, tab } from './ui/router.js';
import { closeOverlay } from './ui/overlays.js';
import { confirmLogout, doLogin, doLogout, doSignup } from './screens/auth.js';
import { finishOnboarding, obStep2, obStep3, obStep4, onDurInput, pickDur, stepDur } from './screens/onboarding.js';
import { enterHome, openRenew } from './screens/home.js';
import { chooseGoalMode, goalNext, showGoalExperience, goalSkip, onNewGoalSubmit, replayGoal } from './ui/goalExperience.js';
import { journeyCompleteBack, journeyCompleteNext, onJourneyFormSubmit, pickChapter, showJourneyComplete } from './ui/journeyComplete.js';
import {
  addMeal, adjWater, askDeleteMeal, confirmMeal, deleteMealFromModal, doDeleteMeal, editMeal,
  onWaterInput, openCheckin, openGoalEdit, pickMood, renderMeals, saveCheckin, saveGoal, setExUnit, setExercise,
} from './screens/checkin.js';
import { applyCustomRange, renderProgress, setRange } from './screens/progress.js';
import { renderJourney, showDay } from './screens/journey.js';
import { openAchDetail, renderAch } from './screens/achievements.js';
import { openProfile } from './screens/profile.js';
import { doShare, openShare, saveShareImage } from './screens/share.js';
import { openPassword, savePassword } from './screens/password.js';

// data-action name -> handler. Markup stays declarative; no inline onclick.
const actions = {
  go: (el) => go(el.dataset.target),
  reload: () => location.reload(),
  tab: (el) => tab(el.dataset.s),
  signup: doSignup,
  login: doLogin,
  logout: doLogout,
  'confirm-logout': confirmLogout,
  'open-password': openPassword,
  'open-renew': openRenew,
  'celebrate-again': replayGoal,
  'goal-choose': (el) => chooseGoalMode(el.dataset.mode),
  'change-goal-focus': () => showGoalExperience({ choicesOnly: true }),
  'reached-next': goalNext,
  'reached-skip': goalSkip,
  'reached-choose': (el) => chooseGoalMode(el.dataset.mode),
  'journey-complete-open': () => showJourneyComplete(),
  'journey-complete-next': journeyCompleteNext,
  'journey-complete-back': journeyCompleteBack,
  'chapter-choose': (el) => pickChapter(el.dataset.kind),
  'continue-journey': () => { closeOverlay('ov-renew'); openCheckin(); },
  'set-ex-unit': (el) => setExUnit(el.dataset.unit),
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

/** Fade the branded splash out as soon as the first real screen is ready (no artificial delay). */
function hideSplash() {
  const el = document.getElementById('splash');
  if (!el) return;
  el.classList.add('out');
  setTimeout(() => el.remove(), 500);
}

function showLoadError(message) {
  showNav(false);
  $('err-msg').textContent = message;
  go('s-error');
}

async function boot() {
  initTheme();
  try {
    await initRepository();
  } catch (e) {
    console.error(e);
    showLoadError("This app isn't configured correctly. Please contact support.");
    hideSplash();
    return;
  }
  try {
    const user = await getRepo().getSession();
    if (user) {
      state.user = user;
      if (user.onboarded) enterHome();
      else go('s-ob1');
    } else {
      showNav(false);
      go('s-landing');
    }
  } catch (e) {
    // Never substitute local/fake data: say what happened and let the user retry.
    console.error(e);
    showLoadError(classifyError(e).code === 'NETWORK'
      ? "Can't reach the server. Check your connection and try again."
      : "We couldn't load your data. Please try again.");
  }
  hideSplash();
}

onTab('s-progress', renderProgress);
onTab('s-journey', renderJourney);
onTab('s-ach', renderAch);
boot();
