// Single in-memory app state. The repository persists; this is the working copy.
export const state = {
  /**
   * App lifecycle: 'booting' (splash, nothing known yet) -> 'loading' (restoring session + loading the user's data)
   * -> 'ready' (signed in, data loaded) | 'signed-out' | 'error' (could not load; never rendered as empty data).
   */
  status: 'booting',
  /** Current user in domain shape (see data/repository.js), or null when logged out. */
  user: null,
  /** In-progress check-in being edited. */
  draft: null,
  /** Onboarding answers collected before the journey is created. */
  onboarding: { start: null, goal: null, duration: 90, custom: false },
  /** Progress view: { kind:'days', days:N } | { kind:'all' } (independent of the journey length). */
  progressRange: { kind: 'days', days: 30 },
  /** Check-in movement form: the chosen movement type (null = none yet) and the selected muscle groups (Gym). */
  exType: null,
  exMuscles: [],
  /** True while the check-in form edits today's already-saved check-in. */
  editingExisting: false,
  meal: { category: null, index: null },
  selectedDayEl: null,
};
