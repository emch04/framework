/**
 * Private files behind short-lived links — one link per READER, never shared.
 *
 * An <img> tag or an audio player sends no Authorization header, so a private
 * file cannot be protected by the session alone: the address itself has to
 * carry a pass. That pass is where the real defects were.
 *
 * THE DEFECT THIS MODULE EXISTS FOR. A chat message with an attachment was
 * broadcast in real time with its link already signed — signed for the
 * SENDER, because the sender's request is the one that produced the message.
 * The recipient opened the file by borrowing the sender's identity, and the
 * pass expired a quarter of an hour later inside a conversation left open.
 * The rule that follows: a broadcast carries the PATH only; each reader asks
 * for their own link at the moment they display the file, and the server
 * re-checks the right to read on that request.
 *
 * A LINK IS STABLE WITHIN A STEP. Signed "now", a link differed on every
 * response for the same file. A thread polled every five seconds therefore
 * produced a new address every time: no image cache recognised it, and an
 * audio player whose source changed restarted mid-playback — a voice note
 * never finished (measured: 202 requests in one minute, 79 MB served for five
 * files weighing 600 KB). The pass is aligned on a time step: identical within
 * a step, valid for two, so a link obtained just before a change still lives
 * one full step.
 *
 * THE PASS IS HEX, END TO END. A JWT is base64url, which contains '-'. About
 * one pass in a hundred carried a '--', which a WAF reads as an SQL comment in
 * the query string: that file answered 403 to that person for the whole step,
 * and nobody could reproduce it. Same lesson as the refresh tokens.
 *
 * THE PASS NAMES THE ACCOUNT AND ITS SESSION VERSION. Revoking sessions (a
 * password change, "sign out everywhere") must also kill the passes already
 * handed out; `accountVersion` is re-read at verification for that reason.
 */

const crypto = require('crypto');
const path = require('path');

const DEFAULT_STEP_SECONDS = 15 * 60;
const MIN_SECRET_LENGTH = 32;
const PURPOSE = 'private-file';
/* Kinds and ids end up in a URL path: anything outside these alphabets is a
   path segment an attacker chose. */
const KIND_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const TICKET_PATTERN = /^[a-f0-9]+\.[a-f0-9]{64}$/;
const INLINE_MIME = /^(image\/(jpeg|png|gif|webp)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+)$/;

const idOf = (value) => String(value?._id ?? value?.id ?? value ?? '');

function sameText(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * @param {object} options
 * @param {string} options.secret  DEDICATED to file links, at least 32 chars.
 *   Reusing the session-signing secret means one leak forges both.
 * @param {number} [options.stepSeconds=900]
 * @param {string} [options.basePath='/files']  where the file route is mounted.
 * @param {string} [options.ticketParam='ticket']
 * @param {(accountId: string) => Promise<number|null|undefined>} [options.accountVersion]
 *   Current session version of an account, null when it no longer exists.
 *   Without it a pass survives a "sign out everywhere" until it expires.
 * @param {() => number} [options.now]
 */
function createPrivateFileLinks(options = {}) {
  const secret = options.secret;
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`createPrivateFileLinks requires options.secret (at least ${MIN_SECRET_LENGTH} characters).`);
  }
  const stepSeconds = options.stepSeconds || DEFAULT_STEP_SECONDS;
  const basePath = String(options.basePath || '/files').replace(/\/+$/, '');
  const ticketParam = options.ticketParam || 'ticket';
  const accountVersion = options.accountVersion;
  const now = options.now || Date.now;

  const digest = (payloadHex) => crypto.createHmac('sha256', secret).update(`${PURPOSE}:${payloadHex}`).digest('hex');

  function assertTarget(kind, fileId) {
    if (!KIND_PATTERN.test(String(kind))) throw new Error(`Invalid private file kind: ${kind}`);
    if (!FILE_ID_PATTERN.test(String(fileId))) throw new Error('Invalid private file id.');
  }

  /** The address with no pass — the only form a broadcast may carry. */
  function pathFor(kind, fileId) {
    const id = idOf(fileId);
    assertTarget(kind, id);
    return `${basePath}/${kind}/${id}`;
  }

  /**
   * Sign a pass for ONE reader and ONE file.
   * @param {{kind: string, fileId: *, accountId: *, version?: number}} input
   * @returns {{ticket: string, url: string, issuedAt: number, expiresAt: number}}
   */
  function sign({ kind, fileId, accountId, version = 0 } = {}) {
    const id = idOf(fileId);
    const account = idOf(accountId);
    assertTarget(kind, id);
    if (!account) throw new Error('sign requires the reader accountId.');

    const step = Math.floor(now() / 1000 / stepSeconds) * stepSeconds;
    /* Array, not object: a fixed field order is what keeps the pass
       byte-identical within a step. */
    const payload = JSON.stringify([PURPOSE, kind, id, account, Number(version) || 0, step, step + 2 * stepSeconds]);
    const payloadHex = Buffer.from(payload, 'utf8').toString('hex');
    const ticket = `${payloadHex}.${digest(payloadHex)}`;
    return {
      ticket,
      url: `${basePath}/${kind}/${id}?${ticketParam}=${ticket}`,
      issuedAt: step * 1000,
      expiresAt: (step + 2 * stepSeconds) * 1000
    };
  }

  /** Shorthand for the reader's own link: `linkFor(kind, file, { id, version })`. */
  function linkFor(kind, fileId, reader) {
    if (!reader) return null;
    return sign({ kind, fileId, accountId: reader.id ?? reader._id, version: reader.version ?? reader.tokenVersion ?? 0 }).url;
  }

  /**
   * Check a pass against the file actually requested.
   *
   * @returns {Promise<{valid: true, accountId: string, version: number, expiresAt: number}
   *   | {valid: false, reason: 'missing'|'malformed'|'bad-signature'|'expired'|'wrong-file'|'unknown-account'|'revoked'}>}
   */
  async function verify(ticket, { kind, fileId } = {}) {
    if (!ticket || typeof ticket !== 'string') return { valid: false, reason: 'missing' };
    if (!TICKET_PATTERN.test(ticket)) return { valid: false, reason: 'malformed' };

    const [payloadHex, signature] = ticket.split('.');
    /* Signature FIRST, parse second: parsing an unverified payload runs the
       JSON parser on whatever an attacker sent. */
    if (!sameText(digest(payloadHex), signature)) return { valid: false, reason: 'bad-signature' };

    let claims;
    try {
      claims = JSON.parse(Buffer.from(payloadHex, 'hex').toString('utf8'));
    } catch {
      return { valid: false, reason: 'malformed' };
    }
    if (!Array.isArray(claims) || claims.length !== 7 || claims[0] !== PURPOSE) return { valid: false, reason: 'malformed' };

    const [, signedKind, signedId, account, version, issuedAt, expiresAt] = claims;
    const nowSeconds = now() / 1000;
    /* A pass from the future is a forged clock or a skewed server: refused. */
    if (!(issuedAt <= nowSeconds && nowSeconds < expiresAt)) return { valid: false, reason: 'expired' };

    /* A pass is for ONE file. Without this, a pass to any file the person may
       read opens every other file id put in the path. */
    if (signedKind !== String(kind) || signedId !== idOf(fileId)) return { valid: false, reason: 'wrong-file' };

    if (typeof accountVersion === 'function') {
      const current = await accountVersion(account);
      if (current === null || current === undefined) return { valid: false, reason: 'unknown-account' };
      if ((Number(current) || 0) !== version) return { valid: false, reason: 'revoked' };
    }

    return { valid: true, accountId: account, version, expiresAt: expiresAt * 1000 };
  }

  return { sign, linkFor, pathFor, verify, stepSeconds, ticketParam };
}

/* ─────────────────────── Serialising what goes out ─────────────────────── */

function walk(value, visit) {
  if (value === null || typeof value !== 'object' || value instanceof Date || Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return value.map((entry) => walk(entry, visit));
  /* ObjectId and friends: a value object with its own toString, not a record. */
  if (typeof value.toHexString === 'function') return value;
  const plain = typeof value.toObject === 'function' ? value.toObject() : value;
  const result = {};
  for (const [key, entry] of Object.entries(plain)) result[key] = walk(entry, visit);
  return visit(plain, result);
}

function fileFieldsRewriter({ field = 'fileUrl', idField = '_id', deletedField = 'deletedAt', clearWhenDeleted = [], kind, toAddress }) {
  return (plain, result) => {
    if (!Object.prototype.hasOwnProperty.call(plain, field)) return result;
    const deleted = Boolean(plain[deletedField]);
    const resolvedKind = typeof kind === 'function' ? kind(plain) : kind;
    result[field] = plain[field] && plain[idField] && !deleted ? toAddress(resolvedKind, plain[idField]) : null;
    /* Cutting the address of a deleted item while leaving its preview (a
       thumbnail, a quoted text) in place deletes nothing at all. Applied at
       EVERY depth: a quoted message carries the same risk as the message. */
    if (deleted) for (const extra of clearWhenDeleted) if (extra in result) result[extra] = null;
    return result;
  };
}

/**
 * For a response to ONE reader: every file address becomes that reader's own
 * link. Never use it for a broadcast — see serializeForBroadcast.
 */
function serializeForReader(value, { links, reader, kind, ...fields } = {}) {
  if (!links) throw new Error('serializeForReader requires options.links.');
  return walk(value, fileFieldsRewriter({ ...fields, kind, toAddress: (k, id) => links.linkFor(k, id, reader) }));
}

/**
 * For anything sent to several people (a socket room, a push, a webhook): the
 * PATH only. Each recipient then asks for their own link.
 */
function serializeForBroadcast(value, { links, kind, ...fields } = {}) {
  if (!links) throw new Error('serializeForBroadcast requires options.links.');
  return walk(value, fileFieldsRewriter({ ...fields, kind, toAddress: (k, id) => links.pathFor(k, id) }));
}

/* ─────────────────────────── Serving the bytes ─────────────────────────── */

/**
 * Resolve a stored file name under its root, or null.
 *
 * Two checks, each doing its own job. A bare name only — no separator, no NUL
 * — so a stored name can never reach into a sub-directory. Then the resolved
 * path must sit strictly INSIDE the root, which is what refuses '.', '..' and
 * any form of traversal nobody thought to list.
 */
function resolveStoredFile(root, name) {
  if (!root || typeof name !== 'string' || !name) return null;
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return null;
  const base = path.resolve(root);
  const full = path.resolve(base, name);
  const relative = path.relative(base, full);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return full;
}

/**
 * Headers for serving a private file. Inline only for media a browser renders
 * without running anything; everything else downloads. The sandbox CSP and
 * nosniff stop an uploaded HTML or SVG from executing as your origin.
 */
function privateFileHeaders({ mime, fileName } = {}) {
  const type = String(mime || 'application/octet-stream').toLowerCase();
  const inline = INLINE_MIME.test(type);
  return {
    'Content-Type': type,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(fileName || 'file')}`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; sandbox"
  };
}

/**
 * The route, with its three doors in the right order.
 *
 *   GET {base}/:kind/:id?ticket=…   the pass alone identifies the reader;
 *   GET {base}/:kind/:id?link=1     SESSION required: answers the reader's own link;
 *   GET {base}/:kind/:id            SESSION required: serves the bytes.
 *
 * A pass never mints another pass: `link=1` with a ticket goes through the
 * session door, otherwise a leaked pass could be renewed forever.
 * Every refusal answers the same 404 (401 for a bad pass), so the route never
 * says whether a file exists. Bodies carry a code, never text: the words
 * belong to the caller's catalogue.
 *
 * @param {object} options
 * @param {object} options.links            createPrivateFileLinks()
 * @param {Function} options.authenticate   (req, res, next) — your session middleware; sets req.user.
 * @param {(kind: string, id: string) => Promise<object|null>} options.loadFile
 * @param {(reader: object, kind: string, file: object) => Promise<boolean>} options.canRead
 * @param {(accountId: string) => Promise<object|null>} options.loadReader  reader for a valid pass.
 * @param {(file: object, req: object, res: object) => Promise<void>} options.send  streams the bytes.
 */
function createPrivateFileHandler(options = {}) {
  const { links, authenticate, loadFile, canRead, loadReader, send } = options;
  for (const [name, fn] of Object.entries({ authenticate, loadFile, canRead, loadReader, send })) {
    if (typeof fn !== 'function') throw new Error(`createPrivateFileHandler requires options.${name}.`);
  }
  if (!links || typeof links.verify !== 'function') throw new Error('createPrivateFileHandler requires options.links.');

  const refuse = (res, status = 404) => res.status(status).json({ success: false, code: status === 401 ? 'FILE_LINK_INVALID' : 'FILE_UNAVAILABLE' });

  return async function privateFileHandler(req, res, next) {
    const kind = String(req.params?.kind || '');
    const id = String(req.params?.id || '');
    if (!KIND_PATTERN.test(kind) || !FILE_ID_PATTERN.test(id)) return refuse(res);

    const wantsLink = req.query?.link === '1';
    const ticket = req.query?.[links.ticketParam || 'ticket'];

    const handle = async () => {
      try {
        const file = await loadFile(kind, id);
        if (!file || !req.user || !(await canRead(req.user, kind, file))) return refuse(res);
        if (res.setHeader) res.setHeader('Cache-Control', 'private, no-store');
        if (wantsLink) return res.status(200).json({ success: true, data: { fileUrl: links.linkFor(kind, id, req.user) } });
        return await send(file, req, res);
      } catch (error) {
        return next(error);
      }
    };

    if (ticket && !wantsLink) {
      try {
        const check = await links.verify(String(ticket), { kind, fileId: id });
        if (!check.valid) return refuse(res, 401);
        const reader = await loadReader(check.accountId);
        if (!reader) return refuse(res, 401);
        req.user = reader;
      } catch (_error) {
        return refuse(res, 401);
      }
      return handle();
    }

    return authenticate(req, res, handle);
  };
}

module.exports = {
  createPrivateFileLinks,
  serializeForReader,
  serializeForBroadcast,
  resolveStoredFile,
  privateFileHeaders,
  createPrivateFileHandler,
  PRIVATE_FILE_STEP_SECONDS: DEFAULT_STEP_SECONDS
};
