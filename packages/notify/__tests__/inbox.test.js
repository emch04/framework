const { URLSearchParams } = require('url');
const {
  createNotificationInbox,
  createMemoryInboxStore,
  createInboxHandlers,
  mountInbox
} = require('../src');

const ACCOUNT_A = '64b000000000000000000001';
const ACCOUNT_B = '64b000000000000000000002';
const isObjectId = (id) => typeof id === 'string' && /^[0-9a-f]{24}$/i.test(id);

/* A router with express's one rule that matters here: routes are tried in
   registration order, and the first match wins. */
function fakeRouter() {
  const routes = [];
  const add = (method) => (path, handler) => { routes.push({ method, path, handler }); };
  const match = (pattern, pathname) => {
    const expected = pattern.split('/');
    const actual = pathname.split('/');
    if (expected.length !== actual.length) return null;
    const params = {};
    for (let i = 0; i < expected.length; i += 1) {
      if (expected[i].startsWith(':')) params[expected[i].slice(1)] = decodeURIComponent(actual[i]);
      else if (expected[i] !== actual[i]) return null;
    }
    return params;
  };

  async function request(method, url, user) {
    const [pathname, search] = url.split('?');
    const query = Object.fromEntries(new URLSearchParams(search || ''));
    for (const route of routes) {
      if (route.method !== method) continue;
      const params = match(route.path, pathname);
      if (!params) continue;
      const res = {
        statusCode: 200,
        body: undefined,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
      };
      let failure;
      await route.handler({ params, query, user }, res, (error) => { failure = error; });
      if (failure) throw failure;
      return { status: res.statusCode, body: res.body };
    }
    return { status: 404, body: { message: 'no route' } };
  }

  return { get: add('GET'), patch: add('PATCH'), delete: add('DELETE'), request, routes };
}

let store;
let inbox;
let router;
let next;

const hex = (n) => n.toString(16).padStart(24, '0');
const add = (ownerId, fields = {}) => {
  next += 1;
  return store.add({
    id: hex(0xa00000 + next),
    ownerId,
    title: `N${next}`,
    read: false,
    createdAt: new Date(Date.UTC(2026, 8, 1) + next * 60_000),
    ...fields
  });
};
const as = (ownerId) => ({ id: ownerId });
const ids = () => store.all().map((item) => item.id);

beforeEach(() => {
  next = 0;
  store = createMemoryInboxStore();
  inbox = createNotificationInbox({ store, isValidId: isObjectId });
  router = mountInbox(fakeRouter(), createInboxHandlers(inbox));
});

describe('reading the inbox by pages', () => {
  test('without parameters: the first page at the default size', async () => {
    for (let i = 0; i < 60; i += 1) add(ACCOUNT_A);

    const res = await router.request('GET', '/', as(ACCOUNT_A));

    expect(res.status).toBe(200);
    expect(res.body.notifications).toHaveLength(50);
    expect(res.body.pagination).toEqual({ total: 60, page: 1, limit: 50, totalPages: 2 });
    expect(res.body.unreadCount).toBe(60);
  });

  test('page 3 returns the rest, newest first, with no overlap', async () => {
    for (let i = 0; i < 25; i += 1) add(ACCOUNT_A);

    const first = await router.request('GET', '/?page=1&limit=10', as(ACCOUNT_A));
    const third = await router.request('GET', '/?page=3&limit=10', as(ACCOUNT_A));

    expect(first.body.notifications[0].title).toBe('N25');
    expect(third.body.notifications.map((n) => n.title)).toEqual(['N5', 'N4', 'N3', 'N2', 'N1']);
    expect(third.body.pagination).toEqual({ total: 25, page: 3, limit: 10, totalPages: 3 });
  });

  test('the page size is capped and absurd values fall back', async () => {
    for (let i = 0; i < 3; i += 1) add(ACCOUNT_A);

    expect((await router.request('GET', '/?limit=5000', as(ACCOUNT_A))).body.pagination.limit).toBe(100);
    expect((await router.request('GET', '/?page=-4&limit=abc', as(ACCOUNT_A))).body.pagination)
      .toEqual(expect.objectContaining({ page: 1, limit: 50 }));
    expect((await router.request('GET', '/?limit=0', as(ACCOUNT_A))).body.pagination.limit).toBe(50);
  });

  test('sizes are configurable, and the default never exceeds the cap', () => {
    expect(createNotificationInbox({ store, pageSize: 20, maxPageSize: 40 })).toMatchObject({ pageSize: 20, maxPageSize: 40 });
    expect(createNotificationInbox({ store, pageSize: 500, maxPageSize: 40 }).pageSize).toBe(40);
  });

  test('two notifications from the same instant never swap pages: the id breaks the tie', async () => {
    /* A database returns ties in whatever order it likes, and may change its
       mind between two queries — a notification then shows on two pages, or
       on none. Inserted scrambled here, so insertion order proves nothing. */
    const instant = new Date(Date.UTC(2026, 8, 1));
    for (const n of [3, 6, 1, 5, 2, 4]) store.add({ id: hex(n), ownerId: ACCOUNT_A, createdAt: instant });

    const pages = [];
    for (let page = 1; page <= 3; page += 1) {
      pages.push(...(await inbox.list(ACCOUNT_A, { page, limit: 2 })).notifications.map((n) => n.id));
    }

    expect(pages).toEqual([6, 5, 4, 3, 2, 1].map(hex));
  });

  test('counts and returns only the signed-in account\'s notifications', async () => {
    add(ACCOUNT_A);
    add(ACCOUNT_B);
    add(ACCOUNT_B);

    const res = await router.request('GET', '/', as(ACCOUNT_A));

    expect(res.body.notifications).toHaveLength(1);
    expect(res.body.pagination.total).toBe(1);
    expect(res.body.unreadCount).toBe(1);
  });

  test('the owner comes from the session, never from the query', async () => {
    add(ACCOUNT_B);

    const res = await router.request('GET', `/?ownerId=${ACCOUNT_B}`, as(ACCOUNT_A));

    expect(res.body.notifications).toHaveLength(0);
  });
});

describe('one notification', () => {
  test('its owner can read it', async () => {
    const mine = add(ACCOUNT_A);

    const res = await router.request('GET', `/${mine.id}`, as(ACCOUNT_A));

    expect(res.status).toBe(200);
    expect(res.body.notification.title).toBe(mine.title);
  });

  test('another account gets EXACTLY the answer of an absent id', async () => {
    const mine = add(ACCOUNT_A);

    const foreign = await router.request('GET', `/${mine.id}`, as(ACCOUNT_B));
    const absent = await router.request('GET', `/${hex(0xfffff)}`, as(ACCOUNT_B));

    expect(foreign.status).toBe(404);
    expect(foreign).toEqual(absent);
  });

  test('a malformed id answers 404 without reaching the store', async () => {
    const spy = jest.spyOn(store, 'get');

    const res = await router.request('GET', '/not-an-id', as(ACCOUNT_A));

    expect(res.status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });

  test('fixed paths are not taken for ids — DELETE /read is the tidy-up, not a lookup', async () => {
    const spy = jest.spyOn(store, 'remove');
    add(ACCOUNT_A, { read: true });

    const res = await router.request('DELETE', '/read', as(ACCOUNT_A));

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(1);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('deleting one notification', () => {
  test('deletes its own and returns the new unread count', async () => {
    const mine = add(ACCOUNT_A);
    add(ACCOUNT_A);

    const res = await router.request('DELETE', `/${mine.id}`, as(ACCOUNT_A));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ unreadCount: 1 });
    expect(ids()).not.toContain(mine.id);
  });

  test('another account cannot delete it — and learns nothing from trying', async () => {
    const mine = add(ACCOUNT_A);

    const foreign = await router.request('DELETE', `/${mine.id}`, as(ACCOUNT_B));
    const absent = await router.request('DELETE', `/${hex(0xfffff)}`, as(ACCOUNT_B));

    expect(foreign.status).toBe(404);
    expect(foreign).toEqual(absent);
    expect(ids()).toContain(mine.id);
  });

  test('a notification sent to several accounts disappears only for the one who deletes it', async () => {
    /* One copy per recipient: a message to a whole group writes one per account. */
    const forA = add(ACCOUNT_A, { title: 'Trip on Friday' });
    const forB = add(ACCOUNT_B, { title: 'Trip on Friday' });

    await router.request('DELETE', `/${forA.id}`, as(ACCOUNT_A));

    expect(ids()).toEqual([forB.id]);
  });

  test('absent or malformed: 404, nothing deleted', async () => {
    add(ACCOUNT_A);

    expect((await router.request('DELETE', `/${hex(0xfffff)}`, as(ACCOUNT_A))).status).toBe(404);
    expect((await router.request('DELETE', '/xyz', as(ACCOUNT_A))).status).toBe(404);
    expect(store.all()).toHaveLength(1);
  });
});

describe('deleting read notifications', () => {
  test('deletes this account\'s read ones, keeps its unread ones and everything of others', async () => {
    add(ACCOUNT_A, { read: true });
    add(ACCOUNT_A, { read: true });
    const unread = add(ACCOUNT_A, { read: false });
    const readByB = add(ACCOUNT_B, { read: true });

    const res = await router.request('DELETE', '/read', as(ACCOUNT_A));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 2, unreadCount: 1 });
    expect(ids().sort()).toEqual([unread.id, readByB.id].sort());
  });

  test('nothing to tidy: zero, no error', async () => {
    add(ACCOUNT_A, { read: false });

    expect((await router.request('DELETE', '/read', as(ACCOUNT_A))).body).toEqual({ deleted: 0, unreadCount: 1 });
  });
});

describe('marking as read', () => {
  test('one of its own, with the new unread count', async () => {
    const mine = add(ACCOUNT_A);
    add(ACCOUNT_A);

    const res = await router.request('PATCH', `/${mine.id}/read`, as(ACCOUNT_A));

    expect(res.body).toEqual({ unreadCount: 1 });
  });

  test('another account\'s: 404, and it stays unread', async () => {
    const mine = add(ACCOUNT_A);

    expect((await router.request('PATCH', `/${mine.id}/read`, as(ACCOUNT_B))).status).toBe(404);
    expect(store.all()[0].read).toBe(false);
  });

  test('all of its own, none of anyone else\'s', async () => {
    add(ACCOUNT_A);
    add(ACCOUNT_A);
    add(ACCOUNT_B);

    const res = await router.request('PATCH', '/read-all', as(ACCOUNT_A));

    expect(res.body).toEqual({ updated: 2, unreadCount: 0 });
    expect(store.all().filter((n) => !n.read).map((n) => n.ownerId)).toEqual([ACCOUNT_B]);
  });
});

describe('guards', () => {
  test('no session: 401, the store is never asked', async () => {
    const spy = jest.spyOn(store, 'list');

    expect((await router.request('GET', '/', undefined)).status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  test('an inbox call without an owner is a programming error, thrown at once', async () => {
    await expect(inbox.list(undefined)).rejects.toThrow(/owner/);
    await expect(inbox.remove('', 'x')).rejects.toThrow(/owner/);
    await expect(inbox.removeRead(null)).rejects.toThrow(/owner/);
  });

  test('the memory store itself refuses a query without an owner', async () => {
    await expect(store.remove({ id: 'x' })).rejects.toThrow(/owner/);
    await expect(store.count({})).rejects.toThrow(/owner/);
  });

  test('a store missing a method is refused up front', () => {
    expect(() => createNotificationInbox({ store: { list() {} } })).toThrow(/count\(\)/);
    expect(() => createNotificationInbox({})).toThrow(/store/);
  });

  test('a failing store reaches next(), it does not hang the request', async () => {
    const broken = createNotificationInbox({ store: { ...store, list: async () => { throw new Error('store down'); } } });
    const handlers = createInboxHandlers(broken);
    let forwarded;

    await handlers.list({ user: { id: ACCOUNT_A }, query: {} }, {}, (error) => { forwarded = error; });

    expect(forwarded.message).toBe('store down');
  });

  test('owner, envelope and message are the product\'s to choose', async () => {
    const mine = add(ACCOUNT_A);
    const handlers = createInboxHandlers(inbox, {
      owner: (req) => req.session.accountId,
      respond: (res, status, body) => res.send({ status, success: status < 400, data: body }),
      notFoundMessage: 'Gone.'
    });
    const sent = [];
    const res = { send: (payload) => sent.push(payload) };

    await handlers.get({ session: { accountId: ACCOUNT_A }, params: { id: mine.id } }, res);
    await handlers.get({ session: { accountId: ACCOUNT_B }, params: { id: mine.id } }, res);

    expect(sent[0]).toMatchObject({ status: 200, success: true });
    expect(sent[1]).toEqual({ status: 404, success: false, data: { message: 'Gone.' } });
  });
});
