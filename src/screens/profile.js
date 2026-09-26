import { $, $$ } from '../lib/dom.js';
import { state } from '../state.js';
import { formatDate } from '../domain/dates.js';
import { goalDate } from '../domain/journey.js';
import { go } from '../ui/router.js';
import { getTheme } from '../ui/theme.js';

/** Every value comes from the signed-in user's own Supabase-backed record (state.user). */
export function renderProfile() {
  const { user } = state;
  const j = user.journey;
  $('pf-init').textContent = user.name.charAt(0).toUpperCase();
  $('pf-name').textContent = user.name;
  $('pf-email').textContent = user.email;
  $('pf-journey').textContent = `${j.duration} days`;
  $('pf-startw').textContent = j.startWeight + ' kg';
  $('pf-goalw').textContent = j.goalWeight + ' kg';
  $('pf-startd').textContent = formatDate(j.start);
  $('pf-goald').textContent = formatDate(goalDate(j)); // start date is Day 1, so the last day is start + (duration - 1)
  const th = getTheme();
  $$('.theme-opt[data-t]').forEach((o) => o.classList.toggle('on', o.dataset.t === th));
}

export function openProfile() {
  renderProfile();
  go('s-profile');
}
