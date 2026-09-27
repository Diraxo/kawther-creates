// Connection awareness. Honest by construction: "Synced" is only ever shown after a REAL repository read succeeded,
// and nothing is queued offline (a write that can't reach Supabase is refused up front, never silently held).
//   online -> (offline event) offline -> (online event) syncing -> synced | failed(retry)
import { $ } from '../lib/dom.js';
import { state } from '../state.js';
import { getRepo } from '../data/repository.js';

let status = 'online'; // 'online' | 'offline' | 'syncing' | 'synced' | 'failed'
let hideTimer;
let syncing = null;
let onSynced = () => {};

export const isOffline = () => status === 'offline' || navigator.onLine === false;
export const networkStatus = () => status;

const COPY = {
  offline: ["You're offline", 'Reconnect to keep syncing your journal.'],
  syncing: ['Back online', 'Syncing your journal…'],
  synced: ['Synced', ''],
  failed: ["Couldn't sync", 'Your changes here are safe; tap to try again.'],
};

function render() {
  const bar = $('netbar');
  if (!bar) return;
  clearTimeout(hideTimer);
  const copy = COPY[status];
  bar.hidden = !copy;
  bar.dataset.state = status;
  if (!copy) return;
  $('netbar-title').textContent = copy[0];
  $('netbar-sub').textContent = copy[1];
  $('netbar-retry').hidden = status !== 'failed';
  if (status === 'synced') hideTimer = setTimeout(() => setStatus('online'), 2200);
}

function setStatus(s) {
  status = s;
  document.documentElement.dataset.net = s;
  render();
}

/** Re-reads the signed-in user from Supabase (the real connectivity check) and merges it into the working copy. */
export async function syncNow({ silent = false } = {}) {
  if (syncing) return syncing;
  if (!silent) setStatus('syncing');
  syncing = (async () => {
    try {
      const fresh = await getRepo().getSession();
      if (fresh && state.user) {
        Object.assign(state.user, fresh); // same object identity: in-flight screens keep their reference
        if (!silent) setStatus('synced');
        onSynced(true);
      } else {
        if (!silent) setStatus('online');
        if (!fresh) onSynced(false); // the session is gone: the app routes to login
      }
      return true;
    } catch (e) {
      if (navigator.onLine === false) setStatus('offline');
      else if (!silent) setStatus('failed'); // a quiet background refresh that fails just tries again next time
      return false;
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

/** @param {{ afterSync: (hasSession: boolean) => void }} o  called after a sync: fresh data merged, or the session is gone. */
export function initNetwork({ afterSync }) {
  onSynced = afterSync;
  window.addEventListener('offline', () => setStatus('offline'));
  window.addEventListener('online', () => { if (state.user) syncNow(); else setStatus('online'); });
  $('netbar-retry').addEventListener('click', syncNow);
  if (navigator.onLine === false) setStatus('offline');
}

/** A request failed with a network error while the browser thought it was online: say so (retry lives in the banner). */
export function noteNetworkFailure() {
  if (status === 'online' || status === 'synced') setStatus(navigator.onLine === false ? 'offline' : 'failed');
}
