/**
 * Reading a list, and a name, out of a payload you did not design.
 *
 * A generic screen — "show me the things behind this tool" — faces an endpoint
 * that answers however it likes: a bare array, a wrapper around one, or a
 * single object for a detail route. Handling only the shape you tested against
 * produces a blank screen the day another endpoint is wired in.
 *
 * The fallbacks are ordered by how well each field identifies a row to a human:
 * a full name beats an email, an email beats an id. An id is the last resort,
 * because "68f3c1a" tells nobody anything.
 */

const TITLE_FIELDS = ['fullName', 'name', 'title', 'label', 'reference', 'email', 'id'];
const SUBTITLE_FIELDS = ['email', 'description', 'status', 'phone', 'code', 'role', 'level'];

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The rows to render, whatever the envelope. Never throws, never null. */
function readResourceItems(data) {
  if (Array.isArray(data)) return data.filter(isRecord);
  if (!isRecord(data)) return [];

  for (const value of Object.values(data)) {
    if (Array.isArray(value)) return value.filter(isRecord);
  }

  /* A detail endpoint answers with one object. Rendering it as a list of one
     beats rendering nothing. */
  return [data];
}

function firstText(item, fields) {
  for (const field of fields) {
    const value = item ? item[field] : undefined;
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number') return String(value);
  }
  return '';
}

/** @param {string[]} [fields] Override for a domain with its own naming. */
function readResourceTitle(item, fields = TITLE_FIELDS) {
  return firstText(item, fields);
}

function readResourceSubtitle(item, fields = SUBTITLE_FIELDS) {
  return firstText(item, fields);
}

module.exports = {
  TITLE_FIELDS,
  SUBTITLE_FIELDS,
  readResourceItems,
  readResourceTitle,
  readResourceSubtitle
};
