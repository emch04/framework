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
