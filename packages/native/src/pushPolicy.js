/**
 * Two decisions about a push that are easy to get wrong.
 *
 * WHEN TO ASK. The system prompt can be raised ONCE. Raise it on launch,
 * before the person understands what the app sends, and a reflex "no" is
 * permanent — the OS never asks again, and the only way back is a trip to the
 * settings app that almost nobody makes. So the prompt waits for an explicit
 * tap, and an already-granted permission registers silently.
 *
 * WHERE A TAP LEADS. A notification carries a route from the server. Following
 * it blindly opens screens the recipient has no business seeing: the payload
 * is data from the network, and roles change between the moment a notification
 * is sent and the moment it is tapped. So a route is followed only if it
 * matches a declared rule AND the rule admits this recipient. Everything else
 * lands on the notification list, which is never wrong.
 *
 * The rules are declared BY ALLOWANCE, not by exclusion: a route nobody
 * declared is refused. A blocklist silently admits every screen added later
 * and forgotten.
 */

/**
 * @param {{explicit: boolean, permission: 'undetermined'|'granted'|'denied'}} input
 *   `explicit` is true when the person just tapped the switch themselves.
 * @returns {'none'|'register'|'request'|'open-settings'}
 */
function decideRegistrationAction({ explicit, permission } = {}) {
  if (permission === 'granted') return 'register';
  if (!explicit) return 'none';
  return permission === 'undetermined' ? 'request' : 'open-settings';
}

/** Query strings and fragments are decoration; they must not defeat a match. */
function normalizeRoute(route) {
  if (typeof route !== 'string') return '';
  return route.split(/[?#]/, 1)[0];
}

/**
 * @param {object} options
 * @param {string} options.fallback  Where a refused or unknown route lands.
 * @param {Array<{pattern: RegExp, allow: Function, to?: string}>} [options.routes]
 *   `allow(recipient, match)` decides; `to` overrides the destination.
 * @param {Object<string, Function>} [options.actions]  Notification action
 *   buttons: id => (payload) => route|null. The result goes through the same
 *   permission check as any other route.
 */
function createNotificationRouter(options = {}) {
  const fallback = options.fallback || '/';
  const routes = Array.isArray(options.routes) ? options.routes : [];
  const actions = options.actions || {};

  function resolve(route, recipient) {
    const normalized = normalizeRoute(route);
    if (!normalized) return fallback;
    for (const rule of routes) {
      if (!rule || !(rule.pattern instanceof RegExp)) continue;
      const match = normalized.match(rule.pattern);
      if (!match) continue;
      const allowed = typeof rule.allow === 'function' ? rule.allow(recipient, match) : true;
      return allowed ? (rule.to || normalized) : fallback;
    }
    return fallback;
  }

  /**
   * A tap on an action button. The button names an intent ("justify", "refund");
   * turning it into a route is the app's business, checking it is ours.
   */
  function resolveAction(payload, recipient) {
    const data = payload || {};
    const build = actions[data.actionIdentifier];
    if (typeof build === 'function') {
      const route = build(data);
      if (route) return resolve(route, recipient);
    }
    return resolve(data.route, recipient);
  }

  return { resolve, resolveAction, fallback };
}

module.exports = { decideRegistrationAction, createNotificationRouter };
