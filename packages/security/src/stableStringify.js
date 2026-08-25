/**
 * A serialisation two machines agree on.
 *
 * `JSON.stringify` preserves insertion order, and insertion order depends on
 * how the object was built. Service A builds `{ id, role }`, service B rebuilds
 * `{ role, id }` from a database row, and the two produce different strings for
 * the same data. Anything derived from that string — a signature, a hash —
 * then disagrees, intermittently, in a way that looks like a network problem.
 *
 * Sorting the keys removes the question. Used by both the service signer and
 * the audit chain, because a signature and a hash have the same requirement.
 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

module.exports = { stableStringify };
