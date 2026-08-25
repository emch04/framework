/**
 * What is left to do before closing a period.
 *
 * A school year, a fiscal quarter, a season: every product with periods ends up
 * closing them, and closing usually starts as an automated deadline — a job
 * runs at midnight and shuts the period when some condition holds. Nobody can
 * see what is missing, and nobody actually decides.
 *
 * A checklist gives the closing back to the people who carry it. Each item says
 * what remains, and whether it forbids closing.
 *
 * The distinction that matters is `blocking`. Some items forbid closure — an
 * undecided grade decision commits a child's future. Others only deserve to be
 * SEEN — an unpaid fee can be negotiated and carried over. Closing a period
 * with open non-blocking items is legitimate; doing it without having looked is
 * not. That is what acknowledgement is for.
 *
 * Pure logic: reads nothing, writes nothing. Your controller counts, this
 * judges.
 */

/**
 * @param {Array} checks  [{ id, blocking, label? }] — your domain's checkpoints.
 */
function createClosureChecklist(checks = []) {
  if (!Array.isArray(checks) || !checks.length) {
    throw new Error('createClosureChecklist requires at least one check.');
  }
  const seen = new Set();
  for (const check of checks) {
    if (!check || typeof check.id !== 'string' || !check.id.trim()) {
      throw new Error('createClosureChecklist requires every check to have an id.');
    }
    if (seen.has(check.id)) {
      throw new Error(`createClosureChecklist received the check "${check.id}" twice.`);
    }
    seen.add(check.id);
  }

  /**
   * @param {Record<string, number>} counts  what your controller counted.
   */
  function build(counts = {}) {
    const items = checks.map((check) => {
      const remaining = Math.max(0, Number(counts[check.id]) || 0);
      return {
        id: check.id,
        label: check.label || check.id,
        remaining,
        blocking: Boolean(check.blocking),
        done: remaining === 0,
        /* Open but non-blocking: does not forbid closing, DEMANDS an explicit
           tick from a person. */
        needsAcknowledgement: remaining > 0 && !check.blocking
      };
    });

    const blocking = items.filter((item) => item.blocking && !item.done).length;
    return {
      items,
      blocking,
      remaining: items.filter((item) => !item.done).length,
      canClose: blocking === 0
    };
  }

  /**
   * May the period be closed, given what the person has acknowledged?
   *
   * An acknowledgement for an item that needs none is ignored, not rewarded:
   * ticking boxes in advance must not pre-approve problems that appear later.
   */
  function canCloseWith(checklist, acknowledged = []) {
    if (!checklist || !checklist.canClose) return { ok: false, reason: 'blocking' };
    const ticked = new Set(acknowledged);
    const unseen = checklist.items
      .filter((item) => item.needsAcknowledgement && !ticked.has(item.id))
      .map((item) => item.id);
    return unseen.length ? { ok: false, reason: 'unacknowledged', unseen } : { ok: true };
  }

  return { build, canCloseWith, checks: checks.map((check) => check.id) };
}

module.exports = { createClosureChecklist };
