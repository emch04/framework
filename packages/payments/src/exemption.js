/**
 * The one predicate every layer must agree on.
 *
 * Trap 2: a webhook has to cross the whole middleware stack, and every layer
 * has a reason to stop it. CSRF returns 403 to a caller with no cookie. Auth
 * rejects a caller that is not a user. A rate limiter throttles a burst of
 * retries. A JSON parser destroys the bytes the signature covers.
 *
 * Each of those exemptions is usually written separately — a path list here, a
 * regex there — and they drift. In one real case four layers each exempted one
 * webhook and forgot a second one; every payment on that flow died before
 * reaching the code meant to record it, and nothing logged an error.
 *
 * One predicate, used by every layer, cannot drift.
 *
 *   const isWebhook = createWebhookExemption({ suffix: '/webhook' });
 *
 *   app.use(express.json({ skip: isWebhook }));       // trap 1
 *   app.use(csrf({ skip: isWebhook }));               // trap 2
 *   app.use(subscriptionGuard({ skip: isWebhook }));  // trap 2
 */

/**
 * @param {object} [options]
 * @param {string[]} [options.paths]   exact paths that are webhooks.
 * @param {string} [options.prefix]    e.g. '/api/payments/'
 * @param {string} [options.suffix]    e.g. '/webhook'
 * @param {RegExp} [options.pattern]   anything the above cannot express.
 * @returns {(req: object|string) => boolean}
 */
function createWebhookExemption(options = {}) {
  const paths = new Set(options.paths || []);
  const prefix = options.prefix || null;
  const suffix = options.suffix || null;
  const pattern = options.pattern || null;

  if (!paths.size && !prefix && !suffix && !pattern) {
    throw new Error('createWebhookExemption requires at least one of paths, prefix, suffix or pattern.');
  }

  /* Match on the path alone. A query string is not part of the route, and
     letting one through the comparison is how an exemption silently stops
     matching the day someone appends `?retry=1`. */
  const pathOf = (input) => {
    const raw = typeof input === 'string' ? input : (input && (input.path || input.originalUrl || input.url)) || '';
    return String(raw).split('?')[0];
  };

  return function isWebhook(input) {
    const path = pathOf(input);
    if (!path) return false;
    if (paths.has(path)) return true;
    /* A prefix on its own would exempt an entire section of the API — the
       suffix is what keeps the exemption to the webhook itself. */
    if (prefix && suffix) return path.startsWith(prefix) && path.endsWith(suffix);
    if (prefix) return path.startsWith(prefix);
    if (suffix) return path.endsWith(suffix);
    return pattern ? pattern.test(path) : false;
  };
}

module.exports = { createWebhookExemption };
