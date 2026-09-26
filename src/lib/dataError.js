// One place that turns a failed data operation into honest user feedback.
// Callers must only update UI/state as if data were saved AFTER the awaited call succeeded.
import { state } from '../state.js';
import { classifyError } from '../data/errors.js';
import { go, showNav } from '../ui/router.js';
import { toast } from './toast.js';

export const MSG = {
  NETWORK: "Can't reach the server. Nothing was saved — check your connection and try again.",
  SESSION_EXPIRED: 'Your session expired. Please log in again.',
  FORBIDDEN: "You don't have permission to do that.",
};

/**
 * @param {unknown} e the thrown error
 * @param {string} fallback message for unclassified errors
 * @returns {string} the classified code, so callers can branch (e.g. keep a form open)
 */
export function reportDataError(e, fallback) {
  console.error(e);
  const err = classifyError(e);
  if (err.code === 'SESSION_EXPIRED') {
    state.user = null;
    state.draft = null;
    showNav(false);
    document.querySelectorAll('.overlay.show').forEach((o) => o.classList.remove('show'));
    go('s-login');
    toast(MSG.SESSION_EXPIRED, 5000);
  } else {
    toast(MSG[err.code] || fallback, err.code === 'NETWORK' ? 5000 : 2600);
  }
  return err.code;
}
