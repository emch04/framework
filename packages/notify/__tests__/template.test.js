const { renderEmail, renderText, escapeHtml, DEFAULT_THEME } = require('../src');

const blocks = [
  { type: 'heading', text: 'Code de modification' },
  { type: 'paragraph', text: 'Votre code :' },
  { type: 'code', value: '482915' },
  { type: 'divider' },
  { type: 'button', label: 'Ouvrir le tableau de bord', url: 'https://app.acme.cd' },
  { type: 'note', text: 'Valable dix minutes.' }
];

describe('escaping', () => {
  test('a customer named with angle brackets does not break the layout', () => {
    /* This bites long before anyone tries to attack you. */
    expect(escapeHtml('Dupont & Fils <SARL>')).toBe('Dupont &amp; Fils &lt;SARL&gt;');
  });

  test('quotes are escaped too — they sit inside inline style attributes', () => {
    expect(escapeHtml(`a"b'c`)).toBe('a&quot;b&#39;c');
  });

  test('null and undefined become empty, not the words', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  test('content reaching the document is escaped', () => {
    const html = renderEmail({ blocks: [{ type: 'paragraph', text: '<script>alert(1)</script>' }] });

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('what mail clients actually need', () => {
  test('the layout is built from tables, not modern CSS', () => {
    /* Outlook lays out HTML with Word: flexbox, grid and custom properties
       simply are not there. */
    const html = renderEmail({ blocks });

    expect(html).toMatch(/<table/);
    expect(html).not.toMatch(/display:\s*(flex|grid)/);
    expect(html).not.toMatch(/var\(--/);
  });

  test('styles are inline — Gmail strips style blocks', () => {
    const html = renderEmail({ blocks });

    expect(html).not.toMatch(/<style[\s>]/);
    expect(html).toMatch(/style="/);
  });

  test('the button is a table, so it does not collapse to a bare link in Outlook', () => {
    const html = renderEmail({ blocks: [{ type: 'button', label: 'Ouvrir', url: 'https://x.cd' }] });

    expect(html).toMatch(/<table[^>]*><tr><td[^>]*background/);
    expect(html).toContain('href="https://x.cd"');
  });

  test('a button url that is not http is neutralised', () => {
    const html = renderEmail({ blocks: [{ type: 'button', label: 'Ouvrir', url: 'javascript:alert(1)' }] });

    expect(html).not.toContain('javascript:');
    expect(html).toContain('href="#"');
  });

  test('the preheader is present and hidden', () => {
    const html = renderEmail({ blocks, preheader: 'Votre code de sécurité' });

    expect(html).toContain('Votre code de sécurité');
    expect(html).toMatch(/display:none[^"]*max-height:0/);
  });

  test('without a preheader nothing is injected', () => {
    expect(renderEmail({ blocks })).not.toMatch(/display:none/);
  });

  test('the theme colours are applied', () => {
    const html = renderEmail({ blocks, theme: { accent: '#ff0066', surface: '#101010' } });

    expect(html).toContain('#ff0066');
    expect(html).toContain('#101010');
    /* An unspecified token still falls back to the default. */
    expect(html).toContain(DEFAULT_THEME.background);
  });

  test('a footer is rendered when given', () => {
    expect(renderEmail({ blocks, footer: 'Acme SARL, Kinshasa' })).toContain('Acme SARL, Kinshasa');
  });

  test('an unknown block type is skipped rather than crashing the send', () => {
    expect(() => renderEmail({ blocks: [{ type: 'carousel' }, null, {}] })).not.toThrow();
  });

  test('raw html is an explicit escape hatch, so it never happens by accident', () => {
    const html = renderEmail({ blocks: [{ type: 'html', html: '<em>brut</em>' }] });

    expect(html).toContain('<em>brut</em>');
  });

  test('an empty message still produces a valid document', () => {
    const html = renderEmail({});

    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toMatch(/<\/html>$/);
  });
});

describe('the plain text version', () => {
  test('carries the same content', () => {
    /* Not a courtesy: a message with no text part scores worse with spam
       filters, and some readers only ever see that version. */
    const text = renderText({ blocks });

    expect(text).toContain('Code de modification');
    expect(text).toContain('482915');
    expect(text).toContain('Valable dix minutes.');
  });

  test('a button becomes a readable link', () => {
    expect(renderText({ blocks })).toContain('Ouvrir le tableau de bord: https://app.acme.cd');
  });

  test('no html tags leak into it', () => {
    expect(renderText({ blocks: [...blocks, { type: 'html', html: '<em>x</em>' }] })).not.toMatch(/<[a-z]/i);
  });

  test('an empty message yields an empty string, not "undefined"', () => {
    expect(renderText({})).toBe('');
  });
});
