import { $$ } from '../lib/dom.js';

const KEY = 'kc_theme';
const mq = window.matchMedia('(prefers-color-scheme: dark)');

export const getTheme = () => localStorage.getItem(KEY) || 'dark';

function apply(t) {
  const resolved = t === 'system' ? (mq.matches ? 'dark' : 'light') : t;
  document.documentElement.setAttribute('data-theme', resolved);
}

export function setTheme(t) {
  localStorage.setItem(KEY, t);
  $$('.theme-opt[data-t]').forEach((o) => o.classList.toggle('on', o.dataset.t === t));
  apply(t);
}

export function initTheme() {
  setTheme(getTheme());
  // "System" should keep following the OS after load.
  mq.addEventListener('change', () => {
    if (getTheme() === 'system') apply('system');
  });
}
