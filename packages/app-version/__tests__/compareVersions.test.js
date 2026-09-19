const { compareVersions, isBehind, isValidStoreLink, parseVersion } = require('../src');

describe('compareVersions', () => {
  test('number by number, never as text', () => {
    expect(compareVersions('1.10.0', '1.9.3')).toBe(1);
    expect(compareVersions('1.9.3', '1.10.0')).toBe(-1);
    expect(compareVersions('2.0.0', '1.99.99')).toBe(1);
    expect(compareVersions('1.1.4', '1.1.4')).toBe(0);
    /* Missing parts are zero; a leading "v" and spaces do not count. */
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions(' v1.2.0 ', '1.2.0')).toBe(0);
    expect(compareVersions('1.2.0.1', '1.2.0')).toBe(1);
  });

  test('prereleases rank before the release; build metadata is ignored', () => {
    expect(compareVersions('1.2.0-beta', '1.2.0')).toBe(-1);
    expect(compareVersions('1.2.0', '1.2.0-rc.1')).toBe(1);
    expect(compareVersions('1.2.0-beta.10', '1.2.0-beta.9')).toBe(1);
    expect(compareVersions('1.2.0-beta.2', '1.2.0-beta')).toBe(1);
    expect(compareVersions('1.2.0-1', '1.2.0-alpha')).toBe(-1);
    expect(compareVersions('1.2.0-alpha', '1.2.0-beta')).toBe(-1);
    expect(compareVersions('1.2.0+45', '1.2.0+12')).toBe(0);
    expect(compareVersions('1.2.1-beta', '1.2.0')).toBe(1);
  });

  test('an unreadable version does not compare', () => {
    for (const unreadable of [null, undefined, '', 'abc', '1..2', '1.2.x', '1.2.3.4.5', 12, '1.2.3 beta', '-1.0.0']) {
      expect(compareVersions(unreadable, '1.0.0')).toBeNull();
      expect(compareVersions('1.0.0', unreadable)).toBeNull();
    }
    expect(parseVersion('99999999999999999999.0.0')).toBeNull();
  });
});

describe('isBehind (server side)', () => {
  test('a missing version counts as behind, an unreadable one does not', () => {
    expect(isBehind(undefined, '1.2.0')).toBe(true);
    expect(isBehind(null, '1.2.0')).toBe(true);
    expect(isBehind('', '1.2.0')).toBe(true);
    expect(isBehind('1.1.4', '1.2.0')).toBe(true);
    expect(isBehind('1.2.0', '1.2.0')).toBe(false);
    expect(isBehind('1.3.0', '1.2.0')).toBe(false);
    expect(isBehind('n/a', '1.2.0')).toBe(false);
    /* A broken `latest` notifies nobody. */
    expect(isBehind(undefined, 'oops')).toBe(false);
    expect(isBehind('1.0.0', 'oops')).toBe(false);
  });
});

describe('isValidStoreLink', () => {
  test('store https pages and native schemes only', () => {
    expect(isValidStoreLink('https://apps.apple.com/app/id123')).toBe(true);
    expect(isValidStoreLink('itms-apps://apps.apple.com/app/id123')).toBe(true);
    expect(isValidStoreLink('market://details?id=com.acme')).toBe(true);
    for (const refused of [null, '', 'https://', 'http://x.test', 'ftp://x.test', 'https://a b', 'javascript:alert(1)', 42]) {
      expect(isValidStoreLink(refused)).toBe(false);
    }
  });
});
