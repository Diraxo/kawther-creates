import { $ } from '../lib/dom.js';
import { REDUCE, animateNum } from '../lib/motion.js';
import { ARROW_SVG } from '../lib/icons.js';
import { state } from '../state.js';
import { formatDate, todayStr } from '../domain/dates.js';
import {
  currentDayIndex, goalDate, goalProgressPct, homeMotivation, latestWeight, waterGoalOf, weightDeltaText,
} from '../domain/journey.js';
import { computeStreak } from '../domain/streak.js';
import { formatExercise, formatLitres, mealCount } from '../domain/checkin.js';
import { capitalize, esc } from '../lib/format.js';
import { showNav, tab } from '../ui/router.js';
import { openOverlay } from '../ui/overlays.js';

export function enterHome() {
  showNav(true);
  tab('s-home');
  renderHome();
}

/** The streak chip in the journey card's top-right corner (see domain/streak.js for the rules). */
function renderStreak(streak) {
  const chip = $('h-streak-chip');
  let text;
  let state_;
  if (streak.status === 'interrupted') { text = 'Streak paused'; state_ = 'paused'; }
  else if (streak.current > 0) { text = `${streak.current} day streak`; state_ = 'active'; }
  else { text = 'No streak yet'; state_ = 'none'; }
  chip.dataset.state = state_;
  $('h-streak').textContent = text;
  const banner = $('h-renew');
  banner.hidden = streak.status !== 'interrupted';
  if (!banner.hidden) {
    const n = streak.interruptedLength;
    const best = streak.best > n ? ` Your best is ${streak.best} days.` : '';
    $('h-renew-text').textContent = `Your ${n}-day streak is paused — you missed a day.${best}`;
  }
}

function summaryItem(label, value) {
  return `<div class="ci-sum-item"><span>${label}</span><b>${esc(value)}</b></div>`;
}

function renderCheckinCard(user, today) {
  const todays = user.checkins[today];
  const first = !Object.keys(user.checkins).length;
  const card = $('h-checkin-card');
  card.classList.toggle('done', !!todays);
  const summary = $('h-ci-summary');
  if (!todays) {
    $('h-ci-eyebrow').textContent = 'TODAY';
    $('h-ci-title').textContent = first ? 'Start your first check-in' : 'How are you taking care of yourself today?';
    summary.hidden = true;
    summary.innerHTML = '';
    $('h-ci-cta').className = 'ci-cta';
    $('h-ci-cta').innerHTML = (first ? 'Begin' : 'Check in') + ' ' + ARROW_SVG;
    card.setAttribute('aria-label', first ? 'Begin your first check-in' : 'Start today\'s check-in');
    return;
  }
  const goal = waterGoalOf(user.journey);
  $('h-ci-eyebrow').textContent = "TODAY'S CHECK-IN · ✓ COMPLETE";
  $('h-ci-title').textContent = "Today's check-in is complete";
  summary.hidden = false;
  const meals = mealCount(todays);
  summary.innerHTML = [
    summaryItem('Weight', todays.weight ? `${todays.weight.toFixed(1)} kg` : 'Not logged'),
    summaryItem('Water', `${formatLitres(todays.water || 0)} / ${formatLitres(goal)}`),
    summaryItem('Movement', todays.exercise ? formatExercise(todays.exercise) : 'Rest day'),
    summaryItem('Mood', todays.mood ? capitalize(todays.mood) : 'Not logged'),
    summaryItem('Meals', meals ? `${meals} logged` : 'None logged'),
  ].join('');
  $('h-ci-cta').className = 'ci-cta edit';
  $('h-ci-cta').innerHTML = 'Edit check-in ' + ARROW_SVG;
  card.setAttribute('aria-label', "Edit today's check-in");
}

/** "Renew your streak": a motivational confirmation; the real streak restarts with the next saved check-in. */
export function openRenew() {
  const s = computeStreak(state.user.checkins, todayStr());
  const n = s.interruptedLength;
  $('rn-sub').textContent = n
    ? `Your ${n}-day streak is part of your story${s.best > n ? ` (your best is ${s.best} days)` : ''}. Ready to keep going?`
    : 'Ready to keep going?';
  openOverlay('ov-renew');
}

export function renderHome() {
  const { user } = state;
  const today = todayStr();
  $('h-name').textContent = user.name;
  const hr = new Date().getHours();
  $('h-greet').textContent = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  const day = currentDayIndex(user.journey, today);
  const dur = user.journey.duration;
  $('h-daylabel').textContent = `DAY ${day} OF ${dur}`;
  $('h-goaldate').textContent = `Goal date · ${formatDate(goalDate(user.journey))}`;
  animateNum($('h-daynum'), day, 0, 600);
  const circ = 264;
  const off = circ - (day / dur) * circ;
  $('h-ringfg').style.transition = REDUCE ? 'none' : 'stroke-dashoffset 1s cubic-bezier(.2,.8,.2,1)';
  setTimeout(() => { $('h-ringfg').style.strokeDashoffset = off; }, REDUCE ? 0 : 80);

  const streak = computeStreak(user.checkins, today);
  renderStreak(streak);
  const w = latestWeight(user);
  $('h-weight').textContent = w.toFixed(1) + ' kg';
  $('h-delta').textContent = weightDeltaText(user.journey.startWeight, w);
  $('h-goal').textContent = user.journey.goalWeight + ' kg';
  const pct = goalProgressPct(user.journey, w);
  animateNum($('h-pct'), pct, 0, 900, '%');
  setTimeout(() => { $('h-track').style.width = pct + '%'; }, REDUCE ? 0 : 80);
  $('h-motiv').textContent = homeMotivation(day, dur, streak.current, pct, !!user.checkins[today]);
  renderCheckinCard(user, today);
}
