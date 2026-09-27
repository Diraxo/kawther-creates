import { $, $$ } from '../lib/dom.js';
import { state } from '../state.js';

const tabRenderers = {};
/** Register the render function a bottom-nav tab runs when it opens. */
export function onTab(id, fn) {
  tabRenderers[id] = fn;
}

export function go(id) {
  $$('.screen').forEach((s) => s.classList.remove('active'));
  $(id).classList.add('active');
  window.scrollTo(0, 0);
}

export function tab(id) {
  // A data screen can't open before the user's data exists (not loaded !== empty): the boot/login flow owns that case.
  if (!state.user) return;
  go(id);
  $$('.navbtn').forEach((b) => b.classList.remove('on'));
  const b = document.querySelector(`.navbtn[data-s="${id}"]`);
  if (b) b.classList.add('on');
  if (tabRenderers[id]) tabRenderers[id]();
}

export function showNav(v) {
  $('nav').style.display = v ? 'flex' : 'none';
}
