const fs = require('fs');
const path = require('path');
const colors = require('../colors');
const { mergeConfig } = require('../config');
const { ToolingError } = require('../errors');
const { runProcess } = require('../processRunner');

const EVAL_DEFAULTS = {
  cases: 'evals/cases.json',
  prompt: '{{question}}',
  providers: [],
  outputDir: '.astratra-evals',
  minPassRate: 1
};

// Pas de télémétrie, pas de vérification de mise à jour, pas de partage en ligne : une évaluation reste locale.
const PROMPTFOO_ENV = {
  PROMPTFOO_DISABLE_TELEMETRY: '1',
  PROMPTFOO_DISABLE_UPDATE: '1',
  PROMPTFOO_DISABLE_SHARING: '1'
};

/**
 * Cherche promptfoo (MIT, devDependency) à partir du projet puis de ce paquet.
 * Lance son point d'entrée avec `node` : pas de shell, pas de `npx` qui
 * téléchargerait une version au hasard.
 */
function findPromptfoo(rootDir) {
  for (const start of [rootDir, __dirname]) {
    for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
      const manifest = path.join(dir, 'node_modules', 'promptfoo', 'package.json');
      if (fs.existsSync(manifest)) {
        const { bin } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        const entry = typeof bin === 'string' ? bin : bin && (bin.promptfoo || Object.values(bin)[0]);
        if (entry) {
          return path.join(path.dirname(manifest), entry);
        }
      }
      if (path.dirname(dir) === dir) {
        break;
      }
    }
  }
  return null;
}

/** Jeu de cas : `[cas…]` ou `{ prompt?, cases: [cas…] }`. Un cas sans assertion passerait toujours : refusé. */
function loadCases(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ToolingError('EVAL_CASES_UNREADABLE', `Jeu de cas illisible (${file}) : ${error.message}`, 400);
  }
  const cases = Array.isArray(raw) ? raw : raw && raw.cases;
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new ToolingError('EVAL_CASES_EMPTY', `Aucun cas dans ${file}`, 400);
  }
  cases.forEach((testCase, index) => {
    const label = testCase && testCase.description ? `« ${testCase.description} »` : `n°${index + 1}`;
    if (!testCase || typeof testCase.vars !== 'object' || testCase.vars === null) {
      throw new ToolingError('EVAL_CASE_INVALID', `Cas ${label} : « vars » (objet) manquant`, 400);
    }
    if (!Array.isArray(testCase.assert) || testCase.assert.length === 0 || testCase.assert.some((a) => !a || typeof a.type !== 'string')) {
      throw new ToolingError('EVAL_CASE_INVALID', `Cas ${label} : au moins une assertion { type, value } est obligatoire`, 400);
    }
  });
  return { cases, prompt: Array.isArray(raw) ? null : raw.prompt || null };
}

/**
 * Fournisseur promptfoo. `baseUrl` pointe un serveur compatible OpenAI
 * (llama.cpp, LiteLLM…) ; la clé n'est jamais écrite : on donne le NOM de la
 * variable d'environnement (`apiKeyEnvar`).
 */
function buildProvider({ id, baseUrl, apiKeyEnv, model, config = {} }) {
  if (!id) {
    throw new ToolingError('EVAL_PROVIDER_REQUIRED', 'Aucun fournisseur : --provider=<id promptfoo> ou eval.providers dans la config', 400);
  }
  const extra = {
    ...config,
    ...(baseUrl ? { apiBaseUrl: baseUrl } : {}),
    ...(apiKeyEnv ? { apiKeyEnvar: apiKeyEnv } : {}),
    ...(model ? { model } : {})
  };
  return Object.keys(extra).length ? { id, config: extra } : id;
}

function buildPromptfooConfig({ description, prompt, providers, cases }) {
  return { description, prompts: [prompt], providers, tests: cases };
}

function summarize(result) {
  const rows = (result && result.results && result.results.results) || [];
  const byProvider = new Map();
  for (const row of rows) {
    const id = (row.provider && (row.provider.label || row.provider.id)) || 'inconnu';
    const entry = byProvider.get(id) || { provider: id, passed: 0, failed: 0, errors: 0, failures: [] };
    // failureReason de promptfoo : 0 aucune, 1 assertion non satisfaite, 2 erreur d'exécution (fournisseur, réseau).
    if (row.failureReason === 2) {
      entry.errors += 1;
    } else if (row.success) {
      entry.passed += 1;
    } else {
      entry.failed += 1;
    }
    if (!row.success) {
      entry.failures.push({
        description: (row.testCase && row.testCase.description) || JSON.stringify(row.vars),
        reason: (row.gradingResult && row.gradingResult.reason) || row.error || 'assertion non satisfaite'
      });
    }
    byProvider.set(id, entry);
  }
  return [...byProvider.values()].map((entry) => {
    const total = entry.passed + entry.failed + entry.errors;
    return { ...entry, total, passRate: total === 0 ? 0 : entry.passed / total };
  });
}

async function runEval(rootDir, config, options = {}) {
  const output = options.output || console;
  const settings = mergeConfig(EVAL_DEFAULTS, config.eval || {});
  const runner = options.runProcess || runProcess;

  const casesFile = path.resolve(rootDir, options.cases || settings.cases);
  const { cases, prompt: filePrompt } = loadCases(casesFile);

  const providers = options.provider
    ? [buildProvider({ id: options.provider, baseUrl: options['base-url'], apiKeyEnv: options['api-key-env'], model: options.model })]
    : settings.providers.map((provider) => (typeof provider === 'string' ? provider : buildProvider(provider)));
  if (providers.length === 0) {
    buildProvider({});
  }

  const minPassRate = options['min-pass'] === undefined ? settings.minPassRate : Number(options['min-pass']);
  if (!(minPassRate >= 0 && minPassRate <= 1)) {
    throw new ToolingError('EVAL_THRESHOLD_INVALID', '--min-pass doit être entre 0 et 1', 400);
  }

  const entry = options.promptfooEntry !== undefined ? options.promptfooEntry : findPromptfoo(rootDir);
  if (!entry) {
    throw new ToolingError('EVAL_PROMPTFOO_MISSING', 'promptfoo est introuvable : npm install --save-dev promptfoo (Node 22.22 ou plus)', 500);
  }

  const outDir = path.resolve(rootDir, settings.outputDir);
  fs.mkdirSync(outDir, { recursive: true });
  const configFile = path.join(outDir, 'promptfooconfig.json');
  const resultFile = path.resolve(rootDir, options.out || path.join(settings.outputDir, 'last-result.json'));
  fs.mkdirSync(path.dirname(resultFile), { recursive: true });
  fs.rmSync(resultFile, { force: true });
  fs.writeFileSync(configFile, `${JSON.stringify(buildPromptfooConfig({
    description: 'Évaluation Astratra',
    prompt: filePrompt || settings.prompt,
    providers,
    cases
  }), null, 2)}\n`);

  output.log(colors.bold(`Évaluation : ${cases.length} cas, ${providers.length} fournisseur(s)`));
  const run = await runner(process.execPath, [entry, 'eval', '-c', configFile, '-o', resultFile, '--no-cache', '--no-write'], {
    cwd: rootDir,
    env: { ...process.env, ...PROMPTFOO_ENV },
    quiet: true
  });

  let result = null;
  if (fs.existsSync(resultFile)) {
    result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  }
  if (!result) {
    // promptfoo sort en 100 quand des cas échouent, mais écrit alors son résultat : pas de résultat = vraie panne.
    throw new ToolingError('EVAL_RUN_FAILED', `promptfoo n'a produit aucun résultat (code ${run.code}) : ${(run.stderr || '').trim().split('\n').slice(-3).join(' | ')}`, 500);
  }

  const summaries = summarize(result);
  let exitCode = summaries.length === 0 ? 1 : 0;
  for (const summary of summaries) {
    const ok = summary.passRate >= minPassRate;
    if (!ok) {
      exitCode = 1;
    }
    const line = `${summary.provider} : ${summary.passed}/${summary.total} réussis (${(summary.passRate * 100).toFixed(0)} %, seuil ${(minPassRate * 100).toFixed(0)} %)`;
    output.log(ok ? colors.green(line) : colors.red(line));
    for (const failure of summary.failures) {
      output.log(`  - ${failure.description} : ${failure.reason}`);
    }
  }
  if (summaries.length === 0) {
    output.log(colors.red('Aucun résultat d\'évaluation.'));
  }

  return { exitCode, summaries, resultFile, configFile };
}

module.exports = {
  EVAL_DEFAULTS,
  buildProvider,
  buildPromptfooConfig,
  findPromptfoo,
  loadCases,
  runEval,
  summarizeEval: summarize
};
