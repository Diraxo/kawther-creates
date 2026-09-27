export const ICONS = {
  leaf: '<path d="M11 20A7 7 0 0 1 4 13V6a1 1 0 0 1 1-1h7a7 7 0 0 1 7 7 7 7 0 0 1-7 7 1 1 0 0 1-1 1z"/><path d="M4 13c6 0 10-4 10-10"/>',
  heart: '<path d="M12 21s-7-4.3-9.5-8.5C.7 8.8 2.4 5 6 5c2 0 3.3 1 4 2 0.7-1 2-2 4-2 3.6 0 5.3 3.8 3.5 7.5C19 16.7 12 21 12 21z"/>',
  flame: '<path d="M12 2c1 3-2 4-2 7a4 4 0 0 0 8 0c0-1-.5-2-1-2.5.5 2-1 3-2 3 0-2.5-2-3-2-5.5-1 1-1.5 2.5-1 4-1.5-.5-2-2.5 0-6z"/><path d="M8 14a4 4 0 0 0 8 0"/>',
  bolt: '<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/>',
  drop: '<path d="M12 2.5s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
  run: '<path d="M13 4a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z"/><path d="M6 21l3-6 2-2-1-4 4 1 2 3 3 1"/><path d="M9 13l-3 2"/>',
  dumbbell: '<path d="M6.5 6.5v11M17.5 6.5v11M3.5 9v6M20.5 9v6M6.5 12h11"/>',
  walk: '<path d="M13 4.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z"/><path d="M11 21l1.5-6-2.5-2.5 1-5 3 1.5 2 3"/><path d="M8 12l-1.5 3.5M13 15l2 6"/>',
  homeworkout: '<path d="M3 11l9-7 9 7"/><path d="M5.5 9.5V20h13V9.5"/><path d="M9.5 15.5h5"/>',
  pulse: '<path d="M3 12h4l2.5-6 4 12 2.5-6H21"/>',
  moon: '<path d="M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9z"/>',
  trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0V4z"/><path d="M8 6H5v1a3 3 0 0 0 3 3M16 6h3v1a3 3 0 0 1-3 3"/><path d="M12 13v4M8.5 20h7"/>',
  crown: '<path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5L3 8z"/><path d="M5 21h14"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/>',
};

export function svgIcon(key) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[key]}</svg>`;
}

export const LOCK_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

export const ARROW_SVG =
  '<svg class="ic" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

export const CHECK_SVG =
  '<svg class="ic" viewBox="0 0 24 24" width="15" height="15" stroke="var(--emerald)"><path d="M20 6 9 17 4 12"/></svg>';

export const TRASH_SVG =
  '<svg class="ic" viewBox="0 0 24 24" width="15" height="15"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>';

export const OPEN_SVG =
  '<svg class="ic" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="12" cy="12" r="8"/></svg>';
