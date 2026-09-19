const {
  assertRoleReadOnly,
  auditRoleWriteSource,
  auditRoleWrites
} = require('../src/guards/roleWrites');
const { createTempProject, writeFile } = require('./helpers');

const ROLE = 'ROLES.SUPPORT';
const audit = (source, extra = {}) => auditRoleWriteSource(source, { role: ROLE, ...extra });

describe('auditRoleWriteSource — direct role lists', () => {
  test('flags a write route that names the role, not the read next to it', () => {
    const findings = audit(`
      router.get('/items', auth, authorizeRoles(ROLES.ADMIN, ROLES.SUPPORT), list);
      router.post('/items', auth, authorizeRoles(ROLES.ADMIN, ROLES.SUPPORT), create);
    `);
    expect(findings).toEqual([expect.objectContaining({ kind: 'route', method: 'POST', route: '/items', line: 3, via: [] })]);
  });

  test('covers put, patch, delete, app.* and named routers', () => {
    const findings = audit(`
      app.put('/a', authorizeRoles(ROLES.SUPPORT), h);
      adminRouter.patch('/b', authorizeRoles(ROLES.SUPPORT), h);
      router.delete('/c', authorizeRoles(ROLES.SUPPORT), h);
      router.route('/d').post(authorizeRoles(ROLES.SUPPORT), h);
    `);
    expect(findings.map((f) => `${f.method} ${f.route}`)).toEqual(['PUT /a', 'PATCH /b', 'DELETE /c', 'POST /d']);
  });

  test('reads a declaration spread over several lines, to its closing parenthesis', () => {
    const findings = audit(`
      router.post(
        '/multi',
        auth,
        authorizeRoles(
          ROLES.ADMIN,
          ROLES.SUPPORT
        ),
        handler
      );
      router.post('/after', auth, authorizeRoles(ROLES.ADMIN), handler);
    `);
    expect(findings.map((f) => f.route)).toEqual(['/multi']);
  });

  test('a longer role name sharing the prefix is another role', () => {
    expect(audit(`router.post('/x', authorizeRoles(ROLES.SUPPORT_LEAD), h);`)).toEqual([]);
  });

  test('the role inside a comment does not authorise anything', () => {
    expect(audit(`
      // ROLES.SUPPORT used to be here
      router.post('/x', /* not ROLES.SUPPORT */ authorizeRoles(ROLES.ADMIN), h);
    `)).toEqual([]);
  });

  test('a parenthesis inside a string does not end the call early', () => {
    const findings = audit(`router.post('/x)', authorizeRoles(ROLES.SUPPORT), h);`);
    expect(findings).toHaveLength(1);
  });

  test('an escaped quote does not end the string (nor swallow the next comment)', () => {
    expect(audit(`router.post('/it\\'s', h); // ROLES.SUPPORT once could\n`)).toEqual([]);
  });

  test('a guard that refuses the role inline is not a grant', () => {
    expect(audit(`router.post('/x', allow((user) => user.role !== ROLES.SUPPORT), h);`)).toEqual([]);
    expect(audit(`router.post('/x', allow((user) => ROLES.SUPPORT != user.role), h);`)).toEqual([]);
  });

  test('accepts several spellings of the same role', () => {
    const findings = auditRoleWriteSource(`router.post('/x', requireRole('support'), h);`, { role: [ROLE, "'support'"] });
    expect(findings).toHaveLength(1);
  });
});

describe('auditRoleWriteSource — lists declared in the same file', () => {
  test('follows a spread list to its declaration and names the chain', () => {
    const findings = audit(`
      const STAFF = [ROLES.ADMIN, ROLES.SUPPORT];
      const DOERS = [...STAFF];
      router.post('/x', authorizeRoles(...DOERS), h);
    `);
    const route = findings.find((f) => f.kind === 'route');
    expect(route.via).toEqual(['DOERS', 'STAFF']);
  });

  test('a list filtered to drop the role is read as a list without it', () => {
    expect(audit(`
      const STAFF = [ROLES.ADMIN, ROLES.SUPPORT];
      const DECIDERS = STAFF.filter((role) => role !== ROLES.SUPPORT);
      router.get('/alerts', authorizeRoles(...STAFF), list);
      router.post('/scan', authorizeRoles(...DECIDERS), scan);
      router.post('/run', authorizeRoles(...STAFF.filter((r) => r !== ROLES.SUPPORT)), run);
    `)).toEqual([]);
  });

  test('filtering ANOTHER role out does not hide this one', () => {
    const findings = audit(`
      const STAFF = [ROLES.ADMIN, ROLES.SUPPORT, ROLES.GUEST];
      router.post('/x', authorizeRoles(...STAFF.filter((r) => r !== ROLES.GUEST)), h);
    `);
    expect(findings.map((f) => f.route)).toEqual(['/x']);
  });

  test('except(list, role) is an exclusion', () => {
    expect(audit(`
      const STAFF = [ROLES.ADMIN, ROLES.SUPPORT];
      router.post('/x', authorizeRoles(...except(STAFF, ROLES.SUPPORT)), h);
    `)).toEqual([]);
  });

  test('ROLES.ADMIN names one role, not the whole ROLES object', () => {
    expect(audit(`
      const ROLES = { ADMIN: 'admin', SUPPORT: 'support' };
      router.post('/x', authorizeRoles(ROLES.ADMIN), h);
    `, { role: "'support'" })).toEqual([]);
  });

  test('flags a controller writer list that includes the role', () => {
    const findings = audit(`
      const writers = [ROLES.TEACHER, ROLES.SUPPORT];
      const readers = [ROLES.TEACHER, ROLES.SUPPORT];
      if (!writers.includes(user.role)) throw forbidden();
    `);
    expect(findings).toEqual([expect.objectContaining({ kind: 'list', name: 'writers', line: 2 })]);
  });

  test('authorListNames: false turns the list check off; a custom name pattern is honoured', () => {
    const source = `const auteurs = [ROLES.SUPPORT];\nconst writers = [ROLES.SUPPORT];`;
    expect(audit(source, { authorListNames: false })).toEqual([]);
    expect(audit(source, { authorListNames: /^auteurs$/ }).map((f) => f.name)).toEqual(['auteurs']);
  });
});

describe('auditRoleWrites over a tree', () => {
  function project() {
    const rootDir = createTempProject();
    writeFile(rootDir, 'src/items/items.routes.js', `
      router.get('/items', authorizeRoles(ROLES.ADMIN, ROLES.SUPPORT), list);
      router.patch('/:id/activate', authorizeRoles(ROLES.ADMIN, ROLES.SUPPORT), activate);
      router.delete('/:id', authorizeRoles(ROLES.ADMIN, ROLES.SUPPORT), remove);
    `);
    writeFile(rootDir, 'src/items/items.test.js', `router.post('/t', authorizeRoles(ROLES.SUPPORT), h);`);
    writeFile(rootDir, 'src/node_modules/x/index.js', `router.post('/t', authorizeRoles(ROLES.SUPPORT), h);`);
    return rootDir;
  }

  test('reports what remains, keeps justified exceptions apart, skips tests and node_modules', () => {
    const rootDir = project();
    const result = auditRoleWrites({
      rootDir,
      dirs: ['src'],
      role: ROLE,
      exceptions: [{ match: "'/:id/activate'", reason: 'activating an account is platform administration' }]
    });

    expect(result.fileCount).toBe(1);
    expect(result.findings).toEqual([expect.objectContaining({ file: 'src/items/items.routes.js', method: 'DELETE', route: '/:id' })]);
    expect(result.exempted).toEqual([expect.objectContaining({ route: '/:id/activate', reason: expect.stringMatching(/platform/) })]);
    expect(result.unusedExceptions).toEqual([]);
  });

  test('an exception can be limited to one file', () => {
    const rootDir = project();
    const result = auditRoleWrites({
      rootDir,
      dirs: ['src'],
      role: ROLE,
      exceptions: [{ file: 'other.routes.js', match: "'/:id'", reason: 'belongs elsewhere' }]
    });
    expect(result.findings).toHaveLength(2);
    expect(result.unusedExceptions).toHaveLength(1);
  });

  test('an exception without a reason is refused', () => {
    expect(() => auditRoleWrites({ dirs: ['src'], role: ROLE, exceptions: [{ match: '/x' }] })).toThrow(/reason/);
    expect(() => auditRoleWrites({ dirs: ['src'], role: ROLE, exceptions: [{ match: '/x', reason: '  ' }] })).toThrow(/reason/);
  });

  test('requires a role and directories', () => {
    expect(() => auditRoleWrites({ dirs: ['src'] })).toThrow(/role/);
    expect(() => auditRoleWrites({ role: ROLE })).toThrow(/dirs/);
  });

  test('assertRoleReadOnly throws on a remaining write and on a stale exception', () => {
    const rootDir = project();
    const exceptions = [
      { match: "'/:id/activate'", reason: 'platform administration' },
      { match: "'/:id'", reason: 'deleting is support work (decided)' }
    ];
    expect(assertRoleReadOnly({ rootDir, dirs: ['src'], role: ROLE, exceptions }).exempted).toHaveLength(2);

    expect(() => assertRoleReadOnly({ rootDir, dirs: ['src'], role: ROLE, exceptions: exceptions.slice(0, 1) }))
      .toThrow(/DELETE \/:id/);
    expect(() => assertRoleReadOnly({ rootDir, dirs: ['src'], role: ROLE, exceptions: [...exceptions, { match: '/gone', reason: 'old' }] }))
      .toThrow(/unused exception \/gone/);
  });
});

describe('auditRoleWriteSource — what is not a role list', () => {
  test('a handler declared in the file is not followed, even if it mentions the role', () => {
    expect(audit(`
      const handler = async (req, res) => {
        if (req.user.role === ROLES.SUPPORT) return res.status(403).end();
      };
      const other = function (req) { return [ROLES.SUPPORT]; };
      router.post('/x', authorizeRoles(ROLES.ADMIN), handler, other);
    `)).toEqual([]);
  });

  test('a list named like a manager list but used for reads is not reported', () => {
    expect(audit(`
      const MANAGERS = [ROLES.ADMIN, ROLES.SUPPORT];
      router.get('/', authorizeRoles(...MANAGERS), list);
    `)).toEqual([]);
  });
});
