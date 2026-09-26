// The Journey Complete experience: recap (never "failed"), then "What's next?" which starts a NEW journey.
// All numbers and words come from domain/journeyComplete.js; this file drives the DOM and persistence.
// Closing at any point is safe: the finished journey stays as it is and Home keeps offering the choice.
import { $ } from '../lib/dom.js';
import { reducedMotion } from '../lib/motion.js';
import { reportDataError } from '../lib/dataError.js';
import { toast } from '../lib/toast.js';
import { esc } from '../lib/format.js';
import { state } from '../state.js';
import { getRepo } from '../data/repository.js';
import { JOURNEY_SCOPED } from '../data/mappers.js';
import { todayStr } from '../domain/dates.js';
import { goalDate } from '../domain/journey.js';
import {
  JOURNEY_ACHIEVEMENT, buildNextJourney, chapterOptions, isJourneyEnded, journeyRecap, recapCopy,
} from '../domain/journeyComplete.js';
import { closeOverlay, onOverlayClosed, openOverlay } from './overlays.js';
import { renderHome } from '../screens/home.js';

const ID = 'ov-complete';
let recap = null;
let kind = null;
let busy = false;

const kg = (n) => `${Number(n).toFixed(1).replace(/\.0$/, '')}`;

function fillRecap(r) {
  const c = recapCopy(r);
  $('jc-title').textContent = c.headline;
  $('jc-lines').innerHTML = c.lines.map((l) => `<p>${esc(l)}</p>`).join('');
  $('jc-weights').innerHTML = [
    [`${kg(r.startWeight)} kg`, 'Started'],
    [`${kg(r.finalWeight)} kg`, 'Final'],
    [r.hasWeightGoal ? `${kg(r.goalWeight)} kg` : '—', 'Goal'],
  ].map(([v, l]) => `<div><b>${esc(v)}</b><span>${l}</span></div>`).join('');
  $('jc-stats').innerHTML = c.stats.map(([v, l]) => `<div><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('');
  const note = r.notes[r.notes.length - 1];
  $('jc-note').hidden = !note;
  if (note) {
    const text = note.text.length > 160 ? note.text.slice(0, 157) + '…' : note.text;
    $('jc-note').innerHTML = `“${esc(text)}”<cite>YOUR OWN WORDS</cite>`;
  }
  $('jc-closing').textContent = c.closing;
  $('jc-live').textContent = `${c.headline} ${c.lines.join(' ')}`;
}

function setPhase(phase) {
  const root = $(ID).querySelector('.rc');
  root.dataset.phase = phase;
  root.querySelectorAll('.rc-phase').forEach((s) => {
    const on = s.dataset.phase === phase;
    s.hidden = !on;
    s.setAttribute('aria-hidden', String(!on));
  });
  $('jc-next').hidden = phase !== 'recap';
  $('jc-later').hidden = false;
}

function showOptions() {
  $('jc-options').hidden = false;
  $('jc-form').hidden = true;
  $('jc-options').innerHTML = chapterOptions(recap).map((o) =>
    `<button type="button" class="rc-opt" data-action="chapter-choose" data-kind="${o.kind}"><b>${esc(o.title)}</b><span>${esc(o.sub)}</span></button>`).join('');
}

/** Opens the recap for the ACTIVE journey (only once its last day has arrived). */
export function showJourneyComplete() {
  const { user } = state;
  if (!user || !user.journey || !isJourneyEnded(user.journey, todayStr())) return;
  recap = journeyRecap(user);
  fillRecap(recap);
  $(ID).classList.toggle('still', reducedMotion());
  setPhase('recap');
  openOverlay(ID);
}

export function journeyCompleteNext() {
  if (!recap) return;
  setPhase('next');
  showOptions();
}

export function journeyCompleteBack() {
  showOptions();
  $('jc-err').textContent = '';
}

/** A chapter option was chosen: show the small form (goal weight only for "new goal"; length for all). */
export function pickChapter(k) {
  kind = k;
  const { user } = state;
  $('jc-options').hidden = true;
  $('jc-form').hidden = false;
  $('jc-goalfield').hidden = k !== 'new_goal';
  $('jc-goal').value = '';
  $('jc-days').value = String(user.journey.duration);
  $('jc-err').textContent = '';
  $('jc-submit').textContent = `Begin Journey ${(user.pastJourneys || []).length + 2}`;
  ($(k === 'new_goal' ? 'jc-goal' : 'jc-days')).focus();
}

/** Persists the new journey (the old one is archived atomically server-side) and switches the app to it. */
export async function onJourneyFormSubmit(e) {
  e.preventDefault();
  if (busy) return;
  const { user } = state;
  const prev = user.journey;
  const built = buildNextJourney(prev, recap, { kind, goal: $('jc-goal').value, duration: $('jc-days').value }, todayStr());
  $('jc-err').textContent = built.ok ? '' : built.error;
  if (!built.ok) return;
  busy = true;
  try {
    await getRepo().startNextJourney(built.journey, kind);
  } catch (err) {
    reportDataError(err, "Couldn't start your next journey. Please try again.");
    busy = false;
    return;
  }
  busy = false;
  // The finished journey becomes immutable history; per-journey achievements belong to the journey they were earned in.
  user.pastJourneys = [...(user.pastJourneys || []), { ...prev, completedOn: goalDate(prev) }];
  user.journey = built.journey;
  for (const id of JOURNEY_SCOPED) {
    if (user.unlockedDates[id] && user.unlockedDates[id] < built.journey.start) {
      user.unlocked = user.unlocked.filter((x) => x !== id);
      delete user.unlockedDates[id];
    }
  }
  closeOverlay(ID);
  toast(`Journey ${user.pastJourneys.length + 1} begins`);
}

/**
 * Called after Home renders and after a check-in: the first time a journey is seen as complete, records the
 * achievement (dated to the journey's last day) and opens the recap once nothing else is on screen.
 */
export async function maybeCelebrateJourneyComplete() {
  const { user } = state;
  if (!user || !user.journey || !isJourneyEnded(user.journey, todayStr())) return;
  if (user.unlocked.includes(JOURNEY_ACHIEVEMENT)) return;
  const on = goalDate(user.journey);
  try {
    await getRepo().unlockAchievement(JOURNEY_ACHIEVEMENT, on);
  } catch (e) {
    console.error(e); // not persisted -> not celebrated; retried next time Home loads
    return;
  }
  user.unlocked.push(JOURNEY_ACHIEVEMENT);
  user.unlockedDates[JOURNEY_ACHIEVEMENT] = on;
  renderHome();
  // Wait for any other celebration (goal experience, milestone card, check-in sheet) to finish first.
  let tries = 0;
  const timer = setInterval(() => {
    tries++;
    if (!document.querySelector('.overlay.show')) { clearInterval(timer); showJourneyComplete(); }
    else if (tries > 60) clearInterval(timer);
  }, 700);
}

onOverlayClosed(ID, () => {
  recap = null;
  kind = null;
  renderHome();
});
