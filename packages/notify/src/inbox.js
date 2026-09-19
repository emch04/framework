/**
 * The notification inbox, server side: read it by pages, tidy it, and never
 * let one account touch another's.
 *
 * Three defects shaped this, all from the same product:
 *
 *   The list returned "the latest fifty" and nothing else. Past fifty, a
 *   notification existed in the database and nobody could ever see it again —
 *   and a page that opened a notification by looking for it in that list
 *   could not open the fifty-first.
 *
 *   Deleting took an id. An id is guessable, or leaks — in a URL, a log, a
 *   screenshot. The ONLY barrier between "delete mine" and "delete anyone's"
 *   is the owner being part of the query itself, not a check made afterwards
 *   that someone forgets on the next route. So every store call here carries
 *   the owner, and a store call without one is refused.
 *
 *   "Not found" and "not yours" must be the same answer. Distinguishing them
 *   tells a stranger which ids exist, and whose.
 *
 * The store is injected: a notification is one document PER RECIPIENT (a
 * message to a whole class writes one copy per account), so deleting yours
 * never touches anyone else's copy, and there is nothing to hide or mask.
 */

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_PAGE_SIZE = 100;

const positiveInteger = (value, fallback) => {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
};

const missingOwner = (ownerId) => ownerId === undefined || ownerId === null || ownerId === '';

/**
 * @param {object} options
 * @param {object} options.store see createMemoryInboxStore for the contract.
 * @param {number} [options.pageSize] default page size. Default 50.
 * @param {number} [options.maxPageSize] a caller cannot ask for more. Default 100.
 * @param {Function} [options.isValidId] (id) => boolean. An id the store would
 *   choke on (a malformed database id raising a cast error, i.e. a 500) is
 *   answered as "not found" without reaching the store.
 */
function createNotificationInbox(options = {}) {
  const store = options.store;
  for (const method of ['list', 'count', 'get', 'remove', 'removeRead', 'markRead', 'markAllRead']) {
    if (!store || typeof store[method] !== 'function') {
      throw new Error(`createNotificationInbox: options.store needs a ${method}() method.`);
    }
  }

  const maxPageSize = positiveInteger(options.maxPageSize, DEFAULT_MAX_PAGE_SIZE);
  const pageSize = Math.min(positiveInteger(options.pageSize, DEFAULT_PAGE_SIZE), maxPageSize);
  const isValidId = typeof options.isValidId === 'function'
    ? options.isValidId
    : (id) => (typeof id === 'string' && id.length > 0) || typeof id === 'number';

  /* A programming error, not a user error: an inbox call without an owner
     would read or delete across every account. Loud, immediately. */
  const requireOwner = (ownerId) => {
    if (missingOwner(ownerId)) throw new Error('notification inbox: every call needs the owner id.');
  };

  const unreadOf = (ownerId) => store.count({ ownerId, read: false });

  /**
   * One page, newest first. Without parameters, the first page at the default
   * size — existing callers that never paginated see no change.
   *
   * @returns {Promise<{notifications: object[], unreadCount: number,
   *   pagination: {total: number, page: number, limit: number, totalPages: number}}>}
   */
  async function list(ownerId, query = {}) {
    requireOwner(ownerId);
    /* Absurd values — negative, zero, text — fall back rather than error: a
       list that refuses to load over a stray query parameter is worse than a
       list at the default size. */
    const limit = Math.min(positiveInteger(query.limit, pageSize), maxPageSize);
    const page = positiveInteger(query.page, 1);

    const [notifications, total, unreadCount] = await Promise.all([
      store.list({ ownerId, offset: (page - 1) * limit, limit }),
      store.count({ ownerId }),
      unreadOf(ownerId)
    ]);

    return {
      notifications,
      unreadCount,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) }
    };
  }

  /** One notification of this owner, or null — absent and foreign look alike. */
  async function get(ownerId, id) {
    requireOwner(ownerId);
    if (!isValidId(id)) return null;
    return (await store.get({ ownerId, id })) || null;
  }

  /**
   * Delete one. The unread count comes back with it, so a badge can settle
   * without waiting for the next refresh.
   *
   * @returns {Promise<{removed: boolean, unreadCount?: number}>}
   */
  async function remove(ownerId, id) {
    requireOwner(ownerId);
    const removed = isValidId(id) ? await store.remove({ ownerId, id }) : 0;
    if (!removed) return { removed: false };
    return { removed: true, unreadCount: await unreadOf(ownerId) };
  }

  /**
   * Delete every READ notification of this owner. Unread ones stay: tidying
   * up must not erase what has not been seen yet.
   */
  async function removeRead(ownerId) {
    requireOwner(ownerId);
    const deleted = (await store.removeRead({ ownerId })) || 0;
    return { deleted, unreadCount: await unreadOf(ownerId) };
  }

  async function markRead(ownerId, id) {
    requireOwner(ownerId);
    const updated = isValidId(id) ? await store.markRead({ ownerId, id }) : 0;
    if (!updated) return { updated: false };
    return { updated: true, unreadCount: await unreadOf(ownerId) };
  }

  async function markAllRead(ownerId) {
    requireOwner(ownerId);
    const updated = (await store.markAllRead({ ownerId })) || 0;
    /* Recounted, not assumed zero: a notification can land between the two. */
    return { updated, unreadCount: await unreadOf(ownerId) };
  }

  return { list, get, remove, removeRead, markRead, markAllRead, pageSize, maxPageSize };
}

/**
 * The reference store, in memory — for tests, and as the contract a real
 * adapter follows. It APPLIES the owner filter it receives, like a database
 * would: an inbox that forgot to pass it would reach the other account here
 * exactly as it would in production, which is what makes tests against it
 * honest.
 *
 * Items: { id, ownerId, read, createdAt, ...anything }.
 * Order: newest first, id as tie-breaker — two notifications from the same
 * instant would otherwise swap between pages, or appear on both.
 */
function createMemoryInboxStore(options = {}) {
  const items = [...(options.items || [])];

  const owned = (ownerId) => {
    if (missingOwner(ownerId)) throw new Error('memory inbox store: query without an owner refused.');
    return items.filter((item) => String(item.ownerId) === String(ownerId));
  };
  const same = (a, b) => String(a) === String(b);
  const newestFirst = (a, b) => (new Date(b.createdAt) - new Date(a.createdAt)) || String(b.id).localeCompare(String(a.id));
  const drop = (predicate) => {
    let removed = 0;
    for (let i = items.length - 1; i >= 0; i -= 1) {
      if (predicate(items[i])) { items.splice(i, 1); removed += 1; }
    }
    return removed;
  };

  return {
    async list({ ownerId, offset = 0, limit }) {
      return owned(ownerId).sort(newestFirst).slice(offset, offset + limit).map((item) => ({ ...item }));
    },
    async count({ ownerId, read }) {
      return owned(ownerId).filter((item) => read === undefined || Boolean(item.read) === read).length;
    },
    async get({ ownerId, id }) {
      const found = owned(ownerId).find((item) => same(item.id, id));
      return found ? { ...found } : null;
    },
    async remove({ ownerId, id }) {
      owned(ownerId);
      /* The owner is IN the match, not checked afterwards: that is the barrier. */
      const index = items.findIndex((item) => same(item.ownerId, ownerId) && same(item.id, id));
      if (index === -1) return 0;
      items.splice(index, 1);
      return 1;
    },
    async removeRead({ ownerId }) {
      owned(ownerId);
      return drop((item) => same(item.ownerId, ownerId) && Boolean(item.read));
    },
    async markRead({ ownerId, id }) {
      const found = owned(ownerId).find((item) => same(item.id, id));
      if (!found) return 0;
      found.read = true;
      return 1;
    },
    async markAllRead({ ownerId }) {
      let updated = 0;
      for (const item of owned(ownerId)) {
        if (!item.read) { item.read = true; updated += 1; }
      }
      return updated;
    },
    /** Test helpers: add a notification, read everything regardless of owner. */
    add(item) { items.push({ read: false, createdAt: new Date(), ...item }); return item; },
    all() { return items.map((item) => ({ ...item })); }
  };
}

const defaultRespond = (res, status, body) => res.status(status).json(body);

/**
 * HTTP handlers over an inbox, for express or anything with the same
 * `(req, res, next)` shape. No framework is imported.
 *
 * @param {object} inbox from createNotificationInbox().
 * @param {object} [options]
 * @param {Function} [options.owner] (req) => owner id. Default req.user.id.
 *   From the SESSION, never from the body or the query: an owner the client
 *   can choose is not an owner.
 * @param {Function} [options.respond] (res, status, body) => void — your
 *   response envelope. Default res.status(status).json(body).
 * @param {string} [options.notFoundMessage]
 */
function createInboxHandlers(inbox, options = {}) {
  if (!inbox || typeof inbox.list !== 'function') {
    throw new Error('createInboxHandlers requires an inbox from createNotificationInbox().');
  }
  const owner = options.owner || ((req) => req.user && req.user.id);
  const respond = options.respond || defaultRespond;
  const notFoundMessage = options.notFoundMessage || 'This notification could not be found.';

  /* Every handler forwards its errors to next(): an async handler that throws
     otherwise becomes an unhandled rejection and a request that never ends. */
  const handler = (run) => async (req, res, next) => {
    try {
      const ownerId = owner(req);
      if (missingOwner(ownerId)) return respond(res, 401, { message: 'Sign in to see your notifications.' });
      return await run(req, res, ownerId);
    } catch (error) {
      return typeof next === 'function' ? next(error) : undefined;
    }
  };

  const notFound = (res) => respond(res, 404, { message: notFoundMessage });

  return {
    list: handler(async (req, res, ownerId) => respond(res, 200, await inbox.list(ownerId, req.query || {}))),
    get: handler(async (req, res, ownerId) => {
      const notification = await inbox.get(ownerId, req.params && req.params.id);
      return notification ? respond(res, 200, { notification }) : notFound(res);
    }),
    remove: handler(async (req, res, ownerId) => {
      const result = await inbox.remove(ownerId, req.params && req.params.id);
      return result.removed ? respond(res, 200, { unreadCount: result.unreadCount }) : notFound(res);
    }),
    removeRead: handler(async (_req, res, ownerId) => respond(res, 200, await inbox.removeRead(ownerId))),
    markRead: handler(async (req, res, ownerId) => {
      const result = await inbox.markRead(ownerId, req.params && req.params.id);
      return result.updated ? respond(res, 200, { unreadCount: result.unreadCount }) : notFound(res);
    }),
    markAllRead: handler(async (_req, res, ownerId) => respond(res, 200, await inbox.markAllRead(ownerId)))
  };
}

/**
 * Register the handlers on a router, FIXED PATHS FIRST.
 *
 * `DELETE /read` registered after `DELETE /:id` is read as "delete the
 * notification whose id is 'read'" — which answers 404, and the tidy-up button
 * silently does nothing. Order is the whole point of this function.
 *
 * @param {object} router anything with get/patch/delete(path, handler).
 */
function mountInbox(router, handlers) {
  router.get('/', handlers.list);
  router.patch('/read-all', handlers.markAllRead);
  router.delete('/read', handlers.removeRead);
  router.get('/:id', handlers.get);
  router.patch('/:id/read', handlers.markRead);
  router.delete('/:id', handlers.remove);
  return router;
}

module.exports = {
  createNotificationInbox,
  createMemoryInboxStore,
  createInboxHandlers,
  mountInbox
};
