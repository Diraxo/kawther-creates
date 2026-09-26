// The Goal Achievement Experience as a tiny state machine (pure; the DOM/timers live in ui/goalExperience.js).
//
//   recognition -> recap -> trophy -> choices        (first time: she decides what comes next)
//   recognition -> recap -> trophy                   (replay via "Celebrate again": nothing to decide)
//   choices                                          (from Home: choose, or change, what comes next)
//
// `advance()` moves one phase, `skip()` jumps straight to the last phase. On the last phase, advance() finishes.
export const PHASE_MS = { recognition: 6200, recap: 6400, trophy: 0 }; // 0 = waits for the user (never auto-advances)

export function phasesFor({ replay, choicesOnly = false }) {
  if (choicesOnly) return ['choices']; // from Home: just (re)choose what comes next
  return replay ? ['recognition', 'recap', 'trophy'] : ['recognition', 'recap', 'trophy', 'choices'];
}

export function createSequence(phases) {
  let i = 0;
  let finished = false;
  return {
    get phase() { return phases[i]; },
    get last() { return i === phases.length - 1; },
    get finished() { return finished; },
    advance() {
      if (finished) return this.phase;
      if (i < phases.length - 1) i++; else finished = true;
      return this.phase;
    },
    skip() {
      if (!finished) i = phases.length - 1;
      return this.phase;
    },
  };
}
