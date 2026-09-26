// Single in-memory app state. The repository persists; this is the working copy.
export const state = {
  /** Current user in domain shape (see data/repository.js), or null when logged out. */
  user: null,
  /** In-progress check-in being edited. */
  draft: null,
  /** Onboarding answers collected before the journey is created. */
  onboarding: { start: null, goal: null, duration: 90, custom: false },
  /** Progress view: { kind:'days', days:N } | { kind:'all' } (independent of the journey length). */
  progressRange: { kind: 'days', days: 30 },
  /** Unit selected in the check-in duration control. */
  exUnit: 'minutes',
  /** True while the check-in form edits today's already-saved check-in. */
  editingExisting: false,
  meal: { category: null, index: null },
  selectedDayEl: null,
};
