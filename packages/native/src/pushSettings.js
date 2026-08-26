/**
 * The push switch in the settings screen, and the two bugs it always has.
 *
 * A NETWORK ANSWER OUTLIVES THE SCREEN. Tap the switch, leave immediately: the
 * request lands on a screen that no longer exists. In React that is a warning;
 * in a state machine it is worse — the stale answer overwrites the state of
 * whoever came after. Each activation gets a GENERATION, and a generation that
 * is no longer current publishes nothing.
 *
 * THE SWITCH LIES ABOUT WHAT IT WILL DO. "Enabled/disabled" is not the whole
 * story: a permission the person denied once cannot be re-requested, so the
 * button must open the settings app instead of pretending to toggle. Five
 * states, one action each, decided in one place.
 *
 * The state is never inferred from what we just did — it is RE-READ from the
 * device afterwards. Assuming "enable succeeded, so it is enabled" is how a
 * switch ends up on while notifications are off.
 */

/**
 * @param {'loading'|'enabled'|'disabled'|'undetermined'|'denied'|'error'} state
 * @returns {'enable'|'disable'|'open-settings'|'retry'|null}
 */
function resolvePushAction(state) {
  if (state === 'enabled') return 'disable';
  if (state === 'disabled' || state === 'undetermined') return 'enable';
  if (state === 'denied') return 'open-settings';
  if (state === 'error') return 'retry';
  return null;
}

function isPushEnabled(state) {
  return state === 'enabled';
}

/**
 * @param {object} operations  getState/enable/disable/openSettings, all async.
 * @param {Function} onChange  Called with {state, busy} on every change.
 * @returns {{activate: Function, refresh: Function, act: Function}}
 *   `activate()` returns {ready, dispose} — dispose on unmount.
 */
function createPushSettingsController(operations, onChange) {
  if (!operations || typeof operations.getState !== 'function') {
    throw new Error('createPushSettingsController requires operations.getState.');
  }
  const publishTo = typeof onChange === 'function' ? onChange : () => {};
  let current = null;

  const isCurrent = (generation) => generation.active && current === generation;

  const publish = (generation) => {
    if (!isCurrent(generation)) return;
    publishTo({ state: generation.state, busy: generation.busy });
  };

  async function run(generation, operation) {
    if (!isCurrent(generation) || generation.busy) return;
    generation.busy = true;
    publish(generation);
    try {
      if (operation) await operation();
      if (!isCurrent(generation)) return;
      const state = await operations.getState();
      if (!isCurrent(generation)) return;
      generation.state = state;
    } catch {
      if (isCurrent(generation)) generation.state = 'error';
    } finally {
      if (isCurrent(generation)) {
        generation.busy = false;
        publish(generation);
      }
    }
  }

  function refresh() {
    if (!current) return Promise.resolve();
    return run(current);
  }

  function act() {
    if (!current || current.busy) return Promise.resolve();
    const action = resolvePushAction(current.state);
    if (!action) return Promise.resolve();
    const operation = action === 'enable' ? operations.enable
      : action === 'disable' ? operations.disable
        : action === 'open-settings' ? operations.openSettings
          : undefined;
    return run(current, operation);
  }

  function activate() {
    if (current) current.active = false;
    const generation = { state: 'loading', busy: false, active: true };
    current = generation;
    const ready = run(generation);
    return {
      ready,
      dispose() {
        generation.active = false;
        if (current === generation) current = null;
      }
    };
  }

  return { activate, refresh, act };
}

module.exports = { resolvePushAction, isPushEnabled, createPushSettingsController };
