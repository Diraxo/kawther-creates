import { $ } from '../lib/dom.js';
import { state } from '../state.js';
import { getRepo } from '../data/repository.js';
import { AuthError } from '../data/errors.js';
import { go, showNav } from '../ui/router.js';
import { closeOverlay, openOverlay } from '../ui/overlays.js';
import { enterHome } from './home.js';
import { resetMilestones } from '../ui/milestones.js';
import { MSG } from '../lib/dataError.js';

const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const EMAIL_ERR_DEFAULT = 'Please enter a valid email.';
const LOGIN_ERR_DEFAULT = 'Email or password is incorrect.';

function routeAfterLogin() {
  if (!state.user.onboarded) go('s-ob1');
  else enterHome();
}

export async function doSignup() {
  const name = $('su-name').value.trim();
  const email = $('su-email').value.trim().toLowerCase();
  const p1 = $('su-pass').value;
  const p2 = $('su-pass2').value;
  ['e-su-name', 'e-su-email', 'e-su-pass', 'e-su-pass2'].forEach((i) => ($(i).style.display = 'none'));
  $('e-su-email').textContent = EMAIL_ERR_DEFAULT; // the prototype left a stale message here
  let ok = true;
  if (!name) { $('e-su-name').style.display = 'block'; ok = false; }
  if (!validEmail(email)) { $('e-su-email').style.display = 'block'; ok = false; }
  if (p1.length < 8) { $('e-su-pass').style.display = 'block'; ok = false; }
  if (p1 !== p2) { $('e-su-pass2').style.display = 'block'; ok = false; }
  if (!ok) return;
  try {
    state.user = await getRepo().signUp({ name, email, password: p1 });
    go('s-ob1');
  } catch (e) {
    const box = $('e-su-email');
    if (e instanceof AuthError && e.code === 'EXISTS') box.textContent = 'This account already exists.';
    else if (e instanceof AuthError && e.code === 'CONFIRM_EMAIL') box.textContent = 'Check your inbox to confirm your email, then log in.';
    else if (e instanceof AuthError && e.code === 'NETWORK') box.textContent = MSG.NETWORK;
    else box.textContent = 'Could not create your account. Please try again.';
    box.style.display = 'block';
  }
}

export async function doLogin() {
  const email = $('li-email').value.trim().toLowerCase();
  const pass = $('li-pass').value;
  const err = $('e-login');
  err.style.display = 'none';
  try {
    state.user = await getRepo().signIn(email, pass);
    routeAfterLogin();
  } catch (e) {
    if (!(e instanceof AuthError && e.code === 'INVALID_CREDENTIALS')) console.error(e);
    err.textContent = !(e instanceof AuthError) ? 'Could not log in. Please try again.'
      : e.code === 'INVALID_CREDENTIALS' ? LOGIN_ERR_DEFAULT
      : e.code === 'CONFIRM_EMAIL' ? 'Please confirm your email first — check your inbox.'
      : e.code === 'NETWORK' ? MSG.NETWORK
      : 'Could not log in. Please try again.';
    err.style.display = 'block';
  }
}

/** Step 1: ask. Nothing is signed out until the user confirms in the dialog. */
export function doLogout() {
  openOverlay('ov-logout');
}

/** Step 2: only now does Supabase signOut run. */
export async function confirmLogout() {
  closeOverlay('ov-logout');
  try {
    await getRepo().signOut();
  } catch (e) {
    console.error(e); // still leave the app: never trap the user in a logged-in view
  }
  state.user = null;
  resetMilestones();
  showNav(false);
  go('s-landing');
}

export { routeAfterLogin };
