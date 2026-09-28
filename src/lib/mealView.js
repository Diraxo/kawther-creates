// How a saved meal reads. The check-in form and the Journey day both render through here, so the same saved record
// looks the same in both places. Nothing here depends on an animation: a meal is visible the moment it is in the DOM.
import { MEAL_LABELS, mealGroups } from '../domain/checkin.js';
import { esc } from './format.js';

/** Name + time, and the notes when there are any. */
export function mealBodyHtml(m) {
  return `<div class="meal-main"><span class="meal-name">${esc(m.name)}</span><span class="meal-time">${esc(m.time)}</span></div>`
    + (m.notes ? `<div class="meal-notes">${esc(m.notes)}</div>` : '');
}

/** A section with nothing in it still reads as a deliberate, empty place ("No lunch logged yet"). */
export function mealEmptyHtml(cat) {
  return `<div class="meal-empty">No ${esc(MEAL_LABELS[cat].toLowerCase())} logged yet</div>`;
}

/** A day's meals grouped under Breakfast / Lunch / Dinner / Snacks (read-only), or the "Nothing logged" note. */
export function mealGroupsHtml(c) {
  const groups = mealGroups(c);
  if (!groups.length) return '<p class="muted">Nothing logged</p>';
  return groups.map((g) => `<div class="meal-group" data-cat="${g.cat}"><h6>${esc(g.label)}</h6>${
    g.items.map((m) => `<div class="meal-item static"><div class="meal-info">${mealBodyHtml(m)}</div></div>`).join('')
  }</div>`).join('');
}
