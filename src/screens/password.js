// Change password (real Supabase Auth). The current password is verified against Supabase before anything changes;
// nothing is stored in the browser and the fields are cleared as soon as the dialog closes or succeeds.
import { $ } from '../lib/dom.js';
import { getRepo } from '../data/repository.js';
import { AuthError } from '../data/errors.js';
import { reportDataError, MSG } from '../lib/dataError.js';
import { validatePasswordChange } from '../domain/password.js';
import { onOverlayClosed, openOverlay } from '../ui/overlays.js';

const FIELDS = { current: 'pw-current', next: 'pw-new', confirm: 'pw-confirm' };

function setError(field, msg) {
  const box = $('e-' + FIELDS[field]);
  box.textContent = msg || '';
  box.style.display = msg ? 'block' : 'none';
  $(FIELDS[field]).setAttribute('aria-invalid', msg ? 'true' : 'false');
}
function setFormError(msg) {
  const box = $('e-pw-form');
  box.textContent = msg || '';
  box.style.display = msg ? 'block' : 'none';
}
function clearAll() {
  Object.keys(FIELDS).forEach((f) => { setError(f, ''); $(FIELDS[f]).value = ''; $(FIELDS[f]).type = 'password'; });
  document.querySelectorAll('#ov-password .pw-toggle').forEach((t) => { t.setAttribute('aria-pressed', 'false'); t.setAttribute('aria-label', 'Show password'); });
  setFormError('');
}

onOverlayClosed('ov-password', clearAll);

export function openPassword() {
  clearAll();
  $('pw-form').hidden = false;
  $('pw-success').hidden = true;
  $('pw-save').disabled = false;
  $('pw-save').textContent = 'Update password';
  openOverlay('ov-password');
}

export async function savePassword(e) {
  if (e) e.preventDefault();
  const values = { current: $('pw-current').value, next: $('pw-new').value, confirm: $('pw-confirm').value };
  const errors = validatePasswordChange(values);
  Object.keys(FIELDS).forEach((f) => setError(f, errors[f]));
  setFormError('');
  const firstBad = Object.keys(FIELDS).find((f) => errors[f]);
  if (firstBad) { $(FIELDS[firstBad]).focus(); return; }

  const btn = $('pw-save');
  btn.disabled = true;
  btn.textContent = 'Updating…';
  try {
    await getRepo().changePassword(values.current, values.next);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Update password';
    if (err instanceof AuthError && err.code === 'INVALID_CREDENTIALS') {
      setError('current', 'Current password is incorrect.');
      $('pw-current').focus();
    } else if (err instanceof AuthError && err.code === 'SAME_PASSWORD') {
      setError('next', 'Choose a password different from your current one.');
      $('pw-new').focus();
    } else if (err instanceof AuthError && err.code === 'WEAK_PASSWORD') {
      setError('next', 'That password is too weak. Try a longer or less common one.');
      $('pw-new').focus();
    } else if (err instanceof AuthError && err.code === 'NETWORK') {
      setFormError(MSG.NETWORK);
    } else {
      // Session expired -> reportDataError routes to login; anything else gets an honest inline message.
      const code = reportDataError(err, "Couldn't update your password. Please try again.");
      if (code !== 'SESSION_EXPIRED') setFormError("Couldn't update your password. Please try again.");
    }
    return;
  }
  clearAll();
  $('pw-form').hidden = true;
  $('pw-success').hidden = false;
  $('pw-success').querySelector('.btn').focus();
}
