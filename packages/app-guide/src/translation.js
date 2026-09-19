'use strict';

function readPath(dictionary, key) {
  return String(key).split('.').reduce((node, part) => {
    if (!node || typeof node !== 'object') return undefined;
    return node[part];
  }, dictionary);
}

function createTranslationResolver(dictionary, options = {}) {
  const missing = options.missing || ((key) => key);
  return (key) => {
    const value = readPath(dictionary, key);
    return typeof value === 'string' ? value : missing(key);
  };
}

module.exports = { createTranslationResolver };
