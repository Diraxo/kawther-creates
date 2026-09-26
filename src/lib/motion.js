const mq = window.matchMedia('(prefers-reduced-motion: reduce)');

/** Live value (the user can flip the OS setting while the app is open). */
export const reducedMotion = () => mq.matches;
export const REDUCE = mq.matches;

export function animateNum(el, to, decimals, duration, suffix) {
  suffix = suffix || '';
  if (reducedMotion() || !duration) {
    el.textContent = (decimals ? to.toFixed(decimals) : Math.round(to)) + suffix;
    return;
  }
  const start = performance.now();
  function step(t) {
    const p = Math.min(1, (t - start) / duration);
    const eased = 1 - Math.pow(1 - p, 3);
    const val = to * eased;
    el.textContent = (decimals ? val.toFixed(decimals) : Math.round(val)) + suffix;
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

/**
 * Counts an element's displayed number from what it showed before to the new REAL value (never through invented
 * data: only the number on screen interpolates). `fmt(v)` renders a number; `to == null` shows `emptyText`
 * immediately. With reduced motion the final value is written at once.
 */
export function animateValue(el, to, fmt, { duration = 650, emptyText = '—' } = {}) {
  if (el._raf) cancelAnimationFrame(el._raf);
  if (to == null || Number.isNaN(to)) {
    el.textContent = emptyText;
    el._v = null;
    return;
  }
  const from = typeof el._v === 'number' ? el._v : 0;
  el._v = to;
  if (reducedMotion() || from === to || !duration) {
    el.textContent = fmt(to);
    return;
  }
  const t0 = performance.now();
  const step = (t) => {
    const p = Math.min(1, (t - t0) / duration);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt(p < 1 ? from + (to - from) * eased : to);
    if (p < 1) el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
