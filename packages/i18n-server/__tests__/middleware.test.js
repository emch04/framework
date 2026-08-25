const express = require('express');
const request = require('supertest');
const {
  createLanguageResolver,
  createMessageCatalog,
  createTranslationMiddleware
} = require('../src');

const catalog = createMessageCatalog({
  languages: ['fr', 'en', 'es'],
  messages: {
    'Cet élève est introuvable.': { en: 'This student could not be found.', es: 'No se encuentra a este alumno.' }
  }
});

const resolver = createLanguageResolver({ languages: ['fr', 'en', 'es'] });

function build(options = {}) {
  const app = express();
  app.use(createTranslationMiddleware({ catalog, resolver, ...options }));

  app.get('/found', (_req, res) => res.json({ success: false, message: 'Cet élève est introuvable.' }));
  app.get('/unknown', (_req, res) => res.json({ success: false, message: 'Une phrase absente.' }));
  app.get('/with-data', (_req, res) => res.json({
    success: false,
    message: 'Cet élève est introuvable.',
    data: { message: 'Cet élève est introuvable.', name: 'Jean' }
  }));
  app.get('/title', (_req, res) => res.json({ title: 'Cet élève est introuvable.', message: 'Cet élève est introuvable.' }));
  app.get('/language', (req, res) => res.json({ seen: req.language }));
  app.get('/array', (_req, res) => res.json([{ message: 'Cet élève est introuvable.' }]));
  app.get('/nothing', (_req, res) => res.json(null));

  return app;
}

const ask = (app, path, language) =>
  (language ? request(app).get(path).set('Accept-Language', language) : request(app).get(path));

describe('translation middleware', () => {
  test('translates the message on the way out, with no change to the controller', async () => {
    const response = await ask(build(), '/found', 'en').expect(200);

    expect(response.body.message).toBe('This student could not be found.');
    expect(response.body.success).toBe(false);
  });

  test('leaves the source language untouched', async () => {
    const response = await ask(build(), '/found', 'fr').expect(200);

    expect(response.body.message).toBe('Cet élève est introuvable.');
  });

  test('with no header at all, the source language is served', async () => {
    const response = await ask(build(), '/found').expect(200);

    expect(response.body.message).toBe('Cet élève est introuvable.');
  });

  test('a sentence outside the catalogue comes back as written', async () => {
    const response = await ask(build(), '/unknown', 'es').expect(200);

    expect(response.body.message).toBe('Une phrase absente.');
  });

  test('NEVER touches the data payload — translating a value would corrupt it', async () => {
    const response = await ask(build(), '/with-data', 'en').expect(200);

    expect(response.body.message).toBe('This student could not be found.');
    expect(response.body.data.message).toBe('Cet élève est introuvable.');
    expect(response.body.data.name).toBe('Jean');
  });

  test('only the named fields are translated', async () => {
    const response = await ask(build({ fields: ['message', 'title'] }), '/title', 'es').expect(200);

    expect(response.body.title).toBe('No se encuentra a este alumno.');
    expect(response.body.message).toBe('No se encuentra a este alumno.');
  });

  test('the resolved language is attached to the request', async () => {
    expect((await ask(build(), '/language', 'es').expect(200)).body.seen).toBe('es');
    expect((await ask(build(), '/language').expect(200)).body.seen).toBe('fr');
  });

  test('an array or a null body passes through untouched', async () => {
    const app = build();

    expect((await ask(app, '/array', 'en').expect(200)).body[0].message).toBe('Cet élève est introuvable.');
    await ask(app, '/nothing', 'en').expect(200);
  });

  test('the attached property can be renamed', async () => {
    const app = express();
    app.use(createTranslationMiddleware({ catalog, resolver, attach: 'lang' }));
    app.get('/x', (req, res) => res.json({ seen: req.lang }));

    expect((await request(app).get('/x').set('Accept-Language', 'en')).body.seen).toBe('en');
  });

  test('wiring without a catalog or a resolver is refused up front', () => {
    expect(() => createTranslationMiddleware({ resolver })).toThrow(/catalog/);
    expect(() => createTranslationMiddleware({ catalog })).toThrow(/resolver/);
  });
});
