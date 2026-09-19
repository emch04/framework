'use strict';

function compilePattern(pattern) {
  if (pattern instanceof RegExp) {
    const flags = [...new Set(`${pattern.flags.replace(/g|y/g, '')}u`)].join('');
    return new RegExp(pattern.source, flags);
  }
  /* JavaScript's \b is ASCII-oriented: at the start of "À quoi", both sides
     are non-word characters, so the old boundary silently missed the phrase. */
  return new RegExp(`(?:^|[^\\p{L}])(?:${pattern})`, 'iu');
}

function createUsageQuestionDetector(options = {}) {
  const byLanguage = Object.fromEntries(Object.entries(options.patterns || {}).map(([language, patterns]) => [
    language,
    patterns.map(compilePattern)
  ]));

  return (question, language) => {
    const patterns = byLanguage[language] || byLanguage[options.fallbackLanguage] || [];
    return patterns.some((pattern) => pattern.test(String(question || '')));
  };
}

module.exports = { createUsageQuestionDetector };
