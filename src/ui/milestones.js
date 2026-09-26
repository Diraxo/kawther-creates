// Achievement celebrations shown one at a time. Several unlocks from one action queue up:
// First Step -> (Nice!) -> Consistent -> (Nice!) -> back to the completed check-in sheet.
import { $ } from '../lib/dom.js';
import { REDUCE } from '../lib/motion.js';
import { svgIcon } from '../lib/icons.js';
import { createMilestoneQueue } from '../domain/milestoneQueue.js';
import { onOverlayClosed, openOverlay } from './overlays.js';

const queue = createMilestoneQueue({
  gap: REDUCE ? 0 : 250,
  present(a, hasMore) {
    $('mi-title').textContent = a.t;
    $('mi-sub').textContent = a.d;
    $('mi-btn').textContent = hasMore ? 'Next' : 'Nice!';
    $('ov-milestone').querySelector('.sparkle-wrap .ic').innerHTML = svgIcon(a.ic);
    openOverlay('ov-milestone');
  },
});
onOverlayClosed('ov-milestone', () => queue.closed());

export const celebrateAchievements = (defs) => queue.enqueue(defs, REDUCE ? 0 : 650);
export const resetMilestones = () => queue.clear();
