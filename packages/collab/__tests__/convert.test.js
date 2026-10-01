const Y = require('yjs');
const { createConverter } = require('../src');

const conv = createConverter();
const MARKDOWN = '# Procédure d’accueil\n\nVérifier **l’identité** puis noter l’heure `08:00`.\n\n- badge\n- registre\n\n> Toujours sourire';

describe('conversions sans DOM', () => {
  test('Markdown → Yjs → Markdown garde le contenu', () => {
    const doc = conv.fromMarkdown(MARKDOWN);
    expect(doc).toBeInstanceOf(Y.Doc);
    expect(doc.getXmlFragment('default').length).toBeGreaterThan(0);
    expect(conv.toMarkdown(doc)).toBe(MARKDOWN);
  });

  test('JSON Tiptap ↔ Yjs, y compris depuis l’état binaire stocké', () => {
    const json = conv.markdownToJSON(MARKDOWN);
    const doc = conv.fromJSON(json);
    expect(conv.toJSON(doc)).toEqual(json);
    expect(conv.toJSON(conv.encodeState(doc))).toEqual(json);
  });

  test('HTML échappé : du texte saisi ne devient jamais du balisage', () => {
    const doc = conv.fromJSON({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '<script>alert(1)</script>' }] }]
    });
    const html = conv.toHTML(doc);
    expect(html).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });

  test('texte brut pour la recherche : blocs séparés, sans balisage', () => {
    const texte = conv.toText(conv.fromMarkdown(MARKDOWN));
    expect(texte).toContain('Procédure d’accueil\n\nVérifier l’identité puis noter l’heure 08:00.');
    expect(texte).not.toMatch(/[*#`>]/);
  });

  test('un autre fragment Yjs se choisit avec `field`', () => {
    const corps = createConverter({ field: 'corps' });
    const doc = corps.fromMarkdown('Bonjour');
    expect(doc.getXmlFragment('default').length).toBe(0);
    expect(corps.toMarkdown(doc)).toBe('Bonjour');
  });

  test('refuse une source qui n’est pas un document', () => {
    expect(() => conv.toMarkdown('texte')).toThrow(TypeError);
  });
});
