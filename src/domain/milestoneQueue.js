// Pure sequencing for achievement celebrations (no DOM).
/**
 * Pure sequencing logic (unit-tested). `present(item, hasMore)` shows one celebration;
 * call `closed()` when the user dismisses it and the next one is scheduled after `gap` ms.
 */
export function createMilestoneQueue({ present, gap = 250, schedule = setTimeout }) {
  const items = [];
  let active = false;
  const pump = () => {
    if (!items.length) { active = false; return; }
    const item = items.shift();
    present(item, items.length > 0);
  };
  return {
    enqueue(list, firstDelay = 0) {
      items.push(...list);
      if (!active && items.length) { active = true; schedule(pump, firstDelay); }
    },
    closed() { if (active) schedule(pump, gap); },
    clear() { items.length = 0; active = false; },
    get pending() { return items.length; },
  };
}
