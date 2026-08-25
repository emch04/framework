/**
 * HTML that survives a mail client.
 *
 * Email rendering is not the web. Outlook uses Word to lay out HTML, Gmail
 * strips `<style>` blocks and anything it does not recognise, and flexbox,
 * grid, custom properties and external stylesheets are simply absent. What
 * works everywhere is what worked in 2005: nested tables and inline styles.
 *
 * So this is not a design system. It is the smallest skeleton that arrives
 * looking the same in Gmail, Outlook and Apple Mail, with your colours applied
 * to it. Everything about the LOOK is yours; everything about the plumbing is
 * here.
 */

/**
 * Escaping is not optional, and it is not only about scripts.
 *
 * A customer named "Dupont & Fils <SARL>" breaks the layout of every message
 * they are named in, long before anybody tries to attack you.
 */
function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const DEFAULT_THEME = {
  background: '#f4f5f7',
  surface: '#ffffff',
  text: '#1a1a1a',
  muted: '#6b7280',
  accent: '#2563eb',
  accentText: '#ffffff',
  border: '#e5e7eb',
  fontFamily: 'Arial, Helvetica, sans-serif',
  width: 600
};

/**
 * The line shown next to the subject in an inbox list.
 *
 * Left unset, clients grab the first words of the body — usually "View this
 * email in your browser" or a stray alt text. Hidden in the message itself.
 */
function preheader(text) {
  if (!text) return '';
  return `<div style="display:none;font-size:1px;color:transparent;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden">${escapeHtml(text)}</div>`;
}

function paragraph(text, theme) {
  return `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:${theme.text}">${escapeHtml(text)}</p>`;
}

function heading(text, theme) {
  return `<h1 style="margin:0 0 18px;font-size:22px;line-height:1.3;color:${theme.text};font-weight:700">${escapeHtml(text)}</h1>`;
}

/**
 * A button, built as a table.
 *
 * A styled `<a>` collapses to a bare link in Outlook, because Word's rendering
 * engine ignores padding on inline elements. A single-cell table with a
 * background is the shape that survives.
 */
function button(label, url, theme) {
  const safeUrl = /^https?:\/\//i.test(String(url || '')) ? String(url) : '#';
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px"><tr><td style="background:${theme.accent};border-radius:6px"><a href="${escapeHtml(safeUrl)}" style="display:inline-block;padding:12px 24px;font-size:15px;font-weight:700;color:${theme.accentText};text-decoration:none">${escapeHtml(label)}</a></td></tr></table>`;
}

/** A code to read aloud or retype — spaced out so it can be. */
function code(value, theme) {
  return `<p style="margin:0 0 20px;font-size:30px;font-weight:800;letter-spacing:8px;color:${theme.text};font-family:monospace">${escapeHtml(value)}</p>`;
}

function divider(theme) {
  return `<div style="height:1px;background:${theme.border};margin:0 0 20px"></div>`;
}

function note(text, theme) {
  return `<p style="margin:0 0 12px;font-size:13px;line-height:1.5;color:${theme.muted}">${escapeHtml(text)}</p>`;
}

const RENDERERS = { heading, paragraph, button, code, divider, note };

/**
 * @param {object} options
 * @param {Array} options.blocks  [{ type, ...args }] — heading, paragraph,
 *   button, code, divider, note, or { type: 'html', html } for your own markup.
 * @param {string} [options.preheader]
 * @param {string} [options.footer]
 * @param {object} [options.theme]
 * @returns {string} a complete HTML document.
 */
function renderEmail(options = {}) {
  const theme = { ...DEFAULT_THEME, ...(options.theme || {}) };
  const blocks = options.blocks || [];

  const body = blocks.map((block) => {
    if (!block || !block.type) return '';
    /* An escape hatch, and it is deliberately explicit: `html` says out loud
       that this string is NOT escaped, so it never happens by accident. */
    if (block.type === 'html') return block.html || '';
    const render = RENDERERS[block.type];
    if (!render) return '';
    if (block.type === 'divider') return divider(theme);
    if (block.type === 'button') return button(block.label, block.url, theme);
    return render(block.text === undefined ? block.value : block.text, theme);
  }).join('\n      ');

  const footer = options.footer
    ? `<p style="margin:18px 0 0;font-size:12px;line-height:1.5;color:${theme.muted};text-align:center">${escapeHtml(options.footer)}</p>`
    : '';

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${theme.background}">
  ${preheader(options.preheader)}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${theme.background};padding:28px 12px">
    <tr><td align="center">
      <table role="presentation" width="${theme.width}" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:${theme.width}px;background:${theme.surface};border-radius:10px;padding:32px;font-family:${theme.fontFamily}">
        <tr><td>
      ${body}
        </td></tr>
      </table>
      ${footer}
    </td></tr>
  </table>
</body></html>`;
}

/**
 * The same content as plain text.
 *
 * Not a courtesy. A message with no text part scores worse with spam filters,
 * and some clients — and every screen reader working from the text part — show
 * that version. Generating it from the same blocks keeps the two in step.
 */
function renderText(options = {}) {
  return (options.blocks || []).map((block) => {
    if (!block || !block.type) return '';
    if (block.type === 'divider') return '---';
    if (block.type === 'button') return `${block.label}: ${block.url}`;
    if (block.type === 'html') return '';
    return String(block.text === undefined ? block.value : block.text);
  }).filter(Boolean).join('\n\n');
}

module.exports = { renderEmail, renderText, escapeHtml, DEFAULT_THEME };
