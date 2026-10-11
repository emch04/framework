'use strict';

/* Personal data and secrets a reply must not carry unless the person gave it in this run.
   Small on purpose: structured data that can be recognised without a model. Secrets
   (API keys, tokens, private keys) and IP addresses are found first: a key or an address
   is never half-read as a phone number or a card. */

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

/* Keys whose shape is published by their provider. A prefix and a long random tail: no
   ordinary word looks like this. */
const API_KEY = new RegExp([
  'sk-ant-[A-Za-z0-9_-]{20,}',            // Anthropic
  'sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}', // OpenAI
  'AIza[0-9A-Za-z_-]{35}',                // Google
  'gh[pousr]_[A-Za-z0-9]{36,}',           // GitHub
  'github_pat_[A-Za-z0-9_]{22,}',         // GitHub, fine-grained
  '(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}', // Stripe
  'whsec_[A-Za-z0-9]{24,}',               // Stripe webhooks
  'AKIA[0-9A-Z]{16}',                     // AWS
  'xox[baprs]-[A-Za-z0-9-]{10,}',         // Slack
  'gsk_[A-Za-z0-9]{20,}',                 // Groq
  'hf_[A-Za-z0-9]{30,}'                   // Hugging Face
].map((p) => `(?<![A-Za-z0-9_-])${p}`).join('|'), 'g');

function ipv4Valid(value) {
  return value.split('.').every((part) => Number(part) <= 255 && !(part.length > 1 && part.startsWith('0')));
}

const DETECTORS = [
  { type: 'privateKey', pattern: () => /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, valid: () => true },
  { type: 'jwt', pattern: () => /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, valid: () => true },
  { type: 'apiKey', pattern: () => new RegExp(API_KEY.source, 'g'), valid: () => true },
  { type: 'ip', pattern: () => /(?<![\w.:])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])|(?<![\w:])(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}(?![\w:])|(?<![\w:])(?:[0-9a-f]{1,4}:){1,6}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,5})?(?![\w:])/gi, valid: (value) => (value.includes('.') ? ipv4Valid(value) : (value.match(/:/g) || []).length >= 2) },
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

const SECRET_TYPES = new Set(['privateKey', 'jwt', 'apiKey']);
const normal = (type, value) => {
  if (type === 'email' || type === 'ip') return value.toLowerCase();
  if (SECRET_TYPES.has(type)) return value.replace(/\s+/g, '');
  return value.replace(/[\s.()-]/g, '').toUpperCase();
};

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
