const path = require('path');
const {
  createPrivateFileLinks,
  serializeForReader,
  serializeForBroadcast,
  resolveStoredFile,
  privateFileHeaders,
  createPrivateFileHandler,
  WAF_PATTERNS
} = require('../src');

const SECRET = 'file-link-secret-for-tests-only-0123456789';
const STEP_MS = 15 * 60 * 1000;
const BASE = Math.floor(1_757_000_000_000 / STEP_MS) * STEP_MS;
const FILE = '6a9f1ea74a25fbbc1f039861';
const ALICE = { id: 'alice', version: 3 };
const BOB = { id: 'bob', version: 0 };

function setup(overrides = {}) {
  let clock = overrides.at ?? BASE + 60_000;
  const versions = new Map([['alice', 3], ['bob', 0]]);
  const links = createPrivateFileLinks({
    secret: SECRET,
    basePath: '/api/files',
    accountVersion: async (id) => (versions.has(id) ? versions.get(id) : null),
    now: () => clock,
    ...overrides.options
  });
  return { links, versions, advance: (ms) => { clock += ms; }, set: (ms) => { clock = ms; } };
}

const ticketOf = (url) => new URL(`http://x${url}`).searchParams.get('ticket');

describe('signing', () => {
  test('refuses a missing or short secret', () => {
    expect(() => createPrivateFileLinks({})).toThrow(/secret/);
    expect(() => createPrivateFileLinks({ secret: 'short' })).toThrow(/secret/);
  });

  test('two requests within a step give the SAME address (caches and players keep working)', () => {
    const { links, advance } = setup();
    const first = links.linkFor('messages', FILE, ALICE);
    advance(5_000);
    expect(links.linkFor('messages', FILE, ALICE)).toBe(first);
  });

  test('the address changes at the next step, and a link taken just before still lives a full step', async () => {
    const { links, set } = setup();
    set(BASE + STEP_MS - 1_000);
    const before = links.linkFor('messages', FILE, ALICE);
    set(BASE + STEP_MS + 1_000);
    expect(links.linkFor('messages', FILE, ALICE)).not.toBe(before);
    set(BASE + 2 * STEP_MS - 1);
    expect((await links.verify(ticketOf(before), { kind: 'messages', fileId: FILE })).valid).toBe(true);
  });

  test('two readers never get the same pass', () => {
    const { links } = setup();
    expect(links.linkFor('messages', FILE, ALICE)).not.toBe(links.linkFor('messages', FILE, BOB));
  });

  test('no reader, no link', () => {
    const { links } = setup();
    expect(links.linkFor('messages', FILE, null)).toBeNull();
  });

  test('the pass is hex only — a WAF never mistakes it for an SQL comment', () => {
    const { links, set } = setup();
    for (let i = 0; i < 300; i += 1) {
      set(BASE + i * STEP_MS);
      const url = links.linkFor('messages', `${FILE.slice(0, 20)}${String(i).padStart(4, '0')}`, { id: `u${i}`, version: i });
      const query = JSON.stringify({ ticket: ticketOf(url) });
      for (const pattern of WAF_PATTERNS) {
        pattern.lastIndex = 0;
        expect(pattern.test(query)).toBe(false);
      }
    }
  });

  test('a kind or id outside the safe alphabet never reaches a URL', () => {
    const { links } = setup();
    expect(() => links.pathFor('../etc', FILE)).toThrow();
    expect(() => links.pathFor('messages', '../../passwd')).toThrow();
  });
});

describe('verifying', () => {
  test('accepts the reader\'s own pass for the file it was signed for', async () => {
    const { links } = setup();
    const check = await links.verify(ticketOf(links.linkFor('messages', FILE, ALICE)), { kind: 'messages', fileId: FILE });
    expect(check).toMatchObject({ valid: true, accountId: 'alice', version: 3 });
  });

  test('SIGNATURE: one altered character is refused', async () => {
    const { links } = setup();
    const ticket = ticketOf(links.linkFor('messages', FILE, ALICE));
    const last = ticket.slice(-1) === '0' ? '1' : '0';
    expect(await links.verify(ticket.slice(0, -1) + last, { kind: 'messages', fileId: FILE }))
      .toEqual({ valid: false, reason: 'bad-signature' });
  });

  test('SIGNATURE: a payload rewritten to another account is refused', async () => {
    const { links } = setup();
    const [, signature] = ticketOf(links.linkFor('messages', FILE, BOB)).split('.');
    const step = Math.floor((BASE + 60_000) / 1000 / 900) * 900;
    const forged = Buffer.from(JSON.stringify(['private-file', 'messages', FILE, 'alice', 3, step, step + 1800])).toString('hex');
    expect((await links.verify(`${forged}.${signature}`, { kind: 'messages', fileId: FILE })).reason).toBe('bad-signature');
  });

  test('SIGNATURE: a pass signed with another secret is refused', async () => {
    const { links } = setup();
    const other = createPrivateFileLinks({ secret: `${SECRET}-other`, now: () => BASE + 60_000 });
    const ticket = other.sign({ kind: 'messages', fileId: FILE, accountId: 'alice', version: 3 }).ticket;
    expect((await links.verify(ticket, { kind: 'messages', fileId: FILE })).reason).toBe('bad-signature');
  });

  test('EXPIRATION: refused after two steps', async () => {
    const { links, set } = setup();
    const ticket = ticketOf(links.linkFor('messages', FILE, ALICE));
    set(BASE + 2 * STEP_MS);
    expect(await links.verify(ticket, { kind: 'messages', fileId: FILE })).toEqual({ valid: false, reason: 'expired' });
  });

  test('EXPIRATION: a pass dated in the future is refused', async () => {
    const { links, set } = setup();
    set(BASE + 3 * STEP_MS);
    const ticket = ticketOf(links.linkFor('messages', FILE, ALICE));
    set(BASE);
    expect((await links.verify(ticket, { kind: 'messages', fileId: FILE })).reason).toBe('expired');
  });

  test('a pass for one file does not open another', async () => {
    const { links } = setup();
    const ticket = ticketOf(links.linkFor('messages', FILE, ALICE));
    expect((await links.verify(ticket, { kind: 'messages', fileId: 'another0000000000000000' })).reason).toBe('wrong-file');
    expect((await links.verify(ticket, { kind: 'resources', fileId: FILE })).reason).toBe('wrong-file');
  });

  test('ACCOUNT: "sign out everywhere" kills the passes already handed out', async () => {
    const { links, versions } = setup();
    const ticket = ticketOf(links.linkFor('messages', FILE, ALICE));
    versions.set('alice', 4);
    expect((await links.verify(ticket, { kind: 'messages', fileId: FILE })).reason).toBe('revoked');
  });

  test('ACCOUNT: a deleted account\'s pass is refused', async () => {
    const { links, versions } = setup();
    const ticket = ticketOf(links.linkFor('messages', FILE, ALICE));
    versions.delete('alice');
    expect((await links.verify(ticket, { kind: 'messages', fileId: FILE })).reason).toBe('unknown-account');
  });

  test('garbage is refused without throwing', async () => {
    const { links } = setup();
    expect((await links.verify(undefined, {})).reason).toBe('missing');
    expect((await links.verify('eyJhbGciOi.x.y', {})).reason).toBe('malformed');
  });
});

describe('serialising', () => {
  const message = () => ({
    _id: 'm1',
    fileUrl: '/private/abc.jpg',
    fileThumb: 'data:thumb',
    replyTo: { _id: 'm0', fileUrl: '/private/old.jpg', fileThumb: 'data:old', deletedAt: new Date() }
  });

  test('a BROADCAST carries the path only — never a pass signed for someone', () => {
    const { links } = setup();
    const out = serializeForBroadcast(message(), { links, kind: 'messages', clearWhenDeleted: ['fileThumb'] });
    expect(out.fileUrl).toBe('/api/files/messages/m1');
    expect(out.fileUrl).not.toMatch(/ticket/);
  });

  test('a deleted item loses its address AND its preview, at every depth (quoted message included)', () => {
    const { links } = setup();
    const out = serializeForBroadcast(message(), { links, kind: 'messages', clearWhenDeleted: ['fileThumb'] });
    expect(out.replyTo.fileUrl).toBeNull();
    expect(out.replyTo.fileThumb).toBeNull();
    expect(out.fileThumb).toBe('data:thumb');
  });

  test('a response to ONE reader carries that reader\'s own pass', async () => {
    const { links } = setup();
    const out = serializeForReader(message(), { links, reader: BOB, kind: 'messages' });
    const check = await links.verify(ticketOf(out.fileUrl), { kind: 'messages', fileId: 'm1' });
    expect(check).toMatchObject({ valid: true, accountId: 'bob' });
  });
});

describe('stored files', () => {
  const root = path.join(path.sep, 'srv', 'private');

  test('a bare name resolves under the root', () => {
    expect(resolveStoredFile(root, 'a1b2.jpg')).toBe(path.join(root, 'a1b2.jpg'));
  });

  test.each(['..', '.', '../secret', '..\\secret', 'a/b.jpg', 'a\0.jpg', '', '/etc/passwd'])(
    'DIRECTORY TRAVERSAL: %j is refused',
    (name) => {
      expect(resolveStoredFile(root, name)).toBeNull();
    }
  );

  test('media is inline, everything else downloads; the sandbox is always on', () => {
    expect(privateFileHeaders({ mime: 'image/png', fileName: 'a.png' })['Content-Disposition']).toMatch(/^inline/);
    const html = privateFileHeaders({ mime: 'text/html', fileName: 'x.html' });
    expect(html['Content-Disposition']).toMatch(/^attachment/);
    expect(html['Content-Security-Policy']).toContain('sandbox');
    expect(html['X-Content-Type-Options']).toBe('nosniff');
  });
});

describe('the route', () => {
  function harness() {
    const { links } = setup();
    const files = new Map([[FILE, { id: FILE, owner: 'alice', sharedWith: ['bob'] }]]);
    const sent = [];
    const handler = createPrivateFileHandler({
      links,
      authenticate: (req, res, next) => {
        const who = req.headers?.authorization;
        if (!who) return res.status(401).json({ success: false, code: 'AUTH' });
        req.user = who === 'alice' ? ALICE : who === 'bob' ? BOB : { id: who, version: 0 };
        return next();
      },
      loadFile: async (_kind, id) => files.get(id) || null,
      canRead: async (reader, _kind, file) => file.owner === reader.id || file.sharedWith.includes(reader.id),
      loadReader: async (id) => (id === 'alice' ? ALICE : id === 'bob' ? BOB : null),
      send: async (file, req, res) => { sent.push({ file: file.id, reader: req.user.id }); res.status(200).json({ ok: true }); }
    });
    const call = async ({ id = FILE, query = {}, auth } = {}) => {
      const req = { params: { kind: 'messages', id }, query, headers: auth ? { authorization: auth } : {} };
      const res = {
        statusCode: 200, body: null, headers: {},
        setHeader(name, value) { this.headers[name] = value; },
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
      };
      await handler(req, res, (error) => { throw error; });
      return res;
    };
    return { links, call, sent };
  }

  test('link=1 answers the CALLER\'s own link, and needs a session', async () => {
    const { call, links } = harness();
    const res = await call({ query: { link: '1' }, auth: 'bob' });
    expect(res.statusCode).toBe(200);
    const check = await links.verify(ticketOf(res.body.data.fileUrl), { kind: 'messages', fileId: FILE });
    expect(check.accountId).toBe('bob');
    expect((await call({ query: { link: '1' } })).statusCode).toBe(401);
  });

  test('a pass never mints another pass', async () => {
    const { call, links } = harness();
    const ticket = links.sign({ kind: 'messages', fileId: FILE, accountId: 'bob', version: 0 }).ticket;
    const res = await call({ query: { link: '1', ticket } });
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('AUTH');
  });

  test('a valid pass serves the file AS its reader', async () => {
    const { call, links, sent } = harness();
    const ticket = links.sign({ kind: 'messages', fileId: FILE, accountId: 'bob', version: 0 }).ticket;
    expect((await call({ query: { ticket } })).statusCode).toBe(200);
    expect(sent).toEqual([{ file: FILE, reader: 'bob' }]);
  });

  test('ANOTHER ACCOUNT: a stranger with a session gets the same 404 as a missing file', async () => {
    const { call } = harness();
    const stranger = await call({ auth: 'mallory' });
    const missing = await call({ id: 'nothing000000', auth: 'alice' });
    expect(stranger.statusCode).toBe(404);
    expect(stranger.body).toEqual(missing.body);
  });

  test('a bad pass is a 401 with a code and no words', async () => {
    const { call } = harness();
    const res = await call({ query: { ticket: 'ab.cd' } });
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ success: false, code: 'FILE_LINK_INVALID' });
  });
});
