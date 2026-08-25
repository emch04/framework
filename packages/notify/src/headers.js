/**
 * Keeping user input out of mail headers.
 *
 * Headers are separated by CRLF. A newline inside a subject, a sender name or a
 * reply-to therefore does not stay inside that field — it ENDS it and starts a
 * new one. Anything after it becomes a header of its own:
 *
 *   subject = "Order confirmed\r\nBcc: everyone@example.com"
 *
 * That is header injection, and it turns a contact form into a spam relay or a
 * silent copy of every message. It is old, well known, and still shipped daily,
 * because the string looks perfectly ordinary in a debugger.
 *
 * Anything that ends up in a header goes through here first.
 */

/* CR, LF, NUL, and the Unicode line/paragraph separators — some mail libraries
   normalise those two to a newline further down the chain. */
const BREAKS = /[\r\n\0\u2028\u2029]+/g;

/**
 * Make a value safe to place in a header.
 *
 * Line breaks become a single space rather than disappearing: a subject that
 * silently loses half its words is a bug report you will never understand.
 */
function sanitizeHeader(value, options = {}) {
  const maxLength = options.maxLength || 500;
  const cleaned = String(value === null || value === undefined ? '' : value)
    .replace(BREAKS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength).trim() : cleaned;
}

/** Did this value carry something that had to be stripped? */
function hasHeaderInjection(value) {
  BREAKS.lastIndex = 0;
  return BREAKS.test(String(value === null || value === undefined ? '' : value));
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * An address, or nothing.
 *
 * Returning null on a malformed address rather than passing it through is
 * deliberate: an invalid Reply-To silently breaks every reply to that message,
 * and nobody reports it because the mail itself arrived.
 */
function sanitizeAddress(value) {
  const cleaned = sanitizeHeader(value, { maxLength: 320 });
  return EMAIL.test(cleaned) ? cleaned : null;
}

/** `"Name" <address>`, with the name made safe and its quotes stripped. */
function formatSender(address, name) {
  const safeAddress = sanitizeAddress(address);
  if (!safeAddress) return null;
  /* Quotes go, then trim again: stripping a trailing quote otherwise leaves a
     dangling space inside the display name. The name stays inside its own
     quotes, so an address smuggled into it is inert. */
  const safeName = sanitizeHeader(name).replace(/"/g, '').trim();
  return safeName ? `"${safeName}" <${safeAddress}>` : safeAddress;
}

module.exports = { sanitizeHeader, sanitizeAddress, formatSender, hasHeaderInjection, EMAIL };
