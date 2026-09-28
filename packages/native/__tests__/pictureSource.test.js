const {
  PICTURE_DATA_MAX_BYTES,
  PictureSourceError,
  parseHttpAddress,
  originOf,
  isSameOrigin,
  readDataAddress,
  dataPayloadBase64,
  decodeBase64,
  encodeBase64,
  sniffPictureType,
  pictureFileName,
  pictureUti,
  createPictureSources,
  createPictureFiles
} = require('../src');

const APP = 'https://app.example.com';
const TOKEN = 'secret-token';
const sources = (extra = {}) => createPictureSources({ appUrl: APP, getToken: async () => TOKEN, ...extra });

/* A picture's first bytes, base64. */
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52];
const JPEG_HEAD = [0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1];
const PNG_DATA = `data:image/png;base64,${encodeBase64(PNG_HEAD)}`;

describe('parseHttpAddress — strict, never repaired', () => {
  test('scheme and host lower-cased, default port dropped, path kept', () => {
    expect(parseHttpAddress('HTTPS://App.Example.COM:443/Images/A?x=1#f')).toEqual({
      scheme: 'https',
      host: 'app.example.com',
      port: null,
      origin: 'https://app.example.com',
      path: '/Images/A?x=1#f'
    });
    expect(parseHttpAddress('http://localhost:80').origin).toBe('http://localhost');
    expect(parseHttpAddress('http://localhost:3000').origin).toBe('http://localhost:3000');
    expect(parseHttpAddress('https://app.example.com:0443/').origin).toBe('https://app.example.com');
    expect(parseHttpAddress('https://app.example.com').path).toBe('');
    expect(parseHttpAddress('https://app.example.com?q').path).toBe('?q');
  });

  test('IPv6 hosts in brackets, with and without a port', () => {
    expect(parseHttpAddress('http://[::1]:3000/a').origin).toBe('http://[::1]:3000');
    expect(parseHttpAddress('https://[2001:DB8::1]/').host).toBe('[2001:db8::1]');
    expect(parseHttpAddress('https://[::1')).toBeNull();
    expect(parseHttpAddress('https://[::1]x/')).toBeNull();
    expect(parseHttpAddress('https://[evil.com]/')).toBeNull();
  });

  test.each([
    ['credentials: the real host is after the @', 'https://app.example.com@evil.com/a'],
    ['credentials with a password', 'https://user:pass@app.example.com/a'],
    ['backslash, read as a slash by browsers', 'https://evil.com\\@app.example.com/'],
    ['a tab the WHATWG parser would strip', 'https://app.example.com\t.evil.com/'],
    ['a newline', 'https://app.example.com\n.evil.com/'],
    ['a space', 'https://app .example.com/'],
    ['a percent-encoded host', 'https://app%2eexample.com/'],
    ['a non-ASCII look-alike', 'https://аpp.example.com/'],
    ['an empty host', 'https:///a'],
    ['a port too large', 'https://app.example.com:65536/'],
    ['a port that is not a number', 'https://app.example.com:44x/'],
    ['an empty-label host', 'https://app..example.com/'],
    ['a leading dot', 'https://.example.com/'],
    ['another scheme', 'ftp://app.example.com/'],
    ['no slashes', 'https:app.example.com/'],
    ['not a string', 42],
    ['empty', '']
  ])('refused: %s', (_why, address) => {
    expect(parseHttpAddress(address)).toBeNull();
  });

  test('refused past the length limit', () => {
    expect(parseHttpAddress(`https://app.example.com/${'a'.repeat(9000)}`)).toBeNull();
  });
});

describe('isSameOrigin — whole comparison, never a substring', () => {
  test('the same origin, however it is written', () => {
    expect(isSameOrigin('https://APP.example.com/a', 'https://app.example.com:443/b')).toBe(true);
    expect(isSameOrigin('http://localhost:3000/x', 'http://localhost:3000')).toBe(true);
  });

  test.each([
    ['a longer host ending the same', 'https://app.example.com.evil.com/x'],
    ['the app in the query of another host', 'https://evil.com/?u=app.example.com'],
    ['the app in the path of another host', 'https://evil.com/app.example.com'],
    ['a sub-domain of the app', 'https://cdn.app.example.com/x'],
    ['a trailing dot', 'https://app.example.com./x'],
    ['another port', 'https://app.example.com:8443/x'],
    ['another scheme', 'http://app.example.com/x'],
    ['credentials', 'https://app.example.com@evil.com/x'],
    ['a prefix of the host', 'https://app.example.co/x']
  ])('different: %s', (_why, address) => {
    expect(isSameOrigin(address, APP)).toBe(false);
  });

  test('two addresses that do not parse share nothing', () => {
    expect(isSameOrigin('nope', 'nope')).toBe(false);
    expect(originOf('javascript:alert(1)')).toBeNull();
  });
});

describe('createPictureSources — classify', () => {
  const pictures = sources();

  test('a path of the app is the app\'s, joined to the whole base', () => {
    expect(pictures.classify('/images/abc')).toEqual({ kind: 'app', url: 'https://app.example.com/images/abc' });
    const api = createPictureSources({ appUrl: 'https://app.example.com/api/' });
    expect(api.classify('/images/abc')).toEqual({ kind: 'app', url: 'https://app.example.com/api/images/abc' });
    expect(api.classify('/images/abc').url).not.toContain('//images');
  });

  test('the app\'s own origin written in full is the app\'s, whatever its case or default port', () => {
    expect(pictures.classify('HTTPS://APP.EXAMPLE.COM:443/images/a')).toEqual({ kind: 'app', url: 'https://app.example.com/images/a' });
  });

  test('another https host is outside', () => {
    expect(pictures.classify('https://wol.example.org/fig1.jpg')).toEqual({ kind: 'outside', url: 'https://wol.example.org/fig1.jpg' });
  });

  test.each([
    ['https://app.example.com.evil.com/x', 'outside'],
    ['https://evil.com/?u=app.example.com', 'outside'],
    ['https://app.example.com:8443/x', 'outside'],
    ['https://cdn.app.example.com/x', 'outside'],
    ['https://app.example.com./x', 'outside']
  ])('spoofed %s is %s — never the app', (address, kind) => {
    expect(pictures.classify(address).kind).toBe(kind);
  });

  test.each([
    ['https://app.example.com@evil.com/x', 'userinfo'],
    ['https://user:pw@evil.com/x', 'userinfo'],
    ['//evil.com/x', 'relative'],
    ['.evil.com/x', 'relative'],
    ['@evil.com/x', 'relative'],
    ['images/abc', 'relative'],
    ['javascript:alert(1)', 'scheme'],
    ['file:///etc/passwd', 'scheme'],
    ['https:evil.com', 'relative'],
    ['http://example.org/a.jpg', 'insecure'],
    ['https://evil.com\\@app.example.com/', 'unsafe_characters'],
    ['/images/a\\..\\b', 'unsafe_characters'],
    ['/images/a\nb', 'unsafe_characters'],
    ['https://app%2eexample.com/', 'host'],
    ['', 'empty'],
    ['   ', 'empty']
  ])('refused %j (%s)', (address, reason) => {
    expect(pictures.classify(address)).toEqual({ kind: 'refused', reason });
  });

  test('refused when not a string', () => {
    expect(pictures.classify(null)).toEqual({ kind: 'refused', reason: 'empty' });
  });

  test('plain http outside only when the app allows it; the app\'s own http origin always', () => {
    expect(sources({ allowHttpOutside: true }).classify('http://example.org/a.jpg').kind).toBe('outside');
    const dev = createPictureSources({ appUrl: 'http://localhost:3000' });
    expect(dev.classify('/images/a')).toEqual({ kind: 'app', url: 'http://localhost:3000/images/a' });
    expect(dev.classify('http://localhost:3001/a').kind).toBe('refused');
  });

  test('an app URL that is not a clean absolute http(s) URL is refused at construction', () => {
    expect(() => createPictureSources({ appUrl: 'app.example.com' })).toThrow(/appUrl/);
    expect(() => createPictureSources({ appUrl: 'https://u@app.example.com' })).toThrow(/appUrl/);
    expect(() => createPictureSources({})).toThrow(/appUrl/);
  });

  test('refused past the length limit', () => {
    expect(pictures.classify(`/images/${'a'.repeat(9000)}`)).toEqual({ kind: 'refused', reason: 'too_long' });
  });
});

describe('inline pictures (data:)', () => {
  const pictures = sources();

  test('an accepted inline picture, its type and size', () => {
    expect(pictures.classify(PNG_DATA)).toEqual({ kind: 'data', url: PNG_DATA, mimeType: 'image/png', bytes: PNG_HEAD.length });
    expect(pictures.classify('DATA:IMAGE/JPEG;BASE64,/9j/').kind).toBe('data');
  });

  test('SVG, HTML and unknown types are refused by default', () => {
    expect(pictures.classify('data:image/svg+xml;base64,PHN2Zz4=')).toEqual({ kind: 'refused', reason: 'data_type' });
    expect(pictures.classify('data:text/html;base64,PHNjcmlwdD4=')).toEqual({ kind: 'refused', reason: 'data_type' });
    expect(sources({ dataTypes: ['image/svg+xml'] }).classify('data:image/svg+xml;base64,PHN2Zz4=').kind).toBe('data');
  });

  test.each([
    ['no comma', 'data:image/png;base64'],
    ['an empty payload', 'data:image/png;base64,'],
    ['a character outside base64', 'data:image/png;base64,ab$d'],
    ['a length that is not a multiple of 4', 'data:image/png;base64,abcde'],
    ['padding in the middle', 'data:image/png;base64,ab=dabcd'],
    ['three padding characters', 'data:image/png;base64,a==='],
    ['no type', 'data:;base64,abcd'],
    ['a control character in the header', 'data:image/png\n;base64,abcd']
  ])('malformed: %s', (_why, address) => {
    expect(readDataAddress(address)).toEqual({ ok: false, reason: 'data_malformed' });
  });

  test('a huge payload is refused from its length, before any scan', () => {
    const huge = `data:image/png;base64,${'A'.repeat(PICTURE_DATA_MAX_BYTES * 2)}`;
    const started = process.hrtime.bigint();
    expect(readDataAddress(huge)).toEqual({ ok: false, reason: 'data_too_large' });
    expect(pictures.classify(huge)).toEqual({ kind: 'refused', reason: 'data_too_large' });
    /* Constant time: far under a scan of 20 MB. */
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(50);
  });

  test('a header past 256 characters is not searched for (no scan of the payload for a comma)', () => {
    expect(readDataAddress(`data:image/png;${'x'.repeat(300)},AAAA`)).toEqual({ ok: false, reason: 'data_malformed' });
  });

  test('the size limit is the app\'s to set, exactly', () => {
    const address = `data:image/png;base64,${'AAAA'.repeat(3)}`; // 9 bytes
    expect(readDataAddress(address, { maxBytes: 9 }).ok).toBe(true);
    expect(readDataAddress(address, { maxBytes: 8 })).toEqual({ ok: false, reason: 'data_too_large' });
    expect(readDataAddress('data:image/png,%89PNG', { maxBytes: 3 })).toEqual({ ok: false, reason: 'data_too_large' });
  });

  test('padding is subtracted from the size', () => {
    expect(readDataAddress('data:image/png;base64,AA==').bytes).toBe(1);
    expect(readDataAddress('data:image/png;base64,AAA=').bytes).toBe(2);
  });

  test('a percent-encoded payload is decoded to bytes; a base64 one is handed back as is', () => {
    const encoded = 'data:image/png,%89PNG%0D%0A%1a%0a';
    const read = readDataAddress(encoded);
    expect(read).toMatchObject({ ok: true, base64: false });
    expect([...decodeBase64(dataPayloadBase64(encoded, read))]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const plain = readDataAddress(PNG_DATA);
    expect(dataPayloadBase64(PNG_DATA, plain)).toBe(encodeBase64(PNG_HEAD));
  });
});

describe('resolve — the token goes to the app\'s origin and nowhere else', () => {
  test('the app\'s picture carries the token', async () => {
    await expect(sources().resolve('/images/a')).resolves.toEqual({
      uri: 'https://app.example.com/images/a',
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
  });

  test.each([
    'https://wol.example.org/a.jpg',
    'https://app.example.com.evil.com/x',
    'https://evil.com/?u=app.example.com',
    'https://app.example.com:8443/x',
    'https://cdn.app.example.com/x',
    PNG_DATA
  ])('no header for %s', async (address) => {
    const source = await sources().resolve(address);
    expect(source).not.toBeNull();
    expect(source.headers).toBeUndefined();
    expect(JSON.stringify(source)).not.toContain(TOKEN);
  });

  test.each(['https://app.example.com@evil.com/x', '.evil.com/x', '@evil.com/x', '//evil.com/x', 'http://example.org/a.jpg'])(
    'nothing at all for %s',
    async (address) => {
      const getToken = jest.fn(async () => TOKEN);
      await expect(createPictureSources({ appUrl: APP, getToken }).resolve(address)).resolves.toBeNull();
      expect(getToken).not.toHaveBeenCalled();
    }
  );

  test('the token is read at each resolution, never kept', async () => {
    let token = 'first';
    const pictures = createPictureSources({ appUrl: APP, getToken: () => token });
    expect((await pictures.resolve('/a')).headers.Authorization).toBe('Bearer first');
    token = 'second';
    expect((await pictures.resolve('/a')).headers.Authorization).toBe('Bearer second');
  });

  test('signed out: the app\'s picture goes without headers', async () => {
    await expect(createPictureSources({ appUrl: APP, getToken: async () => null }).resolve('/a')).resolves.toEqual({
      uri: 'https://app.example.com/a'
    });
    await expect(createPictureSources({ appUrl: APP }).resolve('/a')).resolves.toEqual({ uri: 'https://app.example.com/a' });
  });

  test('the app chooses how a token is carried', async () => {
    const pictures = sources({ authorize: (token) => ({ 'X-Api-Key': token }) });
    expect((await pictures.resolve('/a')).headers).toEqual({ 'X-Api-Key': TOKEN });
  });

  test('a query is added to the app\'s addresses only, encoded, before the fragment', async () => {
    const pictures = sources();
    expect((await pictures.resolve('/images/a', { query: { original: 1 } })).uri).toBe('https://app.example.com/images/a?original=1');
    expect((await pictures.resolve('/images/a?w=2#top', { query: { original: 1, name: 'a b&c' } })).uri).toBe(
      'https://app.example.com/images/a?w=2&original=1&name=a%20b%26c#top'
    );
    expect((await pictures.resolve('/images/a', { query: { skipped: null } })).uri).toBe('https://app.example.com/images/a');
    expect((await pictures.resolve('https://cdn.example.org/a.jpg?sig=x', { query: { original: 1 } })).uri).toBe(
      'https://cdn.example.org/a.jpg?sig=x'
    );
  });

  test('headersFor compares the final address whole', async () => {
    const pictures = sources();
    await expect(pictures.headersFor('https://app.example.com/x')).resolves.toEqual({ Authorization: `Bearer ${TOKEN}` });
    await expect(pictures.headersFor('https://app.example.com.evil.com/x')).resolves.toEqual({});
    await expect(pictures.headersFor('https://app.example.com@evil.com/x')).resolves.toEqual({});
    await expect(pictures.headersFor('not an address')).resolves.toEqual({});
  });
});

describe('cacheKey', () => {
  const pictures = sources();

  test('file-name safe, and never the token', () => {
    const key = pictures.cacheKey('/images/a');
    expect(key).toMatch(/^[a-z0-9-]+$/);
    expect(key).not.toContain(TOKEN);
  });

  test('a path and the same address written in full share a key; case of the host does not matter', () => {
    expect(pictures.cacheKey('/images/a')).toBe(pictures.cacheKey('https://APP.example.com:443/images/a'));
  });

  test('the fragment does not change the picture; the query does', () => {
    expect(pictures.cacheKey('/images/a#x')).toBe(pictures.cacheKey('/images/a'));
    expect(pictures.cacheKey('/images/a?w=1')).not.toBe(pictures.cacheKey('/images/a'));
  });

  test('two renditions, two versions, two hosts: two keys', () => {
    expect(pictures.cacheKey('/a', { variant: 'original' })).not.toBe(pictures.cacheKey('/a', { variant: 'preview' }));
    expect(pictures.cacheKey('/a', { version: 1 })).not.toBe(pictures.cacheKey('/a', { version: 2 }));
    expect(pictures.cacheKey('https://one.example.org/a')).not.toBe(pictures.cacheKey('https://two.example.org/a'));
  });

  test('inline pictures are keyed by their whole content', () => {
    expect(pictures.cacheKey(PNG_DATA)).toBe(pictures.cacheKey(PNG_DATA));
    expect(pictures.cacheKey(PNG_DATA)).not.toBe(pictures.cacheKey(`data:image/png;base64,${encodeBase64(JPEG_HEAD)}`));
  });

  test('no collision across thousands of neighbouring addresses (the 32-bit hash it replaces had them)', () => {
    const seen = new Set();
    for (let i = 0; i < 20000; i += 1) seen.add(pictures.cacheKey(`https://cdn.example.org/pictures/${i}.jpg`));
    expect(seen.size).toBe(20000);
  });

  test('no key for a refused address', () => {
    expect(pictures.cacheKey('https://app.example.com@evil.com/x')).toBeNull();
  });
});

describe('bytes', () => {
  test('base64 round trip, every padding length', () => {
    for (const bytes of [[], [1], [1, 2], [1, 2, 3], [0, 255, 128, 7, 9]]) {
      expect([...decodeBase64(encodeBase64(bytes))]).toEqual(bytes);
    }
    expect(encodeBase64([0x4d, 0x61, 0x6e])).toBe('TWFu');
    expect(encodeBase64([0x4d])).toBe('TQ==');
    expect([...decodeBase64('TW\nFu')]).toEqual([0x4d, 0x61, 0x6e]);
    expect([...decodeBase64(null)]).toEqual([]);
  });

  test('the bytes say what a picture is', () => {
    expect(sniffPictureType(PNG_HEAD)).toEqual({ mimeType: 'image/png', extension: 'png' });
    expect(sniffPictureType(JPEG_HEAD)).toEqual({ mimeType: 'image/jpeg', extension: 'jpg' });
    expect(sniffPictureType([...Buffer.from('GIF89a')])).toEqual({ mimeType: 'image/gif', extension: 'gif' });
    expect(sniffPictureType([...Buffer.from('RIFF0000WEBPVP8 ')])?.extension).toBe('webp');
    expect(sniffPictureType([0, 0, 0, 24, ...Buffer.from('ftypheic')])?.extension).toBe('heic');
    expect(sniffPictureType([0, 0, 0, 24, ...Buffer.from('ftypavif')])?.extension).toBe('avif');
    expect(sniffPictureType([...Buffer.from('BM'), ...new Array(12).fill(0)])?.extension).toBe('bmp');
  });

  test('an error page, an empty file, a truncated header are not pictures', () => {
    expect(sniffPictureType([...Buffer.from('<!doctype html>')])).toBeNull();
    expect(sniffPictureType([])).toBeNull();
    expect(sniffPictureType([0x89, 0x50])).toBeNull();
    expect(sniffPictureType([0, 0, 0, 24, ...Buffer.from('ftypmp42')])).toBeNull();
    expect(sniffPictureType(null)).toBeNull();
  });
});

describe('pictureUti', () => {
  test('the share sheet is told what the file is, from its extension', () => {
    expect(pictureUti('file:///x/The ark.png')).toBe('public.png');
    expect(pictureUti('file:///x/a.JPG')).toBe('public.jpeg');
    expect(pictureUti('a.heic')).toBe('public.heic');
    expect(pictureUti('a.webp')).toBe('org.webmproject.webp');
    expect(pictureUti('a.gif')).toBe('com.compuserve.gif');
  });

  test('nothing is claimed for anything else', () => {
    expect(pictureUti('a.html')).toBeNull();
    expect(pictureUti('noextension')).toBeNull();
    expect(pictureUti('a.constructor')).toBeNull();
    expect(pictureUti(null)).toBeNull();
  });
});

describe('pictureFileName', () => {
  test('separators and reserved characters become spaces', () => {
    expect(pictureFileName('A/B\\C:D*E?F"G<H>I|J')).toBe('A B C D E F G H I J');
    expect(pictureFileName('line\nbreak\ttab')).toBe('line break tab');
  });

  test('no hidden file, no path', () => {
    expect(pictureFileName('../../etc/passwd')).toBe('etc passwd');
    expect(pictureFileName('.hidden')).toBe('hidden');
  });

  test('cut in characters, never inside an emoji or an accent', () => {
    const name = pictureFileName(`${'é'.repeat(59)}😀😀`);
    expect(Array.from(name)).toHaveLength(60);
    expect(name.endsWith('😀')).toBe(true);
    expect(pictureFileName('abcdef', { maxLength: 3 })).toBe('abc');
  });

  test('the fallback is the app\'s; with none, nothing', () => {
    expect(pictureFileName('  ', { fallback: 'Picture' })).toBe('Picture');
    expect(pictureFileName('///')).toBe('');
  });
});

/* An in-memory expo-file-system/legacy. */
function memoryFs({ responses = {} } = {}) {
  const files = new Map();
  const dirs = new Set();
  const calls = [];
  let clock = 1_800_000_000;
  const fs = {
    files,
    calls,
    async getInfoAsync(uri) {
      if (dirs.has(uri)) return { exists: true, isDirectory: true };
      const file = files.get(uri);
      return file ? { exists: true, isDirectory: false, size: file.bytes.length, modificationTime: file.at } : { exists: false };
    },
    async makeDirectoryAsync(uri) {
      dirs.add(uri);
    },
    async moveAsync({ from, to }) {
      const file = files.get(from);
      if (!file) throw new Error('missing');
      files.delete(from);
      files.set(to, file);
    },
    async copyAsync({ from, to }) {
      files.set(to, { ...files.get(from) });
    },
    async deleteAsync(uri) {
      files.delete(uri);
      for (const name of [...files.keys()]) if (uri.endsWith('/') && name.startsWith(uri)) files.delete(name);
      dirs.delete(uri);
    },
    async readDirectoryAsync(uri) {
      const names = new Set();
      for (const name of files.keys()) if (name.startsWith(uri)) names.add(name.slice(uri.length).split('/')[0]);
      for (const dir of dirs) if (dir !== uri && dir.startsWith(uri)) names.add(dir.slice(uri.length).split('/')[0] + '/');
      return [...names].map((name) => name.replace(/\/$/, ''));
    },
    async downloadAsync(uri, fileUri, options) {
      calls.push({ uri, fileUri, headers: options && options.headers });
      const response = responses[uri] || { status: 404, bytes: [...Buffer.from('<html>')] };
      files.set(fileUri, { bytes: response.bytes, at: (clock += 1) });
      return { status: response.status };
    },
    async readAsStringAsync(uri, { position = 0, length }) {
      const file = files.get(uri);
      return encodeBase64(file.bytes.slice(position, length === undefined ? undefined : position + length));
    },
    async writeAsStringAsync(uri, contents) {
      files.set(uri, { bytes: [...decodeBase64(contents)], at: (clock += 1) });
    }
  };
  return fs;
}

describe('createPictureFiles', () => {
  const DIR = 'file:///cache/pictures/';
  const setup = (responses) => {
    const fs = memoryFs({ responses });
    const files = createPictureFiles({ sources: sources(), fs, directory: DIR, now: () => 1000 });
    return { fs, files };
  };

  test('the app\'s original is downloaded with the token and the query, then kept', async () => {
    const { fs, files } = setup({ 'https://app.example.com/images/a?original=1': { status: 200, bytes: PNG_HEAD } });
    const uri = await files.original('/images/a', { query: { original: 1 } });
    expect(uri).toMatch(/^file:\/\/\/cache\/pictures\/[a-z0-9-]+\.png$/);
    expect(fs.calls).toEqual([
      expect.objectContaining({ uri: 'https://app.example.com/images/a?original=1', headers: { Authorization: `Bearer ${TOKEN}` } })
    ]);
    await expect(files.original('/images/a', { query: { original: 1 } })).resolves.toBe(uri);
    expect(fs.calls).toHaveLength(1);
  });

  test('an outside original is downloaded WITHOUT the token', async () => {
    const { fs, files } = setup({ 'https://wol.example.org/a.jpg': { status: 200, bytes: JPEG_HEAD } });
    expect(await files.original('https://wol.example.org/a.jpg', { query: { original: 1 } })).toMatch(/\.jpg$/);
    expect(fs.calls[0].headers).toBeUndefined();
    expect(fs.calls[0].uri).toBe('https://wol.example.org/a.jpg');
  });

  test('an inline picture is written out, without any download', async () => {
    const { fs, files } = setup();
    const uri = await files.original(PNG_DATA);
    expect(uri).toMatch(/\.png$/);
    expect(fs.calls).toHaveLength(0);
    expect(fs.files.get(uri).bytes).toEqual(PNG_HEAD);
  });

  test('an error answer, or a page that is not a picture, is never kept', async () => {
    const { fs, files } = setup({ 'https://wol.example.org/html': { status: 200, bytes: [...Buffer.from('<!doctype html>')] } });
    await expect(files.original('https://wol.example.org/missing')).rejects.toMatchObject({ code: 'http', status: 404 });
    await expect(files.original('https://wol.example.org/html')).rejects.toMatchObject({ code: 'not_a_picture' });
    expect([...fs.files.keys()]).toEqual([]);
  });

  test('a spoofed address is refused before any network', async () => {
    const { fs, files } = setup();
    const error = await files.original('https://app.example.com@evil.com/x').catch((e) => e);
    expect(error).toBeInstanceOf(PictureSourceError);
    expect(error).toMatchObject({ code: 'refused', reason: 'userinfo' });
    expect(fs.calls).toHaveLength(0);
  });

  test('a download cut halfway is never served afterwards (the source served any file in the folder)', async () => {
    const { fs, files } = setup({ 'https://wol.example.org/a.jpg': { status: 200, bytes: JPEG_HEAD } });
    const failing = { ...fs, downloadAsync: async (uri, fileUri) => {
      fs.files.set(fileUri, { bytes: [0xff], at: 1 });
      throw new Error('network lost');
    } };
    const broken = createPictureFiles({ sources: sources(), fs: failing, directory: DIR, now: () => 1000 });
    await expect(broken.original('https://wol.example.org/a.jpg')).rejects.toThrow('network lost');
    expect([...fs.files.keys()]).toEqual([]);
    expect(await files.original('https://wol.example.org/a.jpg')).toMatch(/\.jpg$/);
  });

  test('two calls at once share one download', async () => {
    const { fs, files } = setup({ 'https://wol.example.org/a.jpg': { status: 200, bytes: JPEG_HEAD } });
    const [a, b] = await Promise.all([files.original('https://wol.example.org/a.jpg'), files.original('https://wol.example.org/a.jpg')]);
    expect(a).toBe(b);
    expect(fs.calls).toHaveLength(1);
  });

  test('a named copy takes the title, only the latest is kept', async () => {
    const { fs, files } = setup({
      'https://wol.example.org/a.jpg': { status: 200, bytes: JPEG_HEAD },
      'https://wol.example.org/b.png': { status: 200, bytes: PNG_HEAD }
    });
    const first = await files.named('https://wol.example.org/a.jpg', 'The / ark');
    expect(first).toBe(`${DIR}shared/The ark.jpg`);
    const second = await files.named('https://wol.example.org/b.png', '', { fallback: 'Picture' });
    expect(second).toBe(`${DIR}shared/Picture.png`);
    expect(fs.files.has(first)).toBe(false);
    const third = await files.named('https://wol.example.org/b.png', '');
    expect(third).toMatch(/shared\/[a-z0-9-]+\.png$/);
  });

  test('required pieces', () => {
    expect(() => createPictureFiles({ fs: memoryFs(), directory: DIR })).toThrow(/sources/);
    expect(() => createPictureFiles({ sources: sources(), directory: DIR })).toThrow(/fs/);
  });
});
