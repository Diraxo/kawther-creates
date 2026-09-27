// Movement as markup (Journey day detail). Pure string building: every user-entered value is escaped.
import { esc } from './format.js';
import { svgIcon } from './icons.js';
import { formatDuration, missingDetails, movementDetail, movementLabel } from '../domain/movement.js';

const MOVE_ICON = { Gym: 'dumbbell', Running: 'run', Walking: 'walk', 'Home workout': 'homeworkout', Other: 'pulse' };

/** The day's movement as a journal entry: exactly what was saved, and "not recorded" for anything that was not. */
export function movementHtml(ex) {
  if (!ex) {
    return `<div class="mv-entry rest"><span class="mv-ic">${svgIcon('moon')}</span><div><b class="mv-kind">Rest day</b><p>Recovery is part of the journey.</p></div></div>`;
  }
  const lines = [formatDuration(ex.duration), movementDetail(ex)].filter(Boolean);
  const missing = missingDetails(ex);
  return `<div class="mv-entry"><span class="mv-ic">${svgIcon(MOVE_ICON[ex.type] || 'pulse')}</span><div><b class="mv-kind">${esc(movementLabel(ex.type).toUpperCase())}</b>${lines.map((l) => `<p class="mv-line">${esc(l)}</p>`).join('')}${missing.map((l) => `<p class="mv-line dim">${esc(l)}</p>`).join('')}</div></div>`;
}
