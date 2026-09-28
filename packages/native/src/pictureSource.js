/**
 * Where a picture comes from, and who may learn the person's token on the way.
 *
 * An app shows three kinds of pictures:
 * - its OWN, served by its API behind the person's token ('/images/abc', or
 *   the same address written in full);
 * - OUTSIDE pictures — a publication, a web page, a CDN — loaded as they are;
 * - INLINE pictures (`data:image/...`), carried inside a document.
 *
 * The one rule that matters: the token goes to the app's own origin and to
 * nothing else. The first version of this rule was a prefix test
 * (`/^https:\/\//` means "outside"), and the app's own addresses were built by
 * gluing a path after the API's base URL. Both break on an address the app did
 * not write itself:
 *
 *   base 'https://api.example.com' + '.evil.com/x'   -> https://api.example.com.evil.com/x
 *   base 'https://api.example.com' + '@evil.com/x'   -> https://api.example.com@evil.com/x
 *
 * — two addresses that reach evil.com WITH the token. Here an address is
 * parsed, its origin compared whole (scheme, host, port), and anything that
 * does not parse cleanly is refused instead of guessed.
 *
 * WHY NOT `new URL()`: React Native's URL polyfill does not implement
 * `hostname` / `host` on every version (it throws "not implemented"), and the
 * WHATWG parser is lenient in exactly the ways an attacker uses — it strips
 * tabs and newlines anywhere, and reads a backslash as a slash. A strict,
 * small parser that refuses those inputs is safer than a lenient one that
 * repairs them.
 *
 * Pure: no network, no file system, no platform. `createPictureSources` takes
 * the token getter as an injected function; `createPictureFiles` below takes
 * the file system.
 */

const { contentKey, createMediaCache } = require('./mediaCache');

/** Longest http(s) address accepted. Browsers cap far higher; a picture address is short. */
const PICTURE_ADDRESS_MAX_LENGTH = 8192;

/** Largest inline picture accepted, in decoded bytes. */
const PICTURE_DATA_MAX_BYTES = 10 * 1024 * 1024;

/**
 * The inline types accepted by default. SVG is not among them: it is a
 * document, not a picture — it can carry scripts and external references — and
 * React Native's Image does not draw it anyway. An app that wants it lists it.
 */
const PICTURE_DATA_TYPES = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/avif',
  'image/bmp'
]);

/** Where a picture's extension comes from, by declared type. */
const PICTURE_EXTENSIONS = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heic',
  'image/avif': 'avif',
  'image/bmp': 'bmp'
});

const DEFAULT_PORTS = { http: 80, https: 443 };

/* How far into a data: address its header (type, parameters) may go. A
   picture's header is a few dozen characters; looking further would mean
   scanning megabytes of payload for a comma. */
const DATA_HEADER_MAX = 256;

class PictureSourceError extends Error {
  /**
   * @param {'refused'|'http'|'not_a_picture'} code  A code, never a sentence:
   *   the app words it in its own language.
   * @param {string} [reason]  For 'refused': why the address was refused.
   * @param {number} [status]  For 'http': the status received.
   */
  constructor(code, reason, status) {
    super(reason ? `${code}:${reason}` : code);
    this.name = 'PictureSourceError';
    this.code = code;
    this.reason = reason || null;
    this.status = status === undefined ? null : status;
  }
}

/* Any control character, space or DEL, anywhere. The WHATWG parser silently
   REMOVES tabs and newlines ('https://app.example.com\t.evil.com' is not what
   it looks like): an address carrying one is refused, never repaired. */
function hasUnsafeCharacter(text) {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * The origin of an http(s) address, parsed strictly; null when the address is
 * not one, or not one this parser can vouch for.
 *
 * Refused: another scheme, a backslash anywhere, a control character or a
 * space, credentials in the authority (`user@host`), a percent-encoded or
 * non-ASCII host, an empty host, a port that is not a number in range.
 * Scheme and host are lower-cased; the scheme's default port is dropped.
 *
 * @param {string} address
 * @returns {{scheme: 'http'|'https', host: string, port: number|null, origin: string, path: string} | null}
 *   `path` is everything after the authority (path, query, fragment), '' when none.
 */
function parseHttpAddress(address) {
  if (typeof address !== 'string' || address.length === 0 || address.length > PICTURE_ADDRESS_MAX_LENGTH) return null;
  if (hasUnsafeCharacter(address) || address.includes('\\')) return null;
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(address);
  if (!match) return null;
  const scheme = match[1].toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return null;
  const afterScheme = address.slice(match[0].length);
  const end = afterScheme.search(/[/?#]/);
  const authority = end === -1 ? afterScheme : afterScheme.slice(0, end);
  const path = end === -1 ? '' : afterScheme.slice(end);
  /* 'app.example.com@evil.com' is a request to evil.com. Credentials in a
     picture address have no honest use: refused outright. */
  if (!authority || authority.includes('@')) return null;

  let host;
  let portText = null;
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close === -1) return null;
    host = authority.slice(0, close + 1).toLowerCase();
    if (!/^\[[0-9a-f:.]+\]$/.test(host)) return null;
    const rest = authority.slice(close + 1);
    if (rest) {
      if (!rest.startsWith(':')) return null;
      portText = rest.slice(1);
    }
  } else {
    const colon = authority.indexOf(':');
    host = (colon === -1 ? authority : authority.slice(0, colon)).toLowerCase();
    if (colon !== -1) portText = authority.slice(colon + 1);
    /* ASCII letters, digits, dots and hyphens only: no '%' (an encoded host
       decodes to something else), no Unicode look-alikes. */
    if (!/^[a-z0-9.-]+$/.test(host) || host.startsWith('.') || host.includes('..')) return null;
  }

  let port = null;
  if (portText !== null) {
    if (!/^\d{1,5}$/.test(portText)) return null;
    port = Number(portText);
    if (port > 65535) return null;
    if (port === DEFAULT_PORTS[scheme]) port = null;
  }
  const origin = `${scheme}://${host}${port === null ? '' : `:${port}`}`;
  return { scheme, host, port, origin, path };
}

/** The origin of an address ('https://host[:port]'), or null. */
function originOf(address) {
  const parsed = parseHttpAddress(address);
  return parsed ? parsed.origin : null;
}

/**
 * Whether two addresses share an origin: scheme, host and port, compared
 * whole. Never a substring or prefix test. Two addresses that do not parse
 * share nothing.
 */
function isSameOrigin(a, b) {
  const first = originOf(a);
  return first !== null && first === originOf(b);
}

/**
 * An inline picture, read without decoding it.
 *
 * Only the header is examined for its shape (the first 256 characters); the
 * size is judged from the payload's LENGTH before anything scans it, so a
 * 200 MB address is refused in constant time.
 *
 * @param {string} address
 * @param {object} [options]
 * @param {readonly string[]} [options.types]  Accepted types, lowercase.
 * @param {number} [options.maxBytes]  Decoded size limit.
 * @returns {{ok: true, mimeType: string, base64: boolean, payloadStart: number, bytes: number}
 *   | {ok: false, reason: 'data_malformed'|'data_type'|'data_too_large'}}
 *   `bytes` is the decoded size (exact for base64 without whitespace, an
 *   upper bound otherwise).
 */
function readDataAddress(address, options = {}) {
  const types = Array.isArray(options.types) ? options.types : PICTURE_DATA_TYPES;
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : PICTURE_DATA_MAX_BYTES;
  if (typeof address !== 'string' || address.slice(0, 5).toLowerCase() !== 'data:') return { ok: false, reason: 'data_malformed' };
  const comma = address.slice(0, DATA_HEADER_MAX).indexOf(',');
  if (comma === -1) return { ok: false, reason: 'data_malformed' };
  const header = address.slice(5, comma);
  if (hasUnsafeCharacter(header)) return { ok: false, reason: 'data_malformed' };
  const parts = header.split(';');
  const mimeType = parts[0].trim().toLowerCase();
  const base64 = parts.length > 1 && parts[parts.length - 1].trim().toLowerCase() === 'base64';
  if (!/^[a-z]+\/[a-z0-9.+-]+$/.test(mimeType)) return { ok: false, reason: 'data_malformed' };
  if (!types.includes(mimeType)) return { ok: false, reason: 'data_type' };
  const payloadStart = comma + 1;
  const length = address.length - payloadStart;
  if (length === 0) return { ok: false, reason: 'data_malformed' };
  let bytes;
  if (base64) {
    bytes = Math.floor((length * 3) / 4);
    if (bytes > maxBytes) return { ok: false, reason: 'data_too_large' };
    /* Linear scan, no backtracking: the character set, then the padding. */
    let padding = 0;
    for (let i = payloadStart; i < address.length; i += 1) {
      const code = address.charCodeAt(i);
      const isAlphabet =
        (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 43 || code === 47;
      if (code === 61) padding += 1;
      else if (!isAlphabet || padding > 0) return { ok: false, reason: 'data_malformed' };
    }
    if (padding > 2 || length % 4 !== 0) return { ok: false, reason: 'data_malformed' };
    bytes -= padding;
  } else {
    bytes = length;
    if (bytes > maxBytes) return { ok: false, reason: 'data_too_large' };
  }
  return { ok: true, mimeType, base64, payloadStart, bytes };
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_INDEX = (() => {
  const index = new Int16Array(128).fill(-1);
  for (let i = 0; i < BASE64.length; i += 1) index[BASE64.charCodeAt(i)] = i;
  return index;
})();

/**
 * Standard base64 to bytes, without `atob` (absent from older Hermes builds
 * and from this package's lint globals). Characters outside the alphabet are
 * skipped; padding ends the data.
 * @param {string} text
 * @returns {Uint8Array}
 */
function decodeBase64(text) {
  const source = String(text || '');
  const out = new Uint8Array(Math.floor((source.length * 3) / 4) + 3);
  let buffer = 0;
  let bits = 0;
  let length = 0;
  for (let i = 0; i < source.length; i += 1) {
    const code = source.charCodeAt(i);
    if (code === 61) break;
    const value = code < 128 ? BASE64_INDEX[code] : -1;
    if (value === -1) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[length] = (buffer >> bits) & 0xff;
      length += 1;
    }
  }
  return out.slice(0, length);
}

/** Bytes to standard base64, padded. */
function encodeBase64(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || []);
  let out = '';
  for (let i = 0; i < input.length; i += 3) {
    const a = input[i];
    const b = i + 1 < input.length ? input[i + 1] : 0;
    const c = i + 2 < input.length ? input[i + 2] : 0;
    out += BASE64[a >> 2] + BASE64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < input.length ? BASE64[((b & 15) << 2) | (c >> 6)] : '=';
    out += i + 2 < input.length ? BASE64[c & 63] : '=';
  }
  return out;
}

/**
 * The bytes of an inline picture's payload, base64-encoded — what a file
 * system writes with `{ encoding: 'base64' }`. A base64 payload is returned as
 * it stands (no decode, no copy of megabytes through a byte array); a
 * percent-encoded one is decoded to bytes, then encoded.
 *
 * @param {string} address  Already accepted by readDataAddress.
 * @param {{base64: boolean, payloadStart: number}} read  Its result.
 * @returns {string}
 */
function dataPayloadBase64(address, read) {
  const payload = address.slice(read.payloadStart);
  if (read.base64) return payload;
  const bytes = [];
  for (let i = 0; i < payload.length; i += 1) {
    const code = payload.charCodeAt(i);
    if (code === 37 && /^[0-9a-fA-F]{2}$/.test(payload.slice(i + 1, i + 3))) {
      bytes.push(parseInt(payload.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(code & 0xff);
    }
  }
  return encodeBase64(bytes);
}

/**
 * What a picture file IS, from its first bytes — never from its name or a
 * declared type. A server that answers an error page with a 200 must not have
 * that HTML saved to Photos as a JPEG.
 *
 * @param {Uint8Array|number[]} head  At least the first 12 bytes.
 * @returns {{mimeType: string, extension: string} | null}
 */
function sniffPictureType(head) {
  const b = head || [];
  const at = (i) => (i < b.length ? b[i] : -1);
  const ascii = (from, text) => [...text].every((char, i) => at(from + i) === char.charCodeAt(0));
  if (at(0) === 0x89 && ascii(1, 'PNG') && at(4) === 0x0d && at(5) === 0x0a) return { mimeType: 'image/png', extension: 'png' };
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return { mimeType: 'image/jpeg', extension: 'jpg' };
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return { mimeType: 'image/gif', extension: 'gif' };
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return { mimeType: 'image/webp', extension: 'webp' };
  if (ascii(4, 'ftyp')) {
    if (ascii(8, 'avif') || ascii(8, 'avis')) return { mimeType: 'image/avif', extension: 'avif' };
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].some((brand) => ascii(8, brand))) {
      return { mimeType: 'image/heic', extension: 'heic' };
    }
  }
  if (ascii(0, 'BM') && b.length >= 14) return { mimeType: 'image/bmp', extension: 'bmp' };
  return null;
}

/* The Uniform Type Identifier iOS's share sheet wants for each extension. */
const PICTURE_UTIS = Object.freeze({
  png: 'public.png',
  jpg: 'public.jpeg',
  gif: 'com.compuserve.gif',
  webp: 'org.webmproject.webp',
  heic: 'public.heic',
  avif: 'public.avif',
  bmp: 'com.microsoft.bmp'
});

/**
 * What to tell iOS's share sheet a picture file is (expo-sharing's `UTI`),
 * from its name; null for anything else. The first version knew only PNG and
 * called everything else a JPEG.
 * @param {string} uri
 */
function pictureUti(uri) {
  const match = /\.([a-z0-9]+)$/i.exec(String(uri || ''));
  const extension = match ? match[1].toLowerCase() : '';
  return Object.prototype.hasOwnProperty.call(PICTURE_UTIS, extension) ? PICTURE_UTIS[extension] : null;
}

/**
 * A file name for a picture handed to the person (Photos, the share sheet):
 * its title, cleaned. Separators, reserved characters and control characters
 * become spaces; a leading dot (a hidden file) is dropped; the length is
 * counted in characters, never cutting an emoji or an accented letter in two.
 *
 * @param {string} title
 * @param {object} [options]
 * @param {string} [options.fallback]  When nothing is left. The APP's word —
 *   there is no default name in a language.
 * @param {number} [options.maxLength=60]
 * @returns {string}  Without extension; '' when neither title nor fallback
 *   leaves anything.
 */
function pictureFileName(title, options = {}) {
  const maxLength = Number.isFinite(options.maxLength) && options.maxLength > 0 ? options.maxLength : 60;
  const clean = (text) =>
    Array.from(
      String(text || '')
        // eslint-disable-next-line no-control-regex
        .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^[.\s]+/, '')
    )
      .slice(0, maxLength)
      .join('')
      .trim();
  return clean(title) || clean(options.fallback);
}

/**
 * The rule for one app: which addresses are its own, and what they carry.
 *
 * @param {object} options
 * @param {string} options.appUrl  The API's base URL, e.g.
 *   'https://api.example.com' or 'https://api.example.com/api'. Its ORIGIN
 *   is the only one that ever receives the token; a relative address
 *   ('/images/abc') is joined to the whole base.
 * @param {() => (string|null|Promise<string|null>)} [options.getToken]
 *   The person's token, read at each resolution (a token refreshed since the
 *   last picture is the one sent).
 * @param {(token: string) => Record<string, string>} [options.authorize]
 *   The headers a token becomes. Default: `Authorization: Bearer <token>`.
 * @param {boolean} [options.allowHttpOutside=false]  Outside pictures over
 *   plain http. Refused by default: iOS blocks them anyway (App Transport
 *   Security), and a page loading one leaks what the person reads.
 * @param {readonly string[]} [options.dataTypes]  Inline types accepted.
 * @param {number} [options.maxDataBytes]
 */
function createPictureSources(options = {}) {
  const base = parseHttpAddress(options.appUrl);
  if (!base) throw new Error('createPictureSources: options.appUrl must be an absolute http(s) URL without credentials.');
  const appOrigin = base.origin;
  /* The base's own path, without query or fragment or trailing slash:
     'https://api.example.com/api/' -> '/api'. */
  const basePath = base.path.split(/[?#]/)[0].replace(/\/+$/, '');
  const getToken = typeof options.getToken === 'function' ? options.getToken : () => null;
  const authorize =
    typeof options.authorize === 'function' ? options.authorize : (token) => ({ Authorization: `Bearer ${token}` });
  const allowHttpOutside = options.allowHttpOutside === true;
  const dataOptions = { types: options.dataTypes, maxBytes: options.maxDataBytes };

  /**
   * What an address is, decided without touching the network.
   *
   * @param {string} address
   * @returns {{kind: 'app', url: string}
   *   | {kind: 'outside', url: string}
   *   | {kind: 'data', url: string, mimeType: string, bytes: number}
   *   | {kind: 'refused', reason: string}}
   */
  function classify(address) {
    if (typeof address !== 'string' || address.trim() === '') return { kind: 'refused', reason: 'empty' };
    if (address.slice(0, 5).toLowerCase() === 'data:') {
      const read = readDataAddress(address, dataOptions);
      return read.ok ? { kind: 'data', url: address, mimeType: read.mimeType, bytes: read.bytes } : { kind: 'refused', reason: read.reason };
    }
    if (address.length > PICTURE_ADDRESS_MAX_LENGTH) return { kind: 'refused', reason: 'too_long' };
    if (hasUnsafeCharacter(address) || address.includes('\\')) return { kind: 'refused', reason: 'unsafe_characters' };

    /* A path of the app: '/images/abc'. Not '//host/…' — that is an address
       on ANOTHER host, whatever it looks like. */
    if (address.startsWith('/')) {
      if (address.startsWith('//')) return { kind: 'refused', reason: 'relative' };
      const url = `${appOrigin}${basePath}${address}`;
      /* Belt and braces: the joined address must parse back to the app's own
         origin, or it is not the app's. */
      return originOf(url) === appOrigin ? { kind: 'app', url } : { kind: 'refused', reason: 'relative' };
    }

    const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(address);
    if (!scheme) return { kind: 'refused', reason: 'relative' };
    const name = scheme[1].toLowerCase();
    if (name !== 'http' && name !== 'https') return { kind: 'refused', reason: 'scheme' };
    if (!address.slice(scheme[0].length).startsWith('//')) return { kind: 'refused', reason: 'relative' };
    const afterSlashes = address.slice(scheme[0].length + 2);
    const authorityEnd = afterSlashes.search(/[/?#]/);
    const authority = authorityEnd === -1 ? afterSlashes : afterSlashes.slice(0, authorityEnd);
    if (authority.includes('@')) return { kind: 'refused', reason: 'userinfo' };
    const parsed = parseHttpAddress(address);
    if (!parsed) return { kind: 'refused', reason: 'host' };
    /* The app's own origin, written in full: its token goes with it. */
    if (parsed.origin === appOrigin) return { kind: 'app', url: `${parsed.origin}${parsed.path}` };
    if (parsed.scheme === 'http' && !allowHttpOutside) return { kind: 'refused', reason: 'insecure' };
    return { kind: 'outside', url: `${parsed.origin}${parsed.path}` };
  }

  /**
   * The headers an address may carry: the token for the app's own origin,
   * nothing for any other. Compared whole, at the last moment, on the final
   * address — whatever built it.
   * @param {string} url  An absolute address.
   * @returns {Promise<Record<string, string>>}
   */
  async function headersFor(url) {
    if (originOf(url) !== appOrigin) return {};
    const token = await getToken();
    return typeof token === 'string' && token ? { ...authorize(token) } : {};
  }

  /**
   * A source for an image component (`{ uri, headers? }`), or null for a
   * refused address.
   *
   * @param {string} address
   * @param {object} [resolveOptions]
   * @param {Record<string, string|number|boolean>} [resolveOptions.query]
   *   Added to the APP's addresses only ('?original=1'). An outside address
   *   is never rewritten: a signed CDN link would stop working.
   */
  async function resolve(address, resolveOptions = {}) {
    const found = classify(address);
    if (found.kind === 'refused') return null;
    if (found.kind !== 'app') return { uri: found.url };
    const uri = withQuery(found.url, resolveOptions.query);
    const headers = await headersFor(uri);
    return Object.keys(headers).length ? { uri, headers } : { uri };
  }

  /**
   * A stable file-safe name for a picture's cached copy: the address,
   * normalised (a path and the same address written in full share it),
   * NEVER the token. Null for a refused address.
   *
   * @param {string} address
   * @param {object} [keyOptions]
   * @param {string} [keyOptions.variant]  'original', 'preview'…: two
   *   renditions of one picture are two files.
   * @param {string|number} [keyOptions.version]  Bump it to retire every
   *   file kept under the previous rule.
   */
  function cacheKey(address, keyOptions = {}) {
    const found = classify(address);
    if (found.kind === 'refused') return null;
    const identity = found.url.split('#')[0];
    return contentKey('picture', keyOptions.version, keyOptions.variant, found.kind === 'data' ? 'data' : 'http', identity);
  }

  return { appOrigin, classify, resolve, headersFor, cacheKey };
}

function withQuery(url, query) {
  if (!query || typeof query !== 'object') return url;
  const entries = Object.entries(query).filter(([, value]) => value !== undefined && value !== null);
  if (entries.length === 0) return url;
  const hash = url.indexOf('#');
  const head = hash === -1 ? url : url.slice(0, hash);
  const tail = hash === -1 ? '' : url.slice(hash);
  const encoded = entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join('&');
  return `${head}${head.includes('?') ? '&' : '?'}${encoded}${tail}`;
}

const PICTURE_FILE_EXTENSIONS = Object.freeze(['png', 'jpg', 'gif', 'webp', 'heic', 'avif', 'bmp']);

/**
 * Pictures as FILES on the phone — the original, to save to Photos or hand to
 * the share sheet — downloaded once, kept in a bounded directory.
 *
 * What the first version got wrong, and this one does not:
 * - it downloaded to a file named 'download' and, on the next call, served
 *   ANY file found in the folder: a download cut halfway was then served as
 *   the picture, forever. Here a download lands under a temporary name and is
 *   moved into place only once complete and recognised;
 * - it named the file .png or .jpg from two bytes, and anything else — an
 *   HTML error page answered with a 200 — was saved as a JPEG. Here the bytes
 *   decide, and what is not a picture is refused;
 * - outside pictures were keyed by a 32-bit hash: two addresses could share a
 *   file and show each other's picture. Here the key is 106 bits;
 * - nothing ever cleaned the folder. Here it is bounded (createMediaCache).
 *
 * @param {object} options
 * @param {ReturnType<typeof createPictureSources>} options.sources
 * @param {object} options.fs  expo-file-system/legacy's shape: getInfoAsync,
 *   makeDirectoryAsync, moveAsync, copyAsync, deleteAsync, readDirectoryAsync,
 *   downloadAsync, readAsStringAsync, writeAsStringAsync.
 * @param {string} options.directory  A directory of its own.
 * @param {number} [options.maxFiles]
 * @param {number} [options.maxBytes]
 * @param {() => number} [options.now]
 */
function createPictureFiles(options = {}) {
  const { sources, fs } = options;
  if (!sources || typeof sources.classify !== 'function') throw new Error('createPictureFiles: options.sources is required.');
  if (!fs) throw new Error('createPictureFiles: an fs adapter is required.');
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const cache = createMediaCache({
    fs,
    directory: options.directory,
    extensions: [...PICTURE_FILE_EXTENSIONS],
    maxFiles: options.maxFiles,
    maxBytes: options.maxBytes,
    now
  });
  const directory = cache.directory;
  const sharedDirectory = `${directory}shared/`;
  let counter = 0;
  const pending = new Map();

  async function discard(uri) {
    await fs.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
  }

  async function fetchInto(temporary, address, found, query) {
    if (found.kind === 'data') {
      const read = readDataAddress(address, { types: [found.mimeType] });
      await fs.writeAsStringAsync(temporary, dataPayloadBase64(address, read), { encoding: 'base64' });
      return;
    }
    const source = await sources.resolve(address, { query });
    if (!source) throw new PictureSourceError('refused', 'address');
    const result = await fs.downloadAsync(source.uri, temporary, source.headers ? { headers: source.headers } : {});
    const status = result && Number.isFinite(result.status) ? result.status : 200;
    if (status < 200 || status >= 300) throw new PictureSourceError('http', undefined, status);
  }

  async function download(address, key, found, query) {
    await fs.makeDirectoryAsync(directory, { intermediates: true });
    counter += 1;
    const temporary = `${directory}${key}.${now()}-${counter}.tmp`;
    let extension;
    try {
      await fetchInto(temporary, address, found, query);
      const head = await fs.readAsStringAsync(temporary, { encoding: 'base64', position: 0, length: 16 });
      const type = sniffPictureType(decodeBase64(head));
      if (!type) throw new PictureSourceError('not_a_picture');
      extension = type.extension;
    } catch (error) {
      await discard(temporary);
      throw error;
    }
    const destination = `${directory}${key}.${extension}`;
    try {
      await fs.moveAsync({ from: temporary, to: destination });
    } catch (error) {
      await discard(temporary);
      const info = await fs.getInfoAsync(destination);
      if (!info || !info.exists) throw error;
    }
    void cache.tidy().catch(() => undefined);
    return destination;
  }

  /**
   * The picture's original on the phone: the kept copy, or a fresh download.
   * Two calls for the same picture at once share one download.
   *
   * @param {string} address
   * @param {object} [originalOptions]
   * @param {Record<string, string|number|boolean>} [originalOptions.query]
   *   For the app's own pictures, e.g. `{ original: 1 }`.
   * @param {string|number} [originalOptions.version]
   * @returns {Promise<string>}  The file's URI.
   */
  function original(address, originalOptions = {}) {
    const found = sources.classify(address);
    if (found.kind === 'refused') return Promise.reject(new PictureSourceError('refused', found.reason));
    const key = sources.cacheKey(address, { variant: 'original', version: originalOptions.version });
    if (pending.has(key)) return pending.get(key);
    const job = (async () => {
      const known = await cache.lookup(key);
      return known || download(address, key, found, originalOptions.query);
    })().finally(() => pending.delete(key));
    pending.set(key, job);
    return job;
  }

  /**
   * A copy named after the picture's title, for Photos and the share sheet —
   * both read the type from the name. Only the latest named copy is kept: the
   * previous ones are cleared first.
   *
   * @param {string} address
   * @param {string} title
   * @param {object} [namedOptions]
   * @param {string} [namedOptions.fallback]  The name when the title is empty.
   * @param {Record<string, string|number|boolean>} [namedOptions.query]
   * @param {string|number} [namedOptions.version]
   */
  async function named(address, title, namedOptions = {}) {
    const file = await original(address, namedOptions);
    const extension = file.slice(file.lastIndexOf('.') + 1);
    await fs.deleteAsync(sharedDirectory, { idempotent: true }).catch(() => undefined);
    await fs.makeDirectoryAsync(sharedDirectory, { intermediates: true });
    /* No title and no fallback: the file keeps its neutral key as a name. */
    const name = pictureFileName(title, namedOptions) || file.slice(directory.length, file.lastIndexOf('.'));
    const destination = `${sharedDirectory}${name}.${extension}`;
    await fs.copyAsync({ from: file, to: destination });
    return destination;
  }

  return { directory, original, named, tidy: cache.tidy };
}

module.exports = {
  PICTURE_ADDRESS_MAX_LENGTH,
  PICTURE_DATA_MAX_BYTES,
  PICTURE_DATA_TYPES,
  PICTURE_EXTENSIONS,
  PICTURE_FILE_EXTENSIONS,
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
};
