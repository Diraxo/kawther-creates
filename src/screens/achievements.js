import { $ } from '../lib/dom.js';
import { CHECK_SVG, LOCK_SVG, svgIcon } from '../lib/icons.js';
import { state } from '../state.js';
import { todayStr, formatLongDate } from '../domain/dates.js';
import { ACH_DEFS, achievementContext } from '../domain/achievements.js';
import { goalAchievement, goalCopy } from '../domain/goal.js';
import { openOverlay } from '../ui/overlays.js';
import { replayGoal } from '../ui/goalExperience.js';

/** "1 / 3" (+ unit when the definition has two phases, e.g. Consistent). */
function progressText(a, ctx) {
  const [cur, target] = a.prog(ctx);
  const unit = a.id === 'goal' ? '%' : a.id === 'consistent' ? (ctx.checkinCount < 7 ? ' check-ins' : '%') : '';
  return { cur, target, text: `${cur} / ${target}${unit}` };
}

export function renderAch() {
  const { user } = state;
  const ctx = achievementContext(user, todayStr());
  const g = $('ach-grid');
  g.innerHTML = '';
  $('ach-empty').style.display = user.unlocked.length ? 'none' : 'block';
  const ga = user.unlocked.includes('goal') ? goalAchievement(user) : null;
  [...ACH_DEFS].sort((x, y) => Number(!!y.special) - Number(!!x.special)).forEach((a) => {
    const on = user.unlocked.includes(a.id);
    const d = document.createElement('div');
    d.className = 'ach' + (on ? '' : ' locked') + (a.special ? ' trophy' : '');
    d.setAttribute('role', 'button');
    d.tabIndex = 0;
    d.dataset.action = 'open-ach';
    d.dataset.id = a.id;
    const dt = user.unlockedDates[a.id];
    const line = on && a.id === 'goal' && ga
      ? `${goalCopy(ga).reachedLine} · ${goalCopy(ga).weight}`
      : on
      ? `Unlocked${dt ? ' ' + formatLongDate(dt) : ''}`
      : `Locked · Progress: ${progressText(a, ctx).text}`;
    d.innerHTML = `<div class="ic">${on ? svgIcon(a.ic) : LOCK_SVG}</div><h4>${a.t}</h4><p>${line}</p>`;
    g.appendChild(d);
  });
}

export function openAchDetail(id) {
  const { user } = state;
  if (id === 'goal' && user.unlocked.includes('goal') && goalAchievement(user)) { replayGoal(); return; } // the trophy replays the celebration
  const a = ACH_DEFS.find((x) => x.id === id);
  const on = user.unlocked.includes(id);
  const wrap = $('ad-icwrap');
  wrap.className = 'ic' + (on ? '' : ' locked');
  wrap.innerHTML = svgIcon(a.ic);
  $('ad-title').textContent = a.t;
  $('ad-desc').textContent = a.d;
  if (on) {
    const dt = user.unlockedDates[id];
    $('ad-status').style.color = 'var(--emerald)';
    $('ad-status').innerHTML = `${CHECK_SVG}Unlocked${dt ? ' ' + formatLongDate(dt) : ''}`;
    $('ad-progress').style.display = 'none';
  } else {
    const { cur, target, text } = progressText(a, achievementContext(user, todayStr()));
    $('ad-status').style.color = 'var(--sub)';
    $('ad-status').textContent = 'Locked';
    $('ad-progress').style.display = 'block';
    $('ad-progress-label').textContent = `Progress: ${text}`;
    $('ad-progress-bar').style.width = Math.min(100, (cur / target) * 100) + '%';
  }
  openOverlay('ov-achdetail');
}
