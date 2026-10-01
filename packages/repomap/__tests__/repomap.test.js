'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { buildRepoMap, pagerank } = require('../src');

describe('@astratra/repomap', () => {
  let root;
  let cache;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'repomap-'));
    cache = new Map();
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src', 'core.js'), 'export function buildEngine() { return 1; }\nexport class Engine {}\n');
    await fs.writeFile(path.join(root, 'src', 'app.js'), "import { buildEngine } from './core';\nimport { standalone } from './island';\nexport function run() { return buildEngine() + standalone(); }\n");
    await fs.writeFile(path.join(root, 'src', 'island.js'), 'export function standalone() { return 0; }\n');
    await fs.writeFile(path.join(root, '.gitignore'), 'ignored.js\n');
    await fs.writeFile(path.join(root, 'ignored.js'), 'export function hidden() {}');
    await fs.mkdir(path.join(root, 'node_modules', 'dep'), { recursive: true });
    await fs.writeFile(path.join(root, 'node_modules', 'dep', 'index.js'), 'export function dependency() {}');
  });
  afterEach(async () => fs.rm(root, { recursive: true, force: true }));

  test('PageRank favorise une cible avec davantage de références entrantes', () => {
    const scores = pagerank([{ path: 'a' }, { path: 'b' }, { path: 'c' }], [
      { from: 'a', to: 'b', weight: 3 },
      { from: 'c', to: 'b', weight: 1 },
    ]);
    expect(scores.get('b')).toBeGreaterThan(scores.get('a'));
    expect(scores.get('b')).toBeGreaterThan(scores.get('c'));
  });

  test('personnalise PageRank pour les fichiers de la conversation', () => {
    const files = [{ path: 'a' }, { path: 'b' }];
    const uniform = pagerank(files, []);
    const personal = pagerank(files, [], { conversationFiles: ['b'] });
    expect(personal.get('b')).toBeGreaterThan(uniform.get('b'));
  });

  test('classe les fichiers référencés et expose les lignes des définitions', async () => {
    const result = await buildRepoMap(root, { cache });
    expect(result.files[0].path).toBe('src/core.js');
    expect(result.content).toContain('│ export function buildEngine() { return 1; }');
    expect(result.content).not.toContain('hidden');
    expect(result.content).not.toContain('dependency');
  });

  test('applique le poids de conversation et les identifiants mentionnés', async () => {
    const baseline = await buildRepoMap(root, { cache: new Map() });
    const conversation = await buildRepoMap(root, { cache: new Map(), conversationFiles: ['src/island.js'] });
    const mentioned = await buildRepoMap(root, { cache: new Map(), conversationFiles: ['src/island.js'], mentionedIdentifiers: ['buildEngine'] });
    const rank = (result, filePath) => result.files.find(file => file.path === filePath).rank;
    expect(rank(conversation, 'src/island.js')).toBeGreaterThan(rank(baseline, 'src/island.js'));
    expect(rank(mentioned, 'src/core.js')).toBeGreaterThan(rank(conversation, 'src/core.js'));
  });

  test('respecte le budget avec le compteur injecté', async () => {
    const result = await buildRepoMap(root, { cache, budget: 70, tokenCounter: text => text.length });
    expect(result.tokenCount).toBeLessThanOrEqual(70);
  });

  test('réutilise le cache inchangé et réanalyse après modification', async () => {
    await buildRepoMap(root, { cache });
    const cached = cache.get('src/core.js');
    await buildRepoMap(root, { cache });
    expect(cache.get('src/core.js')).toBe(cached);
    await new Promise(resolve => setTimeout(resolve, 5));
    await fs.writeFile(path.join(root, 'src', 'core.js'), 'export function buildEngine() { return 2; }\n');
    await buildRepoMap(root, { cache });
    expect(cache.get('src/core.js')).not.toBe(cached);
  });

  test('inclut Python quand le langage est demandé', async () => {
    await fs.writeFile(path.join(root, 'src', 'worker.py'), 'def process_job():\n    return 1\n');
    const result = await buildRepoMap(root, { cache, languages: ['python'] });
    expect(result.content).toContain('process_job');
  });

  test('rend les définitions partielles d’un fichier géant dans un petit budget', async () => {
    const isolated = await fs.mkdtemp(path.join(os.tmpdir(), 'repomap-giant-'));
    const declarations = Array.from({ length: 120 }, (_, index) => `export function operation${index}() { return ${index}; }`).join('\n');
    try {
      await fs.mkdir(path.join(isolated, 'src'));
      await fs.writeFile(path.join(isolated, 'src', 'giant.js'), declarations);
      const result = await buildRepoMap(isolated, { cache: new Map(), budget: 100, tokenCounter: text => text.length });
      expect(result.content).toContain('src/giant.js');
      expect(result.content).toContain('operation');
      expect(result.content).toContain('⋮');
      expect(result.tokenCount).toBeGreaterThan(0);
      expect(result.tokenCount).toBeLessThanOrEqual(100);
    } finally { await fs.rm(isolated, { recursive: true, force: true }); }
  });


  test('résout les imports relatifs, favorise le fichier définissant un nom cité et ignore les clés ordinaires', async () => {
    await fs.mkdir(path.join(root, 'src', 'models'));
    await fs.writeFile(path.join(root, 'src', 'service.js'), "import './models/invitation.model';\nimport './models/teacher';\nimport './models/families.model';\nimport '../../external-lib';\nexport function acceptInvitation() {}\n");
    await fs.writeFile(path.join(root, 'src', 'models', 'invitation.model.js'), 'export const Invitation = mongoose.model(\'Invitation\', schema);\n');
    await fs.writeFile(path.join(root, 'src', 'models', 'teacher.js'), 'export class Teacher {}\n');
    await fs.writeFile(path.join(root, 'src', 'models', 'families.model.js'), 'export class Parent {}\n');
    await fs.writeFile(path.join(root, 'src', 'unrelated.js'), "const stuff = { id: 1, staff: 2, models: 3, network: 4, same: 5 };\nconst ordinaryCall = makeObject();\nexport function helper() {}\n");
    const result = await buildRepoMap(root, { cache: new Map(), conversationFiles: ['src/service.js'], mentionedIdentifiers: ['Parent'] });
    expect(result.files.slice(0, 4).map(file => file.path)).toEqual([
      'src/service.js', 'src/models/families.model.js', 'src/models/invitation.model.js', 'src/models/teacher.js',
    ]);
    expect(result.files.find(file => file.path === 'src/unrelated.js').definitions.map(item => item.symbol)).toEqual(['helper']);
    expect(result.files.find(file => file.path === 'src/models/invitation.model.js').definitions.map(item => item.symbol)).toContain('Invitation');
    expect(result.content).toContain('│ export const Invitation = mongoose.model');
    expect(result.content).toContain('│ export class Parent {}');
  });

  test('tronque proprement les signatures à 120 caractères', async () => {
    await fs.writeFile(path.join(root, 'src', 'long.js'), `export function ${'x'.repeat(140)}() {}`);
    const result = await buildRepoMap(root, { cache: new Map(), budget: 5000 });
    const line = result.content.split('\n').find(value => value.includes('export function'));
    expect(line.length).toBeLessThanOrEqual(123);
    expect(line).toMatch(/^ {2}│ /);
  });

  test('ne capture que les définitions CommonJS du contrôleur et leurs signatures', async () => {
    await fs.writeFile(path.join(root, 'src', 'controller.js'), [
      'const audit = async (req, res) => { return res.json(req.user); };',
      'exports.acceptInvitation = async (req, res) => {',
      '  const invitation = await findInvitation(req.params.id);',
      '  const localCallback = () => validate(invitation);',
      '  await validate(invitation);',
      '  return res.json(await save(invitation));',
      '};',
      'module.exports = { rejectInvitation: function (req, res) { return res.send(req.body); } };',
      'function internalHelper() { return audit(); }',
    ].join('\n'));
    const result = await buildRepoMap(root, { cache: new Map(), budget: 5000 });
    const controller = result.files.find(file => file.path === 'src/controller.js');
    expect(controller.definitions.map(item => item.symbol).sort()).toEqual(['acceptInvitation', 'audit', 'internalHelper', 'rejectInvitation']);
    expect(controller.lines).toEqual([1, 2, 8, 9]);
    expect(result.content).toContain('│ exports.acceptInvitation = async (req, res) => {');
    expect(result.content).toContain('│ module.exports = { rejectInvitation: function (req, res) { return res.send(req.body); } };');
    expect(controller.definitions.find(item => item.symbol === 'acceptInvitation').text).toContain('exports.acceptInvitation');
  });
});
