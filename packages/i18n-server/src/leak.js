/**
 * A mail rendered for one language must not contain another.
 *
 * The failure this catches is not a missing translation — those show up as a
 * bare key or a blank. It is a translated mail with ONE line still in the
 * source language: a subject typed in the call, a footer built in a helper
 * nobody thought to translate, a date formatted with the server's locale.
 * Everything else is right, so a quick look says "it's in English", and the
 * recipient gets "Your password was changed — Réinitialisez votre accès".
 *
 * The check is deliberately blunt: a short list of words that only exist in
 * each language, searched in everything the recipient reads. Render your mail
 * for an account whose interface is in one language and whose mail is in
 * another — the only case that tells the two apart — and assert nothing leaks.
 */

/* Letters and digits on both sides mean "inside a word". `\b` cannot say that:
   it treats "é" as a boundary, so /\bpr\b/ would match inside "pré". */
const wordPattern = (word) => new RegExp(
  `(?<![\\p{L}\\p{N}_])${String(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`,
  'iu'
);

const asPattern = (marker) => (marker instanceof RegExp
  ? new RegExp(marker.source, marker.flags.replace('g', ''))
  : wordPattern(marker));

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/**
 * What a person reads in an HTML mail: no styles, no scripts, no comments, no
 * tags, entities decoded. Scanning raw HTML would match class names and CSS.
 */
function visibleText(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#?\w+);/g, (whole, name) => {
      if (ENTITIES[name] !== undefined) return ENTITIES[name];
      if (/^#\d+$/.test(name)) return String.fromCodePoint(Number(name.slice(1)));
      return whole;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/** The `lang` of the `<html>` element, or null. */
function htmlLanguage(html) {
  const match = /<html\b[^>]*\blang\s*=\s*["']?([\w-]+)/i.exec(String(html || ''));
  return match ? match[1].toLowerCase() : null;
}

/**
 * @param {object} options
 * @param {Record<string, Array<string|RegExp>>} options.markers words that only
 *   exist in each language. Choose them carefully: "message", "code" or
 *   "date" are shared by several languages and would cry wolf. Pronouns and
 *   greetings ("vous", "votre", "bonjour") are the reliable ones.
 * @param {boolean} [options.requireHtmlLang] also fail an HTML part with no
 *   `<html lang>` at all. Default false.
 */
function createLanguageLeakCheck(options = {}) {
  const markers = options.markers || {};
  const languages = Object.keys(markers);
  if (!languages.length) {
    throw new Error('createLanguageLeakCheck requires options.markers, e.g. { fr: ["vous", "votre"] }.');
  }
  const compiled = Object.fromEntries(languages.map((language) => [language, markers[language].map(asPattern)]));
  const requireHtmlLang = Boolean(options.requireHtmlLang);

  /**
   * @param {string|{subject?: string, text?: string, html?: string}} mail
   * @param {string} expected the language the mail must be in.
   * @returns {{clean: boolean, findings: Array<{part: string, language: string|null, match: string}>}}
   */
  function inspect(mail, expected) {
    if (!expected) throw new Error('inspect(mail, expected) needs the language the mail must be in.');
    const parts = typeof mail === 'string' ? { text: mail } : { ...(mail || {}) };
    const findings = [];

    const readable = {};
    for (const [part, value] of Object.entries(parts)) {
      if (value === undefined || value === null) continue;
      readable[part] = part === 'html' ? visibleText(value) : String(value);
    }

    for (const [part, text] of Object.entries(readable)) {
      for (const language of languages) {
        if (language === expected) continue;
        for (const pattern of compiled[language]) {
          const found = pattern.exec(text);
          if (found) findings.push({ part, language, match: found[0] });
        }
      }
    }

    /* The lang attribute decides how a screen reader pronounces the mail and
       whether the client offers to translate it. A French attribute on an
       English mail reads English words with French phonetics. */
    if (parts.html !== undefined && parts.html !== null) {
      const declared = htmlLanguage(parts.html);
      if (declared && declared.split('-')[0] !== expected) {
        findings.push({ part: 'html', language: declared, match: `<html lang="${declared}">` });
      } else if (!declared && requireHtmlLang) {
        findings.push({ part: 'html', language: null, match: 'no <html lang>' });
      }
    }

    return { clean: !findings.length, findings };
  }

  /** One readable line per finding — what a failing test should print. */
  const describe = (result) => result.findings.map(({ part, language, match }) =>
    `${part}: "${match}"${language ? ` (${language})` : ''}`);

  return { inspect, describe, languages };
}

module.exports = { createLanguageLeakCheck, visibleText, htmlLanguage };
