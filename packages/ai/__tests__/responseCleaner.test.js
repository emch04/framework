const { createResponseCleaner } = require('../src');

/* The vocabulary below is CALLER data: it is what a French-speaking product
   ported from production passes in. The package itself holds no word. */
const shared = {
  payloadKeys: ['response', 'message', 'content', 'text', 'answer', 'reformulatedMessage'],
  titleKeys: ['title', 'heading', 'subject', 'name', 'section'],
  lineLabels: [
    'title', 'subtitle', 'introduction', 'intro', 'overview', 'summary', 'features', /key[ _]features/,
    'benefits', 'conclusion', /call[ _]to[ _]action/, 'pricing', 'plans', /next[ _]steps/
  ],
  inlineLabels: ['salutation', 'question', 'description', 'offer', 'details', 'invitation'],
  reasoningLabels: [/Draft\s*\d*/, 'Persona', /Constraints?/, 'Tone', 'Thinking', 'Reasoning', 'Plan', /Step\s*\d+/, 'Self-Correction', 'Note'],
  reasoningStarters: ['Wait', 'Actually', 'Okay', /Let'?s(?: us)?/, 'Hmm', "Let me", 'I need to'],
  finalMarkers: [/Final\s*(?:answer|version|response|draft|polish)/],
  planningStarters: ['I will', "I'll", 'Let me', 'First', 'Next'],
  leadingFillers: ['Okay', 'Alright', 'OK'],
  annotationMarkers: ['Too ', 'Violates ']
};

const fr = {
  payloadKeys: ['réponse', 'reponse', 'contenu', 'texte'],
  titleKeys: ['titre', 'nom', 'sujet'],
  inlineLabels: ['offre', 'détails', /pour [ée]coles/],
  headingLabels: [
    /r[ée]sum[ée](?:\s+de\s+(?:notre|cet?)\s+[ée]change)?/, /exemple\s+concret(?:\s+pour\s+(?:toi|vous))?/,
    /prochaines?\s+[ée]tapes?/, /autres?\s+sujets?/
  ],
  planningStarters: ['Je vais', "D'abord", 'Ensuite'],
  leadingFillers: ['Bon'],
  closingPhrases: [
    /Comment puis-je (?:t'|vous )(?:aider|assister)[^.?!]*[.?!]?/,
    /N'h[ée]site[zs]?\s+(?:pas |surtout pas )[^.]*[.!]/,
    /Je (?:reste|suis) [àa] (?:ta|votre) disposition[^.]*[.!]?/,
    /Besoin d'autre chose[^.?!]*[.?!]?/,
    /Dis[- ]moi ce que tu imagines[^.?!]*[.?!]?/,
    /Tu veux (?:une autre|un autre)[^?!.]*[?!.]?/
  ],
  openers: ["C'est parti", 'Allons-y', 'Génial', 'Avec plaisir']
};

const cleaner = createResponseCleaner({ shared, languages: { fr }, fallbackLanguage: 'fr' });
const clean = (text) => cleaner.clean(text, { language: 'fr' });

const document = {
  title: 'Présentation du produit',
  introduction: 'Une solution tout-en-un.',
  features: ['Gestion des notes', { name: 'Présences', description: 'marquage quotidien' }],
  conclusion: 'Merci de votre attention.'
};

describe('JSON leaks become prose WITHOUT their keys', () => {
  test('an object is rendered with no key left on screen', () => {
    const text = clean(JSON.stringify(document));
    for (const key of ['title', 'introduction', 'features', 'conclusion', 'name', 'description']) {
      expect(text).not.toMatch(new RegExp(`\\b${key}\\b`, 'i'));
    }
    expect(text).toContain('**Présentation du produit**');
    expect(text).toContain('Une solution tout-en-un.');
    expect(text).toContain('- Gestion des notes');
    expect(text).toContain('- **Présences** — marquage quotidien');
    expect(text).toContain('Merci de votre attention.');
    expect(text).not.toMatch(/[{}[\]"]/);
  });

  test('the payload field of a wrapper IS the answer', () => {
    expect(clean('{"role": "assistant", "response": "Tout va bien !"}')).toBe('Tout va bien !');
    expect(clean('{"reformulatedMessage": "Bonjour, voici le point."}')).toBe('Bonjour, voici le point.');
  });

  test('a payload key from the language pack is honoured too', () => {
    expect(clean('{"auteur": "x", "réponse": "Voici la réponse."}')).toBe('Voici la réponse.');
  });

  test('JSON inside a markdown fence', () => {
    const text = clean('```json\n{"nom": "Paul", "score": 72}\n```');
    expect(text).not.toContain('```');
    expect(text).toContain('Paul');
    expect(text).toContain('72');
  });

  test('trailing commas and single quotes are repaired, not shown', () => {
    expect(clean('{"nom": "Aïcha", "note": 88,}')).not.toContain('{');
    expect(clean("{'nom': 'Aïcha', 'note': 88,}")).toContain('Aïcha');
  });

  test('a short preamble followed by a JSON block keeps the preamble', () => {
    const text = clean('Voici le résumé :\n{"title": "Bilan", "summary": "Tout est à jour."}');
    expect(text).toBe('Voici le résumé :\n\n**Bilan**\n\nTout est à jour.');
  });

  test('unparseable structured JSON still loses its keys', () => {
    const text = clean('{"alpha": "un", "beta": "deux", "gamma": "trois" oops');
    expect(text).not.toMatch(/alpha|beta|gamma/);
    expect(text).toContain('un');
    expect(text).toContain('trois');
  });

  test('a JSON fragment pasted inside prose is converted in place', () => {
    const text = clean('Le résultat : {"total": 3, "unit": "élèves"} pour ce mois.');
    expect(text).not.toMatch(/total|unit|[{}]/);
    expect(text).toContain('3');
    expect(text).toContain('élèves');
  });

  test('jsonToProse is exposed for tool results shown as text', () => {
    expect(cleaner.jsonToProse([{ titre: 'A', detail: 'b' }], 'fr')).toBe('- **A** — b');
  });
});

describe('labels copied by the model', () => {
  test('document labels at line start vanish, content stays', () => {
    const raw = '**title** : Présentation\n**introduction** : Une solution tout-en-un.\n**features** :\n- Gestion des notes';
    const text = clean(raw);
    expect(text).not.toMatch(/\b(title|introduction|features)\b/i);
    expect(text).toContain('Présentation');
    expect(text).toContain('Une solution tout-en-un.');
    expect(text).toContain('- Gestion des notes');
  });

  test('the same word inside a sentence is not touched', () => {
    const sentence = 'Voici une introduction : le produit gère les notes.';
    expect(clean(sentence)).toBe(sentence);
  });

  test('a leading payload label is stripped', () => {
    expect(clean('**reformulatedMessage** : Bonjour, voici le point.')).toBe('Bonjour, voici le point.');
  });

  test('form-like inline labels are stripped anywhere', () => {
    const text = clean('**salutation** : Salut ! **question** : Tu veux en savoir plus ? **offer** : Un aperçu. **pour ecoles** : Notes et paiements.');
    expect(text).not.toMatch(/salutation|question|offer|pour ecoles/i);
    expect(text).toContain('Notes et paiements.');
  });

  test.each([
    ['**Résumé de notre échange :**\nJ’ai généré une image.', 'Résumé de notre échange'],
    ['**Exemple concret pour toi** :\nLes images disparaissent.', 'Exemple concret'],
    ['**Prochaine étape**\nChoisis une option.', 'Prochaine étape'],
    ['**Autres sujets**\nRien d’autre.', 'Autres sujets']
  ])('heading label "%s" is removed, bold or not, colon or not', (raw, label) => {
    const text = clean(raw);
    expect(text).not.toMatch(new RegExp(label, 'i'));
    expect(text.length).toBeGreaterThan(5);
  });
});

describe('reasoning drafts', () => {
  test('closed and unclosed think blocks', () => {
    expect(clean('<think>je réfléchis</think>Voilà la réponse.')).toBe('Voilà la réponse.');
    expect(clean('<think>je réfléchis encore')).toBe('');
  });

  test('only what follows the LAST reasoning line is kept', () => {
    const raw = 'Draft 1: Bonjour.\nWait, too cold.\nActually, better:\nLes notes sont bonnes.';
    expect(clean(raw)).toBe('Les notes sont bonnes.');
  });

  test('a final marker keeps the answer on the same line', () => {
    expect(clean('Draft: bof\nFinal answer: Les notes sont bonnes.')).toBe('Les notes sont bonnes.');
  });

  test('planning bullets are removed', () => {
    expect(clean('- Je vais chercher les données\n- Ensuite je compare\nLes notes sont bonnes.')).toBe('Les notes sont bonnes.');
  });

  test('a leading filler is removed, "Bonjour" is not "Bon"', () => {
    expect(clean('Okay, je regarde.\nVoici les résultats.')).toBe('Voici les résultats.');
    expect(clean('Alright, voici les résultats.')).toBe('voici les résultats.');
    expect(clean('Bonjour, comment ça va ?')).toBe('Bonjour, comment ça va ?');
  });

  test('meta annotations in parentheses are removed', () => {
    const text = clean('Bonne réponse.\n(Too robotic, rephrase)\nMeilleure réponse.');
    expect(text).not.toContain('Too robotic');
    expect(text).toContain('Meilleure réponse.');
  });
});

describe('robotic closings and openers', () => {
  test.each([
    "Comment puis-je t'aider ?",
    "N'hésitez surtout pas à me solliciter.",
    'Je reste à ta disposition.',
    "Besoin d'autre chose ?",
    'Dis-moi ce que tu imagines, et je le fais !',
    'Tu veux une autre version ?'
  ])('closing "%s" is cut, the answer survives', (ending) => {
    expect(clean(`Les résultats sont bons. ${ending}`)).toBe('Les résultats sont bons.');
  });

  test('stacked closings are all removed', () => {
    expect(clean("Les résultats sont bons. Besoin d'autre chose ? N'hésite pas à demander."))
      .toBe('Les résultats sont bons.');
  });

  test('a concrete, related offer stays', () => {
    const text = "L'image est prête. Je peux la refaire en noir et blanc si tu veux.";
    expect(clean(text)).toBe(text);
  });

  test('excited openers are removed', () => {
    expect(clean("C'est parti ! Les résultats sont bons.")).toBe('Les résultats sont bons.');
  });

  test('a normal exclamation stays', () => {
    expect(clean('Salut ! Voici le point.')).toBe('Salut ! Voici le point.');
  });

  test('a normal reply crosses untouched', () => {
    const text = 'Trois parents ont des frais impayés ce mois-ci, pour un total de 240 dollars.';
    expect(clean(text)).toBe(text);
  });
});

describe('languages and whitespace', () => {
  test('a language vocabulary does not leak into another language', () => {
    const multi = createResponseCleaner({ shared, languages: { fr, en: { closingPhrases: ['Let me know if you need anything else.'] } } });
    expect(multi.clean('Done. Let me know if you need anything else.', { language: 'en' })).toBe('Done.');
    expect(multi.clean("Fait. Besoin d'autre chose ?", { language: 'en' })).toBe("Fait. Besoin d'autre chose ?");
    expect(multi.clean("Fait. Besoin d'autre chose ?", { language: 'fr' })).toBe('Fait.');
  });

  test('an unknown language falls back', () => {
    expect(cleaner.clean("Fait. Besoin d'autre chose ?", { language: 'xx' })).toBe('Fait.');
  });

  test('with no vocabulary at all, only the structural cleaning runs', () => {
    const bare = createResponseCleaner();
    expect(bare.clean('<think>x</think>{"a": "un", "b": "deux"}')).toBe('un\n\ndeux');
    expect(bare.clean('A\n\n\n\nB   C')).toBe('A\n\nB C');
    expect(bare.clean(null)).toBe('');
  });

  test('literal entries are escaped, not read as regex', () => {
    const c = createResponseCleaner({ shared: { closingPhrases: ['(ok?)'] } });
    expect(c.clean('Fait. (ok?)')).toBe('Fait.');
    expect(c.clean('Fait. ok')).toBe('Fait. ok');
  });
});
