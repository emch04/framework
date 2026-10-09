'use strict';

/* Personal data a reply must not carry unless the person gave it in this run.
   Small on purpose: structured data that can be recognised without a model. */

function luhnValid(digits) {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function ibanValid(value) {
  const compact = value.replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact)) return false;
  const moved = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const char of moved) {
    const chunk = /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of chunk) remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

const DATE_LIKE = /^\d{4}-\d{2}-\d{2}/;

const DETECTORS = [
  { type: 'email', pattern: () => /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, valid: () => true },
  { type: 'iban', pattern: () => /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{2,5}){3,8}\b/g, valid: ibanValid },
  { type: 'card', pattern: () => /\b(?:\d[ -]?){13,19}\b/g, valid: (value) => luhnValid(value.replace(/\D/g, '')) },
  {
    type: 'phone',
    pattern: () => /(?<![\w@])\+?\d[\d .()-]{7,17}\d(?![\w@])/g,
    valid: (value) => {
      const digits = value.replace(/\D/g, '');
      return digits.length >= 9 && digits.length <= 15 && !DATE_LIKE.test(value) && !luhnValid(digits);
    }
  }
];

const normal = (type, value) => (type === 'email' ? value.toLowerCase() : value.replace(/[\s.()-]/g, '').toUpperCase());

/** Structured personal data in a text: [{ type, value, start, end }] (values stay in memory, never in events). */
function findPersonalData(text, types) {
  const found = [];
  for (const detector of DETECTORS) {
    if (types && !types.includes(detector.type)) continue;
    for (const match of String(text).matchAll(detector.pattern())) {
      const overlaps = found.some((f) => match.index < f.end && match.index + match[0].length > f.start);
      if (overlaps || !detector.valid(match[0])) continue;
      found.push({ type: detector.type, value: match[0], key: normal(detector.type, match[0]), start: match.index, end: match.index + match[0].length });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

module.exports = { findPersonalData, luhnValid, ibanValid };
