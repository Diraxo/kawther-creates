import { $ } from '../lib/dom.js';
import { go } from './router.js';

const closeHooks = {};
/** Run `fn` whenever overlay `id` is closed (used by the achievement queue). */
export function onOverlayClosed(id, fn) {
  closeHooks[id] = fn;
}

const openers = {};
const FOCUSABLE = 'button, [href], input, select, textarea, [role="button"][tabindex="0"], [tabindex="0"]';
const focusables = (overlay) => [...overlay.querySelectorAll(FOCUSABLE)].filter((e) => !e.disabled && e.offsetParent !== null);

export function openOverlay(id) {
  const overlay = $(id);
  openers[id] = document.activeElement;
  overlay.classList.add('show');
  // Dialog semantics: move focus inside so keyboard/screen-reader users land in the dialog.
  const sheet = overlay.querySelector('.sheet') || overlay;
  if (!sheet.hasAttribute('tabindex')) sheet.setAttribute('tabindex', '-1');
  const first = focusables(overlay).find((e) => e.matches('input, textarea, select, button')) || focusables(overlay)[0];
  (first || sheet).focus({ preventScroll: true });
}

export function closeOverlay(id) {
  $(id).classList.remove('show');
  const opener = openers[id];
  delete openers[id];
  if (opener && opener.isConnected && opener.offsetParent !== null) opener.focus({ preventScroll: true });
  if (id === 'ov-celebrate') go('s-home');
  if (closeHooks[id]) closeHooks[id]();
}

// Escape closes the top dialog; Tab is trapped inside it (aria-modal="true" promises both).
document.addEventListener('keydown', (e) => {
  const open = [...document.querySelectorAll('.overlay.show')].pop();
  if (!open) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    closeOverlay(open.id);
  } else if (e.key === 'Tab') {
    const items = focusables(open);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0], last = items[items.length - 1];
    if (!open.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && (document.activeElement === first || document.activeElement.classList.contains('sheet'))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});
