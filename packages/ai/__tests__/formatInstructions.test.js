const { createFormatInstructions, DEFAULT_SURFACES } = require('../src');

/* Caller-supplied wording, ported from a French production prompt. */
const fr = {
  heading: '## Où part ta réponse — RÈGLE DE FORME',
  intro: "Ta réponse s'affiche sur {surface}.",
  surfaceNames: { phone: 'un téléphone', tablet: 'une tablette', desktop: 'un navigateur de bureau' },
  table: 'Un tableau tient au maximum {columns} colonnes COURTES sur cette surface.',
  narrow: "Sur un téléphone, préfère la liste dès qu'il y a le moindre doute.",
  wide: 'Sur un grand écran le tableau reste réservé aux données réellement tabulaires.',
  paragraphs: 'ÉCRIS EN PARAGRAPHES : une idée par paragraphe, deux à quatre phrases complètes, une ligne vide entre deux paragraphes, jamais de trait (---). Chaque phrase va au bout de son idée — jamais une phrase lancée puis laissée en suspens.',
  rules: ['Jamais de tableau pour UN seul élément.']
};
const en = { paragraphs: 'WRITE IN PARAGRAPHS: one idea each, complete sentences, never a horizontal rule (---).', table: 'At most {columns} columns.' };

const format = createFormatInstructions({ languages: { fr, en }, fallbackLanguage: 'fr' });

describe('format instructions', () => {
  test.each(['phone', 'tablet', 'desktop'])('on %s the paragraph rule is always present', (surface) => {
    const text = format.build(surface, 'fr');
    expect(text).toMatch(/ÉCRIS EN PARAGRAPHES/);
    expect(text).toMatch(/une idée par paragraphe/);
    expect(text).toMatch(/phrases complètes/);
    expect(text).toMatch(/jamais de trait \(---\)/);
    expect(text).toMatch(/jamais une phrase lancée puis laissée en suspens/);
  });

  test('columns and surface name follow the surface', () => {
    expect(format.build('phone', 'fr')).toContain('au maximum 3 colonnes');
    expect(format.build('tablet', 'fr')).toContain('au maximum 4 colonnes');
    expect(format.build('desktop', 'fr')).toContain('au maximum 6 colonnes');
    expect(format.build('desktop', 'fr')).toContain("s'affiche sur un navigateur de bureau.");
  });

  test('a narrow surface gets the list rule, a wide one the table rule', () => {
    expect(format.build('phone', 'fr')).toContain('préfère la liste');
    expect(format.build('phone', 'fr')).not.toContain('grand écran');
    expect(format.build('desktop', 'fr')).toContain('grand écran');
    expect(format.build('desktop', 'fr')).not.toContain('préfère la liste');
  });

  test('missing or unknown surface means the phone — the cautious guess', () => {
    for (const value of [null, undefined, '', 'unknown value', 42]) {
      expect(format.normalizeSurface(value)).toBe('phone');
    }
    expect(format.normalizeSurface(' Mobile ')).toBe('phone');
    expect(format.normalizeSurface('iPad')).toBe('tablet');
    expect(format.normalizeSurface('web')).toBe('desktop');
  });

  test('each language uses its own wording; unknown language falls back', () => {
    expect(format.build('phone', 'en')).toMatch(/^- At most 3 columns\.\n- WRITE IN PARAGRAPHS/);
    expect(format.build('phone', 'xx')).toMatch(/ÉCRIS EN PARAGRAPHES/);
  });

  test('a language pack without a paragraphs rule is refused at creation', () => {
    expect(() => createFormatInstructions({ languages: { fr, de: { table: 'x' } } })).toThrow(/"de".*paragraphs/);
    expect(() => createFormatInstructions({})).toThrow(/language pack/);
  });

  test('custom surfaces and default are honoured', () => {
    const custom = createFormatInstructions({
      languages: { en },
      surfaces: { watch: { columns: 1, narrow: true }, tv: { columns: 8 } },
      defaultSurface: 'watch'
    });
    expect(custom.normalizeSurface('phone')).toBe('watch');
    expect(custom.build('tv', 'en')).toContain('At most 8 columns.');
    expect(() => createFormatInstructions({ languages: { en }, defaultSurface: 'fridge' })).toThrow(/fridge/);
  });

  test('default surfaces are exported for reuse', () => {
    expect(DEFAULT_SURFACES.phone.columns).toBe(3);
  });
});
