const { readSpaces, coverageOf, missingKeys, firstSpaceToOpen, unlockState, cleanUnlockCode } = require('../src');

const payload = {
  spaces: [
    {
      id: 'providers',
      label: 'Fournisseurs',
      hint: 'Ce qui cesse de marcher sans elles.',
      keys: [
        { key: 'A', label: 'Clé A', configured: true, source: 'interface', preview: '••1234' },
        { key: 'B', configured: false, source: 'absente' }
      ]
    },
    {
      id: 'mail',
      label: 'Courrier',
      keys: [
        { key: 'C', configured: false },
        { key: 'D', configured: false },
        { key: 'E', configured: true, source: 'serveur' }
      ]
    }
  ]
};

describe('readSpaces', () => {
  test('reads the server answer without trusting its shape', () => {
    expect(readSpaces(null)).toEqual([]);
    expect(readSpaces({})).toEqual([]);
    expect(readSpaces({ spaces: 'nope' })).toEqual([]);
    expect(readSpaces({ spaces: [null] })).toEqual([{ id: '', label: '', hint: '', keys: [] }]);
  });

  test('a key with no label falls back to its own name', () => {
    const [space] = readSpaces({ spaces: [{ id: 's', keys: [{ key: 'STRIPE_KEY' }] }] });

    expect(space.keys[0].label).toBe('STRIPE_KEY');
  });

  test('doubt favours the secret: an unlabelled key is masked', () => {
    const [space] = readSpaces({ spaces: [{ id: 's', keys: [{ key: 'A' }, { key: 'B', secret: false }] }] });

    expect(space.keys[0].secret).toBe(true);
    expect(space.keys[1].secret).toBe(false);
  });

  test('an unknown source reads as absent rather than being passed through', () => {
    const [space] = readSpaces({ spaces: [{ id: 's', keys: [{ key: 'A', source: 'martian' }] }] });

    expect(space.keys[0].source).toBe('absente');
  });

  test('configured and readOnly are true only when stated', () => {
    const [space] = readSpaces({ spaces: [{ id: 's', keys: [{ key: 'A', configured: 'yes', readOnly: 1 }] }] });

    expect(space.keys[0].configured).toBe(false);
    expect(space.keys[0].readOnly).toBe(false);
  });
});

describe('coverageOf', () => {
  test('counts what is in place against the total', () => {
    const spaces = readSpaces(payload);

    expect(coverageOf(spaces[0])).toEqual({ done: 1, total: 2 });
    expect(coverageOf(null)).toEqual({ done: 0, total: 0 });
  });
});

describe('missingKeys', () => {
  test('lists what is left to set, across every space, named by space', () => {
    const missing = missingKeys(readSpaces(payload));

    expect(missing.map((entry) => entry.key)).toEqual(['B', 'C', 'D']);
    expect(missing[0].space).toBe('Fournisseurs');
  });

  test('a key deliberately unplugged still counts as missing — the screen must show it', () => {
    const spaces = readSpaces({ spaces: [{ id: 's', label: 'S', keys: [{ key: 'A', configured: false, source: 'retiree' }] }] });

    expect(missingKeys(spaces)).toHaveLength(1);
  });
});

describe('firstSpaceToOpen', () => {
  test('the space with the most left to do', () => {
    expect(firstSpaceToOpen(readSpaces(payload))).toBe('mail');
  });

  test('a tie keeps the catalogue order — that order means something', () => {
    const spaces = readSpaces({
      spaces: [{ id: 'a', keys: [{ key: 'x' }] }, { id: 'b', keys: [{ key: 'y' }] }]
    });

    expect(firstSpaceToOpen(spaces)).toBe('a');
  });

  test('nothing to open', () => {
    expect(firstSpaceToOpen([])).toBeNull();
  });
});

describe('unlockState', () => {
  const now = Date.parse('2026-08-26T10:00:00.000Z');

  test('an open window reports the minutes left, rounded up', () => {
    expect(unlockState({ unlockedUntil: '2026-08-26T10:04:10.000Z' }, now)).toEqual({ unlocked: true, minutesLeft: 5 });
  });

  test('the window is judged when it is READ, never when it arrived', () => {
    expect(unlockState({ unlockedUntil: '2026-08-26T09:59:00.000Z' }, now)).toEqual({ unlocked: false, minutesLeft: 0 });
  });

  test('a window about to close still reads as one minute, never zero', () => {
    expect(unlockState({ unlockedUntil: '2026-08-26T10:00:01.000Z' }, now)).toEqual({ unlocked: true, minutesLeft: 1 });
  });

  test('nothing, or nonsense, is closed', () => {
    expect(unlockState(null, now).unlocked).toBe(false);
    expect(unlockState({ unlockedUntil: 'soon' }, now).unlocked).toBe(false);
  });
});

describe('cleanUnlockCode', () => {
  test('six digits, nothing else — what is pasted from an e-mail rarely is', () => {
    expect(cleanUnlockCode(' 12 34-56 ')).toBe('123456');
    expect(cleanUnlockCode('code: 9876543')).toBe('987654');
    expect(cleanUnlockCode(null)).toBe('');
  });

  test('the length is configurable, because not every code is six long', () => {
    expect(cleanUnlockCode('123456789', 4)).toBe('1234');
  });
});

describe('the sources the vault actually sends', () => {
  test('environment, disconnected and absent read as the screen names them', () => {
    const [space] = readSpaces({ spaces: [{ id: 's', keys: [
      { key: 'A', source: 'environment' }, { key: 'B', source: 'disconnected' }, { key: 'C', source: 'absent' }, { key: 'D', source: 'interface' }
    ] }] });
    expect(space.keys.map((entry) => entry.source)).toEqual(['serveur', 'retiree', 'absente', 'interface']);
  });
});

describe('readBalance', () => {
  const { readBalance, balanceAlerts } = require('../src');

  test('a readable balance keeps its number and status', () => {
    expect(readBalance({ status: 'low', critical: true, balance: 150, rateLimit: 5, unit: 'credits', renewable: false })).toMatchObject({
      status: 'low', critical: true, balance: 150, rateLimit: 5, unit: 'credits', renewable: false
    });
  });

  test('a status that claims a number without carrying one reads as unreadable — never a guessed figure', () => {
    expect(readBalance({ status: 'ok', balance: '2449' })).toMatchObject({ status: 'error', balance: null, critical: false });
    expect(readBalance({ status: 'martian', balance: 3 }).status).toBe('error');
    expect(readBalance('nope').status).toBe('error');
  });

  test('absent stays absent, and an unknown or failed reading carries no number', () => {
    expect(readBalance(undefined)).toBeUndefined();
    expect(readBalance({ status: 'unknown', balance: 12 }).balance).toBeNull();
    expect(readBalance({ status: 'error', code: 'timeout' })).toMatchObject({ status: 'error', code: 'timeout' });
  });

  test('readSpaces reads the balance field only where the server sent one', () => {
    const [space] = readSpaces({ spaces: [{ id: 's', keys: [{ key: 'A', balance: { status: 'ok', balance: 9 } }, { key: 'B' }] }] });
    expect(space.keys[0].balance).toMatchObject({ status: 'ok', balance: 9 });
    expect('balance' in space.keys[1]).toBe(false);
  });

  test('alerts come most urgent first, and a failed reading is one of them', () => {
    const spaces = readSpaces({ spaces: [{ id: 's', label: 'Web', keys: [
      { key: 'FINE', balance: { status: 'ok', balance: 5000 } },
      { key: 'BROKEN', balance: { status: 'error', code: 'rejected' } },
      { key: 'LOW', balance: { status: 'low', balance: 500 } },
      { key: 'GONE', balance: { status: 'empty', balance: 0 } },
      { key: 'CRIT', balance: { status: 'low', critical: true, balance: 100 } },
      { key: 'NONE', balance: { status: 'unknown' } }
    ] }] });
    expect(balanceAlerts(spaces).map((alert) => alert.key)).toEqual(['GONE', 'CRIT', 'LOW', 'BROKEN']);
    expect(balanceAlerts(spaces)[0].space).toBe('Web');
    expect(balanceAlerts(null)).toEqual([]);
  });
});
