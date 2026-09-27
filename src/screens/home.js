import { $ } from '../lib/dom.js';
import { REDUCE, animateNum } from '../lib/motion.js';
import { ARROW_SVG } from '../lib/icons.js';
import { state } from '../state.js';
import { formatDate, todayStr } from '../domain/dates.js';
import {
  currentDayIndex, goalDate, homeMotivation, latestWeight, waterGoalOf, weightDeltaText,
} from '../domain/journey.js';
import { computeStreak } from '../domain/streak.js';
import { activeTarget, goalAchievement, goalCopy, progressToward, postGoalSummary } from '../domain/goal.js';
import { formatExercise, formatLitres, mealCount } from '../domain/checkin.js';
import { movementDetail } from '../domain/movement.js';
import { capitalize, esc } from '../lib/format.js';
import { showNav, tab } from '../ui/router.js';
import { openOverlay } from '../ui/overlays.js';
import { isJourneyEnded, journeyRecap, recapCopy } from '../domain/journeyComplete.js';
import { maybeCelebrateJourneyComplete } from '../ui/journeyComplete.js';

const CHOICES = [['new_goal', 'Set a new goal'], ['maintain', 'Maintain'], ['journal', 'Keep journaling']];

export function enterHome() {
  renderHome(); // fully rendered from the loaded user BEFORE the screen is shown: no empty shell, ever
  showNav(true);
  tab('s-home');
  maybeCelebrateJourneyComplete();
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

function summaryItem(label, value, sub = '') {
  return `<div class="ci-sum-item"><span>${label}</span><b>${esc(value)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;
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
    todays.exercise
      ? summaryItem('Movement', formatExercise(todays.exercise), movementDetail(todays.exercise))
      : summaryItem('Movement', 'Rest day', 'Recovery is part of the journey.'),
    summaryItem('Mood', todays.mood ? capitalize(todays.mood) : 'Not logged'),
    summaryItem('Meals', meals ? `${meals} logged` : 'None logged'),
  ].join('');
  $('h-ci-cta').className = 'ci-cta edit';
  $('h-ci-cta').innerHTML = 'Edit check-in ' + ARROW_SVG;
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

/** The permanent "Goal Achieved" card, and what she chose to focus on for the rest of the journey. */
function renderGoalCard(user) {
  const card = $('h-goalcard');
  const a = user.unlocked.includes('goal') ? goalAchievement(user) : null;
  card.hidden = !a;
  if (!a) return;
  const c = goalCopy(a);
  $('h-gc-weight').textContent = c.weight;
  $('h-gc-line').textContent = `You reached your goal on Day ${a.day}.`;
  $('h-gc-early').textContent = c.earlyLine;
  const next = $('h-gc-next');
  if (c.remaining <= 0) { next.innerHTML = ''; return; }
  const summary = postGoalSummary(user.journey);
  next.innerHTML = summary
    ? `<div class="gc-focus"><span>${esc(summary)}</span><button type="button" data-action="change-goal-focus">Change focus</button></div>`
    : `<h4>Your ${a.duration}-day journey continues</h4><p>What would you like to focus on next?</p>
       <div class="gc-choices">${CHOICES.map(([m, t]) => `<button type="button" data-action="goal-choose" data-mode="${m}">${t}</button>`).join('')}</div>`;
}

/** The permanent "Journey Complete" card: shown from the journey's last day until she starts the next journey. */
function renderJourneyCard(user, today) {
  const card = $('h-journeycard');
  const ended = isJourneyEnded(user.journey, today);
  card.hidden = !ended;
  if (!ended) return;
  const c = recapCopy(journeyRecap(user));
  $('h-jc-title').textContent = c.headline;
  $('h-jc-line').textContent = c.lines[0];
}

/** "JOURNEY 2 · DAY 3 OF 90", or "JOURNEY 2 · BEGINS <date>" when the next journey starts tomorrow. */
function dayLabel(user, day, dur, today) {
  const n = (user.pastJourneys || []).length;
  const prefix = n ? `JOURNEY ${n + 1} · ` : '';
  return user.journey.start > today ? `${prefix}BEGINS ${formatDate(user.journey.start).toUpperCase()}` : `${prefix}DAY ${day} OF ${dur}`;
}

export function renderHome() {
  const { user } = state;
  if (!user || !user.journey) return; // not loaded is not the same as empty: never render a half-state
  const today = todayStr();
  $('h-name').textContent = user.name;
  const hr = new Date().getHours();
  $('h-greet').textContent = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  const day = currentDayIndex(user.journey, today);
  const dur = user.journey.duration;
  $('h-daylabel').textContent = dayLabel(user, day, dur, today);
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
  const target = activeTarget(user.journey);
  $('h-goal-label').textContent = target.label;
  $('h-goal').textContent = target.to + ' kg';
  const pct = progressToward(target.from, target.to, w);
  animateNum($('h-pct'), pct, 0, 900, '%');
  setTimeout(() => { $('h-track').style.width = pct + '%'; }, REDUCE ? 0 : 80);
  $('h-motiv').textContent = homeMotivation(day, dur, streak.current, pct, !!user.checkins[today]);
  renderGoalCard(user);
  renderJourneyCard(user, today);
  renderCheckinCard(user, today);
}
