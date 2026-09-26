import { $ } from '../lib/dom.js';
import { reducedMotion } from '../lib/motion.js';
import { capitalize, esc } from '../lib/format.js';
import { CHECK_SVG } from '../lib/icons.js';
import { state } from '../state.js';
import { addDays, formatLongDate, parseDate, todayStr } from '../domain/dates.js';
import { currentDayIndex, goalDate, waterGoalOf } from '../domain/journey.js';
import { goalAchievement, goalCopy } from '../domain/goal.js';
import { svgIcon } from '../lib/icons.js';
import { dayStatusClass } from '../domain/metrics.js';
import { formatExercise, formatLitres } from '../domain/checkin.js';

export function renderJourney() {
  const { user } = state;
  const today = todayStr();
  const { duration: dur, start } = user.journey;
  $('j-daylabel').textContent = `Day ${currentDayIndex(user.journey, today)} / ${dur}`;
  const cal = $('j-cal');
  cal.innerHTML = '';
  state.selectedDayEl = null;
  const startDow = parseDate(start).getDay();
  for (let i = 0; i < startDow; i++) {
    const e = document.createElement('div');
    e.className = 'cal-day empty';
    cal.appendChild(e);
  }
  const goal = waterGoalOf(user.journey);
  const reached = user.unlocked.includes('goal') ? goalAchievement(user) : null;
  for (let i = 0; i < dur; i++) {
    const dateStr = addDays(start, i);
    const isFuture = dateStr > today;
    const c = user.checkins[dateStr];
    let cls = 'cal-day ' + dayStatusClass(c, isFuture, goal);
    if (dateStr === today) cls += ' today';
    if (dateStr === goalDate(user.journey)) cls += ' goalday';
    const isReached = !!reached && dateStr === reached.date;
    if (isReached) cls += ' reached';
    const el = document.createElement('div');
    el.className = cls;
    el.textContent = i + 1;
    if (isReached) el.insertAdjacentHTML('beforeend', `<span class="crown">${svgIcon('crown')}</span>`);
    el.setAttribute('aria-label', 'Day ' + (i + 1) + (isReached ? ', goal reached' : '') + (c ? ', checked in' : isFuture ? ', upcoming' : ', missed'));
    if (!isFuture) {
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      el.setAttribute('aria-pressed', 'false');
      el.dataset.action = 'show-day';
      el.dataset.date = dateStr;
      el.dataset.num = i + 1;
    }
    cal.appendChild(el);
  }
  const legend = $('j-legend');
  legend.hidden = !reached;
  if (reached) legend.innerHTML = `<span>${svgIcon('crown')}Goal reached · Day ${reached.day}</span><span>Ring · journey end</span>`;
  $('j-detail-inner').innerHTML = Object.keys(user.checkins).length
    ? '<div class="empty">Tap a day to see what you logged.</div>'
    : '<div class="empty">No check-ins yet. Your days will fill in here as you log them.</div>';
}

function card(label, value) {
  return `<div class="dcard"><span>${label}</span><b>${esc(value)}</b></div>`;
}

function dayDetailHtml(c, num, dLabel, goal, goalDay) {
  const goalNote = goalDay ? `<div class="daystatus goal">${svgIcon('crown')}${esc(goalDay)}</div>` : '';
  const head = `<h3 class="daytitle" id="j-detail-title" tabindex="-1">Day ${num} check-in</h3><div class="daypill">${esc(dLabel)}</div>${goalNote}`;
  if (!c) return `${head}<div class="empty" style="padding:18px 0;">No check-in logged for this day.</div>`;
  const mealsAll = Object.values(c.meals || {}).flat();
  const mealsHtml = mealsAll.length
    ? mealsAll.map((m) => `<div class="meal-item" style="cursor:default;"><span>${esc(m.name)}</span><span style="color:var(--sub)">${esc(m.time)}</span></div>`).join('')
    : '<p class="muted">Nothing logged</p>';
  return `${head}
    <div class="daystatus">${CHECK_SVG}Checked in</div>
    <div class="detail-grid">
      ${card('Weight', c.weight ? `${c.weight.toFixed(1)} kg` : 'Not logged')}
      ${card('Hydration', `${formatLitres(c.water || 0)} / ${formatLitres(goal)}`)}
      ${card('Mood', c.mood ? capitalize(c.mood) : 'Not logged')}
      ${card('Movement', c.exercise ? formatExercise(c.exercise) : 'Rest day')}
    </div>
    <div class="detail-sec"><h5>Meals</h5>${mealsHtml}</div>
    <div class="detail-sec"><h5>Notes</h5>${c.notes ? `<p>${esc(c.notes)}</p>` : '<p class="muted">No notes</p>'}</div>`;
}

/**
 * Tap a day: highlight it, render its real check-in, then scroll the detail heading into view
 * (scroll-margin on #j-detail keeps it clear of the top edge; the page's bottom padding keeps it clear of the nav).
 */
export function showDay(dateStr, num, el) {
  const { user } = state;
  if (state.selectedDayEl) {
    state.selectedDayEl.classList.remove('sel');
    state.selectedDayEl.setAttribute('aria-pressed', 'false');
  }
  if (el) {
    el.classList.add('sel');
    el.setAttribute('aria-pressed', 'true');
    state.selectedDayEl = el;
  }
  const box = $('j-detail-inner');
  const ga = user.unlocked.includes('goal') ? goalAchievement(user) : null;
  const goalDay = ga && ga.date === dateStr ? `Goal reached · ${goalCopy(ga).weight}` : '';
  box.innerHTML = dayDetailHtml(user.checkins[dateStr], num, formatLongDate(dateStr), waterGoalOf(user.journey), goalDay);
  box.classList.remove('swap');
  void box.offsetWidth;
  box.classList.add('swap');
  const card_ = $('j-detail');
  const reduce = reducedMotion();
  card_.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  $('j-detail-title').focus({ preventScroll: true });
}
