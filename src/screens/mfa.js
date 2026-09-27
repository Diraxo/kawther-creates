// Two-factor authentication (Supabase TOTP). Opt-in for every account and recommended for the creator; nothing here is
// custom crypto: enrolment, verification and removal are Supabase Auth calls (see SupabaseRepository.mfa*).
// Once a factor is verified, the database itself refuses password-only (aal1) sessions (supabase/schema.sql).
import { $ } from '../lib/dom.js';
import { getRepo } from '../data/repository.js';
import { AuthError } from '../data/errors.js';
import { reportDataError, MSG } from '../lib/dataError.js';
import { onOverlayClosed, openOverlay } from '../ui/overlays.js';
import { isBusy, withBusy } from '../ui/busy.js';

const VIEWS = ['mfa-loading', 'mfa-off', 'mfa-setup', 'mfa-on'];
let pending = null; // the factor being enrolled
let removing = null; // the factor awaiting a confirming code

function view(id) {
  VIEWS.forEach((v) => { $(v).hidden = v !== id; });
}
function setError(msg) {
  const box = $('e-mfa');
  box.textContent = msg || '';
  box.style.display = msg ? 'block' : 'none';
}
function clear() {
  pending = null;
  removing = null;
  ['mfa-code', 'mfa-remove-code', 'mfa-secret'].forEach((i) => { $(i).value = ''; });
  $('mfa-qr').removeAttribute('src');
  $('mfa-remove-box').hidden = true;
  setError('');
}
onOverlayClosed('ov-mfa', clear);

function explain(err, fallback) {
  if (err instanceof AuthError && err.code === 'MFA_INVALID') return 'That code is not correct. Check your authenticator app and try again.';
  if (err instanceof AuthError && err.code === 'NETWORK') return MSG.NETWORK;
  if (err instanceof AuthError && err.code === 'RATE_LIMITED') return MSG.RATE_LIMITED;
  const code = reportDataError(err, fallback); // routes an expired session to login
  return code === 'SESSION_EXPIRED' ? '' : fallback;
}

async function refresh() {
  view('mfa-loading');
  let st;
  try {
    st = await getRepo().mfaStatus();
  } catch (err) {
    view('mfa-off');
    setError(explain(err, "Couldn't load your security settings. Please try again."));
    return;
  }
  if (!st.enabled) { view('mfa-off'); return; }
  const list = $('mfa-list');
  list.replaceChildren();
  st.factors.forEach((f) => {
    const row = document.createElement('div');
    row.className = 'rowlink';
    const name = document.createElement('span');
    name.textContent = `${f.name}${f.createdAt ? ' · added ' + f.createdAt.slice(0, 10) : ''}`;
    const rm = document.createElement('span');
    rm.className = 'sub';
    rm.textContent = 'Remove';
    rm.setAttribute('role', 'button');
    rm.tabIndex = 0;
    rm.dataset.action = 'mfa-remove';
    rm.dataset.id = f.id;
    row.append(name, rm);
    list.append(row);
  });
  view('mfa-on');
}

export async function openMfa() {
  clear();
  openOverlay('ov-mfa');
  await refresh();
}

export async function mfaStart() {
  setError('');
  $('mfa-remove-box').hidden = true;
  view('mfa-loading');
  try {
    const e = await getRepo().mfaEnroll();
    pending = e.factorId;
    $('mfa-qr').src = e.qrCode;
    $('mfa-secret').value = e.secret;
    $('mfa-code').value = '';
    view('mfa-setup');
    $('mfa-code').focus();
  } catch (err) {
    await refresh();
    setError(explain(err, "Couldn't start setup. Please try again."));
  }
}

export async function mfaConfirm(btn) {
  if (!pending || isBusy(btn)) return;
  const code = $('mfa-code').value.trim();
  if (!/^\d{6,8}$/.test(code.replace(/\s+/g, ''))) { setError('Enter the 6-digit code from your app.'); return; }
  setError('');
  try {
    await withBusy(btn, 'Turning on…', () => getRepo().mfaConfirm(pending, code));
  } catch (err) {
    setError(explain(err, "Couldn't turn on two-factor. Please try again."));
    return;
  }
  pending = null;
  await refresh();
}

export async function mfaCancel() {
  clear();
  await refresh(); // the abandoned factor is cleaned up on the next enrolment
}

export function mfaRemoveStart(id) {
  removing = id;
  $('mfa-remove-code').value = '';
  $('mfa-remove-box').hidden = false;
  $('mfa-remove-code').focus();
  setError('');
}

export function mfaRemoveCancel() {
  removing = null;
  $('mfa-remove-box').hidden = true;
  setError('');
}

export async function mfaRemoveConfirm(btn) {
  if (!removing || isBusy(btn)) return;
  const code = $('mfa-remove-code').value.trim();
  if (!/^\d{6,8}$/.test(code.replace(/\s+/g, ''))) { setError('Enter the 6-digit code from your app.'); return; }
  setError('');
  try {
    await withBusy(btn, 'Removing…', () => getRepo().mfaDisable(removing, code));
  } catch (err) {
    setError(explain(err, "Couldn't remove it. Please try again."));
    return;
  }
  removing = null;
  $('mfa-remove-box').hidden = true;
  await refresh();
}
