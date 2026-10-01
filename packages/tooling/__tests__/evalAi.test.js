const fs = require('fs');
const path = require('path');
const { DEFAULT_CONFIG } = require('../src/config');
const {
  buildProvider, buildPromptfooConfig, findPromptfoo, loadCases, runEval, summarizeEval
} = require('../src/commands/evalAi');
const { runCli } = require('../src/cli');
const { createOutput, createTempProject, writeJson, writeFile } = require('./helpers');

const CASES = {
  prompt: 'Réponds : {{question}}',
  cases: [
    { description: 'capitale', vars: { question: 'capitale de la RDC' }, assert: [{ type: 'icontains', value: 'kinshasa' }] },
    { description: 'écho', vars: { question: 'Kinshasa' }, assert: [{ type: 'icontains', value: 'kinshasa' }] }
  ]
};

function project(cases = CASES) {
  const rootDir = createTempProject();
  writeJson(rootDir, 'evals/cases.json', cases);
  return rootDir;
}

/** Doublure de promptfoo : écrit le résultat que promptfoo écrirait, sans rien lancer. */
function fakeRunner(rows, { code = 100 } = {}) {
  const calls = [];
  const runProcess = async (command, args, options) => {
    calls.push({ command, args, options });
    const out = args[args.indexOf('-o') + 1];
    if (rows) fs.writeFileSync(out, JSON.stringify({ results: { results: rows } }));
    return { code, stdout: '', stderr: 'boom' };
  };
  return { runProcess, calls };
}
const row = (id, success, extra = {}) => ({ provider: { id }, success, testCase: { description: extra.description || 'cas' }, vars: {}, gradingResult: { reason: extra.reason || 'raté' }, ...extra });

describe('jeu de cas', () => {
  test('accepte un tableau ou { prompt, cases }', () => {
    const rootDir = project();
    expect(loadCases(path.join(rootDir, 'evals/cases.json'))).toMatchObject({ prompt: 'Réponds : {{question}}', cases: { length: 2 } });
    writeJson(rootDir, 'a.json', CASES.cases);
    expect(loadCases(path.join(rootDir, 'a.json')).prompt).toBeNull();
  });
  test('refuse : illisible, vide, sans vars, sans assertion', () => {
    const rootDir = createTempProject();
    writeFile(rootDir, 'x.json', '{pas du json');
    expect(() => loadCases(path.join(rootDir, 'x.json'))).toThrow(expect.objectContaining({ code: 'EVAL_CASES_UNREADABLE' }));
    writeJson(rootDir, 'v.json', { cases: [] });
    expect(() => loadCases(path.join(rootDir, 'v.json'))).toThrow(expect.objectContaining({ code: 'EVAL_CASES_EMPTY' }));
    writeJson(rootDir, 'nv.json', [{ assert: [{ type: 'contains' }] }]);
    expect(() => loadCases(path.join(rootDir, 'nv.json'))).toThrow(expect.objectContaining({ code: 'EVAL_CASE_INVALID' }));
    // Un cas sans assertion réussirait toujours : il fausserait le taux de réussite.
    writeJson(rootDir, 'na.json', [{ vars: { q: 1 } }]);
    expect(() => loadCases(path.join(rootDir, 'na.json'))).toThrow(expect.objectContaining({ code: 'EVAL_CASE_INVALID' }));
    writeJson(rootDir, 'nt.json', [{ vars: { q: 1 }, assert: [{ value: 'x' }] }]);
    expect(() => loadCases(path.join(rootDir, 'nt.json'))).toThrow(expect.objectContaining({ code: 'EVAL_CASE_INVALID' }));
  });
});

describe('fournisseur et configuration promptfoo', () => {
  test('identifiant seul, ou avec serveur compatible OpenAI : le NOM de la variable de clé, jamais la clé', () => {
    expect(buildProvider({ id: 'echo' })).toBe('echo');
    expect(buildProvider({ id: 'openai:chat:local', baseUrl: 'http://127.0.0.1:8080/v1', apiKeyEnv: 'LLAMA_API_KEY', model: 'local' }))
      .toEqual({ id: 'openai:chat:local', config: { apiBaseUrl: 'http://127.0.0.1:8080/v1', apiKeyEnvar: 'LLAMA_API_KEY', model: 'local' } });
    expect(() => buildProvider({})).toThrow(expect.objectContaining({ code: 'EVAL_PROVIDER_REQUIRED' }));
  });
  test('configuration promptfoo : un prompt, les fournisseurs, les cas tels quels', () => {
    expect(buildPromptfooConfig({ description: 'd', prompt: 'p', providers: ['echo'], cases: CASES.cases }))
      .toEqual({ description: 'd', prompts: ['p'], providers: ['echo'], tests: CASES.cases });
  });
  test('findPromptfoo retrouve le binaire installé', () => {
    const entry = findPromptfoo(createTempProject());
    expect(entry).toMatch(/promptfoo[\\/]dist[\\/]src[\\/]entrypoint\.js$/);
    expect(fs.existsSync(entry)).toBe(true);
  });
});

describe('résumé', () => {
  test('compte réussites, échecs et erreurs par fournisseur', () => {
    const summaries = summarizeEval({ results: { results: [row('a', true), row('a', false, { description: 'x', reason: 'pas Kinshasa' }), row('a', false, { error: 'HTTP 500', failureReason: 2, gradingResult: null }), row('b', true)] } });
    expect(summaries).toEqual([
      expect.objectContaining({ provider: 'a', passed: 1, failed: 1, errors: 1, total: 3, failures: [{ description: 'x', reason: 'pas Kinshasa' }, { description: 'cas', reason: 'HTTP 500' }] }),
      expect.objectContaining({ provider: 'b', passed: 1, total: 1, passRate: 1 })
    ]);
    expect(summaries[0].passRate).toBeCloseTo(1 / 3);
    expect(summarizeEval({})).toEqual([]);
  });
});

describe('commande eval (promptfoo doublé)', () => {
  test('lance promptfoo avec la config générée, sans télémétrie ni écriture, et réussit au seuil', async () => {
    const rootDir = project();
    const { runProcess, calls } = fakeRunner([row('echo', true), row('echo', true)], { code: 0 });
    const output = createOutput();
    const result = await runEval(rootDir, DEFAULT_CONFIG, { provider: 'echo', runProcess, promptfooEntry: '/x/entry.js', output });
    expect(result.exitCode).toBe(0);
    expect(calls[0].command).toBe(process.execPath);
    expect(calls[0].args).toEqual(['/x/entry.js', 'eval', '-c', result.configFile, '-o', result.resultFile, '--no-cache', '--no-write']);
    expect(calls[0].options.env).toMatchObject({ PROMPTFOO_DISABLE_TELEMETRY: '1', PROMPTFOO_DISABLE_UPDATE: '1', PROMPTFOO_DISABLE_SHARING: '1' });
    const written = JSON.parse(fs.readFileSync(result.configFile, 'utf8'));
    expect(written).toMatchObject({ prompts: ['Réponds : {{question}}'], providers: ['echo'], tests: CASES.cases });
    expect(output.lines.join('\n')).toContain('echo : 2/2 réussis');
  });
  test('échec sous le seuil : exit 1 et les cas ratés sont listés ; --min-pass le règle', async () => {
    const rootDir = project();
    const rows = [row('echo', true), row('echo', false, { description: 'capitale', reason: 'Kinshasa absent' })];
    const output = createOutput();
    const strict = await runEval(rootDir, DEFAULT_CONFIG, { provider: 'echo', runProcess: fakeRunner(rows).runProcess, promptfooEntry: 'e', output });
    expect(strict.exitCode).toBe(1);
    expect(output.lines.join('\n')).toContain('capitale : Kinshasa absent');
    const lenient = await runEval(rootDir, DEFAULT_CONFIG, { provider: 'echo', 'min-pass': '0.5', runProcess: fakeRunner(rows).runProcess, promptfooEntry: 'e', output: createOutput() });
    expect(lenient.exitCode).toBe(0);
    await expect(runEval(rootDir, DEFAULT_CONFIG, { provider: 'echo', 'min-pass': '2', runProcess: fakeRunner(rows).runProcess, promptfooEntry: 'e', output })).rejects.toMatchObject({ code: 'EVAL_THRESHOLD_INVALID' });
  });
  test('fournisseurs de la config, serveur compatible OpenAI et clé par variable', async () => {
    const rootDir = project();
    const config = { ...DEFAULT_CONFIG, eval: { providers: [{ id: 'openai:chat:local', baseUrl: 'http://h:8080/v1', apiKeyEnv: 'LLAMA_API_KEY' }, 'echo'], minPassRate: 0.5 } };
    const { runProcess } = fakeRunner([row('echo', true)]);
    const result = await runEval(rootDir, config, { runProcess, promptfooEntry: 'e', output: createOutput() });
    const written = JSON.parse(fs.readFileSync(result.configFile, 'utf8'));
    expect(written.providers).toEqual([{ id: 'openai:chat:local', config: { apiBaseUrl: 'http://h:8080/v1', apiKeyEnvar: 'LLAMA_API_KEY' } }, 'echo']);
    expect(JSON.stringify(written)).not.toMatch(/sk-|Bearer/);
  });
  test('erreurs : aucun fournisseur, promptfoo absent, aucun résultat écrit', async () => {
    const rootDir = project();
    const base = { promptfooEntry: 'e', output: createOutput() };
    await expect(runEval(rootDir, DEFAULT_CONFIG, { ...base, runProcess: fakeRunner(null).runProcess })).rejects.toMatchObject({ code: 'EVAL_PROVIDER_REQUIRED' });
    await expect(runEval(rootDir, DEFAULT_CONFIG, { provider: 'echo', ...base, promptfooEntry: null, runProcess: fakeRunner(null).runProcess })).rejects.toMatchObject({ code: 'EVAL_PROMPTFOO_MISSING' });
    await expect(runEval(rootDir, DEFAULT_CONFIG, { provider: 'echo', ...base, runProcess: fakeRunner(null).runProcess })).rejects.toMatchObject({ code: 'EVAL_RUN_FAILED' });
  });
  test('un résultat périmé d’une exécution précédente n’est jamais relu', async () => {
    const rootDir = project();
    const first = await runEval(rootDir, DEFAULT_CONFIG, { provider: 'echo', runProcess: fakeRunner([row('echo', true), row('echo', true)]).runProcess, promptfooEntry: 'e', output: createOutput() });
    expect(first.exitCode).toBe(0);
    await expect(runEval(rootDir, DEFAULT_CONFIG, { provider: 'echo', runProcess: fakeRunner(null).runProcess, promptfooEntry: 'e', output: createOutput() })).rejects.toMatchObject({ code: 'EVAL_RUN_FAILED' });
  });
});

describe('vrai promptfoo (fournisseur « echo », hors ligne)', () => {
  test('évalue le jeu d’exemple : un cas réussit, un cas échoue, via la CLI', async () => {
    const rootDir = project();
    const output = createOutput();
    const result = await runEval(rootDir, DEFAULT_CONFIG, { provider: 'echo', output });
    // « echo » renvoie le prompt : « capitale de la RDC » ne contient pas Kinshasa, « Kinshasa » oui.
    expect(result.summaries).toEqual([expect.objectContaining({ provider: 'echo', passed: 1, failed: 1, total: 2 })]);
    expect(result.exitCode).toBe(1);
    const viaCli = await runCli(['eval', '--provider=echo', '--min-pass=0.5'], { rootDir, config: DEFAULT_CONFIG });
    expect(viaCli.exitCode).toBe(0);
  }, 120_000);
});
