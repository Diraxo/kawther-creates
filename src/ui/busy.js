// The one loading-button pattern. Every control that starts real asynchronous work goes through withBusy():
//   idle -> (click) spinner + label, disabled, size locked -> success/error -> idle again (never left disabled).
// A second activation while the first is in flight is ignored, so double taps / Enter+click can't submit twice.

const busy = new WeakSet();

export const isBusy = (btn) => busy.has(btn);

/**
 * @param {HTMLElement} btn  the control that was activated
 * @param {string} label     what it says while working, e.g. "Saving…"
 * @param {() => Promise<any>} work  the real async operation
 * @returns {Promise<any>}   the operation's result, or undefined if a run was already in flight
 */
export async function withBusy(btn, label, work) {
  if (!btn) return work();
  if (busy.has(btn)) return undefined;
  busy.add(btn);
  const { minWidth, minHeight } = btn.style;
  const rect = btn.getBoundingClientRect();
  if (rect.width) btn.style.minWidth = `${Math.ceil(rect.width)}px`; // no layout jump while the label changes
  if (rect.height) btn.style.minHeight = `${Math.ceil(rect.height)}px`;
  const html = btn.innerHTML;
  btn.innerHTML = `<span class="spin" aria-hidden="true"></span><span class="busy-label">${label}</span>`;
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  btn.classList.add('busy');
  try {
    return await work();
  } finally {
    busy.delete(btn);
    btn.innerHTML = html;
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    btn.classList.remove('busy');
    btn.style.minWidth = minWidth;
    btn.style.minHeight = minHeight;
  }
}
