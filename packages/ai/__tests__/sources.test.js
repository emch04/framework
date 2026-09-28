const { createSourceLedger, factualSentences, findContradiction, rerankResults, usedSources } = require('../src');

describe('createSourceLedger', () => {
  test('one source from a tool carries what the tool gave; several do not share it', () => {
    const ledger = createSourceLedger();
    ledger.keep([{ kind: 'article', ref: 1, title: 'Patience', excerpt: 'La patience…' }], { body: 'long text about perseverance' });
    ledger.keep([{ kind: 'article', ref: 2, title: 'Joie' }, { kind: 'article', ref: 3, title: 'Paix' }], { body: 'shared output' });
    expect(ledger.size()).toBe(3);
    const evidence = ledger.evidence();
    expect(evidence[0]).toContain('perseverance');
    expect(evidence[1]).toBe('Joie');
    expect(evidence[2]).not.toContain('shared output');
  });

  test('the same source read twice is one source whose evidence grows', () => {
    const ledger = createSourceLedger();
    ledger.keep([{ url: 'https://a.test', title: 'A' }], 'first read');
    ledger.keep([{ url: 'https://a.test', title: 'A' }], 'second read');
    expect(ledger.sources()).toHaveLength(1);
    expect(ledger.evidence()[0]).toContain('first read');
    expect(ledger.evidence()[0]).toContain('second read');
  });
});

describe('usedSources', () => {
  const sources = [
    { title: 'Photosynthèse', url: 'https://sciences.test/photo' },
    { title: 'Volcans', url: 'https://sciences.test/volcans' },
    { title: 'Page citée', url: 'https://cite.test/page' }
  ];
  const evidence = [
    'La photosynthèse transforme lumière dioxyde carbone chlorophylle glucose oxygène',
    'Les volcans rejettent magma cendres lapilli éruption explosive',
    'autre chose'
  ];

  test('keeps the source whose distinctive words the answer takes up, and the one whose link it gives', () => {
    const answer = 'Grâce à la chlorophylle, la plante utilise la lumière et le dioxyde de carbone pour produire du glucose. Voir https://cite.test/page';
    expect(usedSources(answer, sources, evidence).map((s) => s.title)).toEqual(['Photosynthèse', 'Page citée']);
  });

  test('nothing is ever added: an answer that relies on nothing shows nothing', () => {
    expect(usedSources('Bonjour, comment puis-je aider ?', sources, evidence)).toEqual([]);
  });

  test('common words never tie a source: "because", "should" are not evidence', () => {
    const common = ['because', 'should', 'would', 'their'];
    const result = usedSources('because they should, would they?', [{ title: 'x' }], ['because should would their'], { commonWords: common });
    expect(result).toEqual([]);
  });

  test('short evidence needs two shared words, not three', () => {
    expect(usedSources('Le magma et les cendres', [{ title: 'V' }], ['magma cendres'])).toHaveLength(1);
    expect(usedSources('Le magma seulement', [{ title: 'V' }], ['magma cendres'])).toHaveLength(0);
  });

  test('a source that IS a reference is kept only when the answer names it', () => {
    const references = (text) => [...text.matchAll(/art\.\s*(\d+)/gi)].map((m) => Number(m[1]));
    const options = { references, sameReference: (a, b) => a === b, ownReference: (source) => source.article || null };
    const law = [{ title: 'Article 12', article: 12 }, { title: 'Article 40', article: 40 }];
    expect(usedSources('Selon l\'art. 12, le délai est de trente jours.', law, ['', ''], options).map((s) => s.article)).toEqual([12]);
  });

  test('without a reference reader, a reference source is kept when its title is named', () => {
    const law = [{ title: 'Article 12', article: 12 }];
    expect(usedSources('Voir Article 12.', law, [''], { ownReference: (s) => s.article })).toHaveLength(1);
    expect(usedSources('Voir la loi.', law, [''], { ownReference: (s) => s.article })).toHaveLength(0);
  });

  test('evidence naming the same place as the answer ties the passage', () => {
    const references = (text) => [...text.matchAll(/§(\d+)/g)].map((m) => m[1]);
    const kept = usedSources('Comme le dit le §7, il faut attendre.', [{ title: 'Commentaire' }], ['Ce commentaire explique le §7.'], { references, sameReference: (a, b) => a === b });
    expect(kept).toHaveLength(1);
  });
});

describe('findContradiction', () => {
  const sources = [{ content: 'Le mont Nyiragongo est entré en éruption en mai 2021 près de Goma.', url: 'https://volcan.test' }];

  test('a clear contradiction with the closest source is reported, with the sentence and the source', async () => {
    const compare = jest.fn(async (pairs) => pairs.map(() => ({ entailment: 0.05, neutral: 0.05, contradiction: 0.9 })));
    const verdict = await findContradiction('Le mont Nyiragongo est entré en éruption en mai 2002 près de Goma.', sources, { compare });
    expect(verdict).toEqual({ contradicts: true, sentence: 'Le mont Nyiragongo est entré en éruption en mai 2002 près de Goma.', source: 'https://volcan.test' });
    expect(compare.mock.calls[0][0][0]).toEqual({ premise: sources[0].content, hypothesis: expect.stringContaining('2002') });
  });

  test('a doubt is not a contradiction', async () => {
    const compare = async (pairs) => pairs.map(() => ({ entailment: 0.3, neutral: 0.2, contradiction: 0.85 }));
    expect((await findContradiction('Le mont Nyiragongo est entré en éruption près de Goma hier.', sources, { compare })).contradicts).toBe(false);
  });

  test('the model down, or too slow: null — nothing could be checked, nothing is said', async () => {
    expect(await findContradiction('Le mont Nyiragongo est entré en éruption près de Goma.', sources, { compare: async () => null })).toBeNull();
    const slow = () => new Promise((resolve) => setTimeout(() => resolve([{ contradiction: 1, entailment: 0 }]), 200));
    expect(await findContradiction('Le mont Nyiragongo est entré en éruption près de Goma.', sources, { compare: slow, timeoutMs: 20 })).toBeNull();
    expect(await findContradiction('Le mont Nyiragongo est entré en éruption près de Goma.', sources, { compare: async () => { throw new Error('x'); } })).toBeNull();
  });

  test('questions and short sentences are not claims; no overlap, no comparison', async () => {
    expect(factualSentences('Est-ce vrai ? Oui. Le volcan de Goma est très actif depuis longtemps.', 5)).toEqual(['Le volcan de Goma est très actif depuis longtemps.']);
    const compare = jest.fn();
    expect(await findContradiction('Les chats dorment beaucoup pendant la journée entière.', sources, { compare })).toEqual({ contradicts: false, sentence: null, source: null });
    expect(compare).not.toHaveBeenCalled();
  });

  test('a compare function is required', async () => {
    await expect(findContradiction('x', [], {})).rejects.toThrow(/compare/);
  });
});

describe('rerankResults', () => {
  const found = {
    results: [
      { title: 'A', content: 'loin', source: 'https://a.test' },
      { title: 'B', content: 'proche', source: 'https://b.test' },
      { title: 'C', content: 'moyen', source: 'https://c.test' }
    ],
    sources: [{ url: 'https://a.test' }, { url: 'https://b.test' }, { url: 'https://c.test' }]
  };

  test('the most relevant first, and the sources follow the same order', async () => {
    const reranked = await rerankResults('question', found, { score: async () => [0.1, 0.9, 0.5] });
    expect(reranked.results.map((r) => r.title)).toEqual(['B', 'C', 'A']);
    expect(reranked.sources.map((s) => s.url)).toEqual(['https://b.test', 'https://c.test', 'https://a.test']);
  });

  test('no scores, wrong length, or a failing scorer: the engine\'s order stays', async () => {
    for (const score of [async () => null, async () => [1], async () => { throw new Error('down'); }, async () => [1, Number.NaN, 2]]) {
      expect(await rerankResults('q', found, { score })).toBe(found);
    }
  });

  test('fewer than two results are not reranked; a scorer is required', async () => {
    const one = { results: [found.results[0]] };
    expect(await rerankResults('q', one, { score: async () => [1] })).toBe(one);
    await expect(rerankResults('q', found, {})).rejects.toThrow(/score/);
  });
});
