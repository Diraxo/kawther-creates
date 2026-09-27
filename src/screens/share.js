// "Share my progress": a card built ONLY from the user's real data. A metric with no data is omitted, never faked.
import { $ } from '../lib/dom.js';
import { state } from '../state.js';
import { todayStr } from '../domain/dates.js';
import { shareStats } from '../domain/metrics.js';
import { openOverlay } from '../ui/overlays.js';
import { withBusy } from '../ui/busy.js';

/** [{ key, label }] for the metrics that really exist. */
export function shareRows(s) {
  const rows = [];
  if (s.streak > 0) rows.push({ key: 'streak', label: `${s.streak} DAY STREAK` });
  if (s.weight != null) rows.push({ key: 'weight', label: `${s.weight.toFixed(1)} KG` });
  if (s.avgWaterL != null) rows.push({ key: 'water', label: `${s.avgWaterL.toFixed(1)} L AVERAGE WATER` });
  if (s.workouts > 0) rows.push({ key: 'workouts', label: `${s.workouts} WORKOUT${s.workouts === 1 ? '' : 'S'}` });
  return rows;
}

function shareText(s, rows) {
  const parts = [`Kawther | creates — Day ${s.day} of ${s.duration}`, ...rows.map((r) => r.label.toLowerCase().replace(/^./, (c) => c.toUpperCase()))];
  return parts.join(' · ') + '. Consistency in motion.';
}

let current = null;

export function openShare() {
  const s = shareStats(state.user, todayStr());
  const rows = shareRows(s);
  current = { s, rows };
  $('sh-day').textContent = `DAY ${s.day}`;
  $('sh-of').textContent = `OF ${s.duration}`;
  $('sh-rows').innerHTML = rows.length
    ? rows.map((r) => `<li data-row="${r.key}">${r.label}</li>`).join('')
    : '<li class="none">Log a check-in to add your stats.</li>';
  $('sh-status').textContent = '';
  $('sh-status').dataset.kind = '';
  openOverlay('ov-share');
}

const status = (msg, kind = 'info') => {
  $('sh-status').textContent = msg;
  $('sh-status').dataset.kind = kind;
};

/** Draws the card to a PNG (4:5) using the same real rows. */
async function renderPng(s, rows) {
  if (document.fonts && document.fonts.ready) await document.fonts.ready.catch(() => {});
  const w = 1080, h = 1350;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, w * 0.6, h);
  grad.addColorStop(0, '#0B7F5E');
  grad.addColorStop(1, '#22C58B');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#ffffff';
  g.textAlign = 'center';
  const font = (px, weight = 700) => `${weight} ${px}px 'Plus Jakarta Sans', system-ui, sans-serif`;
  g.globalAlpha = 0.85; g.font = font(40, 600); g.fillText('KAWTHER | CREATES', w / 2, 170); g.globalAlpha = 1;
  g.font = font(190, 800); g.fillText(`DAY ${s.day}`, w / 2, 470);
  g.globalAlpha = 0.85; g.font = font(60, 600); g.fillText(`OF ${s.duration}`, w / 2, 560); g.globalAlpha = 1;
  g.font = font(58, 700);
  const startY = 730;
  rows.forEach((r, i) => g.fillText(r.label, w / 2, startY + i * 100));
  g.globalAlpha = 0.9; g.font = font(44, 500); g.fillText('Consistency in motion', w / 2, h - 130); g.globalAlpha = 1;
  return new Promise((res) => c.toBlob(res, 'image/png'));
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Always-available alternative: download the card as a PNG. Only claims success once the download was triggered. */
export function saveShareImage(btn) {
  if (!current) return;
  return withBusy(btn, 'Creating image…', makeImage);
}

async function makeImage() {
  try {
    const blob = await renderPng(current.s, current.rows);
    if (!blob) throw new Error('no image');
    download(blob, 'kawther-progress.png');
    status('Card image downloaded.', 'ok');
  } catch (e) {
    console.error(e);
    status("Couldn't create the image. Please try again.", 'error');
  }
}

/**
 * Web Share API when available (with the PNG if the browser can share files), else a graceful fallback.
 * Success is only ever reported for a promise that actually resolved; a cancelled or rejected share is not "shared".
 */
export function doShare(btn) {
  if (!current) return;
  return withBusy(btn || $('sh-share-btn'), 'Preparing…', shareCurrent);
}

async function shareCurrent() {
  const { s, rows } = current;
  const text = shareText(s, rows);
  status('Preparing your card…');
  try {
    const blob = await renderPng(s, rows);
    const file = blob ? new File([blob], 'kawther-progress.png', { type: 'image/png' }) : null;

    if (navigator.share) {
      const data = file && navigator.canShare && navigator.canShare({ files: [file] })
        ? { files: [file], text, title: 'My progress' }
        : { text, title: 'My progress' };
      try {
        await navigator.share(data);
        status('Shared.', 'ok');
      } catch (e) {
        if (e && e.name === 'AbortError') status('Sharing cancelled.');
        else status("Couldn't share from this browser. Try Save image instead.", 'error');
      }
      return;
    }

    // Fallback: no Web Share API. Copy the text; offer the image as a download.
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch { /* clipboard blocked: reported below */ }
    if (blob) download(blob, 'kawther-progress.png');
    status(copied ? 'Sharing isn\'t available here — your summary was copied and the card image was downloaded.'
      : "Sharing isn't available here — the card image was downloaded.", 'info');
  } catch (e) {
    console.error(e);
    status("Couldn't create the share card. Please try again.", 'error');
  }
}
