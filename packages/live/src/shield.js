'use strict';

function createLiveShield({
  omitKey = () => false,
  redactText = text => text,
  maskText = text => text,
  unmaskText = text => text,
  maxDepth = 12
} = {}) {
  function visit(value, transform, path = [], depth = 0, seen = new WeakSet()) {
    if (typeof value === 'string') return transform(value);
    if (value === null || typeof value !== 'object') return value;
    if (depth >= maxDepth || seen.has(value)) return null;
    seen.add(value);
    const output = Array.isArray(value) ? [] : {};
    for (const [key, child] of Object.entries(value)) {
      if (omitKey(key, path, child)) continue;
      output[key] = visit(child, transform, [...path, key], depth + 1, seen);
    }
    seen.delete(value);
    return output;
  }
  return {
    input: maskText,
    output: unmaskText,
    args: value => visit(value, unmaskText),
    result: value => visit(value, maskText),
    external: value => visit(value, redactText),
    history: value => visit(value, redactText)
  };
}
module.exports = {
  createLiveShield
};
