/* global window -- ces arrow functions s'exécutent dans le navigateur, via
   page.evaluate()/page.waitForFunction(), pas dans ce process Node. */
const { execFileSync } = require('child_process');
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('fs');
const { tmpdir } = require('os');
const { resolve } = require('path');
const { prerender, dependency } = require('../src');

const FIXTURE = resolve(__dirname, 'fixtures', 'mini-site');
const DIST = resolve(FIXTURE, 'dist');
const VITE_BIN = resolve(__dirname, '..', '..', '..', 'node_modules', '.bin', 'vite');

function buildFixture() {
  rmSync(DIST, { recursive: true, force: true });
  execFileSync(VITE_BIN, ['build'], { cwd: FIXTURE, stdio: 'pipe' });
}

function read(...segments) {
  return readFileSync(resolve(DIST, ...segments), 'utf8');
}

// Ces tests lancent un vrai serveur Vite preview et un vrai navigateur
// Chromium — plus lents que les tests unitaires de html.test.js, mais c'est
// la seule façon de vérifier ce que prérender() produit réellement, pas ce
// que son code semble faire à la lecture. Deux bugs réels ont été trouvés
// en écrivant ces tests, invisibles depuis le code seul :
//   1. waitFor: 'meta[...]' ne pouvait jamais aboutir (Playwright attend la
//      visibilité par défaut, une balise <meta> n'est jamais visible) ;
//   2. écrire une route sur disque avant d'avoir capturé les suivantes
//      polluait leur repli SPA avec les balises meta/canonical déjà écrites.
describe('prerender() — intégration sur un vrai site Vite + React', () => {
  beforeEach(buildFixture);

  test('génère un fichier par route et préserve le shell vierge', async () => {
    const result = await prerender({
      routes: ['/', '/about'],
      siteUrl: 'https://example.com',
      distDir: DIST,
      waitFor: 'meta[name="description"]',
    });

    expect(result.pages.map((p) => p.route).sort()).toEqual(['/', '/about']);
    expect(existsSync(resolve(DIST, 'index.html'))).toBe(true);
    expect(existsSync(resolve(DIST, 'about', 'index.html'))).toBe(true);
    expect(existsSync(resolve(DIST, '_shell.html'))).toBe(true);

    const shell = read('_shell.html');
    expect(shell).not.toContain('data-astratra-prerendered="true"');
    expect(shell).not.toContain('Home — Mini Site');
  }, 30000);

  test('remplace l\'origine locale par siteUrl dans les URLs absolues', async () => {
    await prerender({
      routes: ['/', '/about'],
      siteUrl: 'https://example.com',
      distDir: DIST,
      waitFor: 'meta[name="description"]',
    });

    const home = read('index.html');
    const about = read('about', 'index.html');
    expect(home).toContain('https://example.com/');
    expect(about).toContain('https://example.com/about');
    expect(home).not.toMatch(/127\.0\.0\.1|localhost/);
    expect(about).not.toMatch(/127\.0\.0\.1|localhost/);
  }, 30000);

  // Régression directe du bug de contamination trouvé en écrivant ce test :
  // /about ne doit contenir NI le titre, NI la description, NI le canonical
  // de la page d'accueil traitée juste avant elle.
  test('une route ne contient aucune balise héritée d\'une route déjà écrite', async () => {
    await prerender({
      routes: ['/', '/about'],
      siteUrl: 'https://example.com',
      distDir: DIST,
      waitFor: 'meta[name="description"]',
    });

    const about = read('about', 'index.html');
    expect((about.match(/<meta name="description"/g) || []).length).toBe(1);
    expect((about.match(/rel="canonical"/g) || []).length).toBe(1);
    expect(about).not.toContain('Home — Mini Site');
    expect(about).toContain('About — Mini Site');
  }, 30000);

  test('une route qui échoue annule toute la génération, sans écrire un dist/ partiel', async () => {
    await expect(prerender({
      routes: ['/', '/route-inconnue'],
      siteUrl: 'https://example.com',
      distDir: DIST,
      waitFor: 'meta[name="description"]',
      retries: 0,
    })).rejects.toThrow(/Unable to prerender \/route-inconnue/);

    // Phase 2 (écriture) n'a jamais dû s'exécuter : même "/", capturée avec
    // succès avant l'échec de la seconde route, ne doit pas apparaître.
    expect(existsSync(resolve(DIST, 'about', 'index.html'))).toBe(false);
    const index = read('index.html');
    expect(index).not.toContain('data-astratra-prerendered');
  }, 30000);

  test('refuse de tourner sur un dist déjà prérendu', async () => {
    await prerender({
      routes: ['/', '/about'],
      siteUrl: 'https://example.com',
      distDir: DIST,
      waitFor: 'meta[name="description"]',
    });

    await expect(prerender({
      routes: ['/', '/about'],
      siteUrl: 'https://example.com',
      distDir: DIST,
      waitFor: 'meta[name="description"]',
    })).rejects.toThrow(/already prerendered/);
  }, 30000);

  // apiPatterns et isReady n'avaient jamais été exécutés avant ce test. Le
  // fixture appelle fetch('/api/ping') sans qu'aucun serveur API ne tourne :
  // sans interception, cet appel échoue réellement (aucun serveur derrière).
  // Un succès ne peut donc venir QUE de context.route() interceptant la
  // requête — isReady(page, route) sert ici à relire l'état de la page en
  // plein milieu de prerender(), via le vrai chemin d'exécution du package.
  test('apiPatterns intercepte les appels API par défaut ; isReady est bien invoqué', async () => {
    const seenRoutes = [];

    const result = await prerender({
      routes: ['/'],
      siteUrl: 'https://example.com',
      distDir: DIST,
      waitFor: 'meta[name="description"]',
      isReady: async (page, route) => {
        seenRoutes.push(route);
        await page.waitForFunction(() => window.__apiFetchOutcome !== undefined, { timeout: 5000 });
        const outcome = await page.evaluate(() => window.__apiFetchOutcome);
        if (!outcome.ok) throw new Error(`fetch /api/ping non intercepté : ${outcome.error}`);
      },
    });

    expect(seenRoutes).toEqual(['/']);
    expect(result.pages).toHaveLength(1);
  }, 30000);

  // apiPatterns fourni par le consommateur REMPLACE le défaut ['**/api/**'],
  // il ne s'y ajoute pas — comportement de paramètre par défaut JS classique,
  // mais qui mérite un test explicite : un consommateur pourrait raisonnablement
  // s'attendre à un merge plutôt qu'un remplacement.
  // Vérifie les deux sens à la fois : un apiPatterns personnalisé doit
  // intercepter le chemin qu'il couvre ET NE PLUS intercepter /api/ping.
  // Ne tester qu'un seul sens (comme une première version de ce test le
  // faisait) ne distingue pas "correctement remplacé" de "apiPatterns
  // entièrement inopérant" — les deux auraient laissé /api/ping échouer.
  test('un apiPatterns personnalisé remplace le défaut plutôt que de s\'y ajouter', async () => {
    await expect(prerender({
      routes: ['/'],
      siteUrl: 'https://example.com',
      distDir: DIST,
      waitFor: 'meta[name="description"]',
      apiPatterns: ['**/custom-endpoint/**'],
      isReady: async (page) => {
        await page.waitForFunction(
          () => window.__apiFetchOutcome !== undefined && window.__customFetchOutcome !== undefined,
          { timeout: 5000 }
        );
        const [apiOutcome, customOutcome] = await page.evaluate(
          () => [window.__apiFetchOutcome, window.__customFetchOutcome]
        );
        if (apiOutcome.ok) throw new Error('/api/ping intercepté à tort : apiPatterns aurait dû exclure le défaut');
        if (!customOutcome.ok) throw new Error(`/custom-endpoint/ping non intercepté : ${customOutcome.error}`);
      },
    })).resolves.toBeDefined();
  }, 30000);

  test('transformHtml transforme le HTML avant écriture sur disque', async () => {
    await prerender({
      routes: ['/'],
      siteUrl: 'https://example.com',
      distDir: DIST,
      waitFor: 'meta[name="description"]',
      transformHtml: async (html, context) => {
        expect(context.route).toBe('/');
        expect(typeof context.origin).toBe('string');
        return html.replace('</body>', '<!-- transformé --></body>');
      },
    });

    expect(read('index.html')).toContain('<!-- transformé -->');
  }, 30000);

  // Une route qui échoue une fois puis réussit doit être rattrapée par le
  // retry, jamais testé jusqu'ici — seul le cas "échoue toujours" l'était.
  test('une route qui échoue au premier essai est rattrapée au second (retries)', async () => {
    let attempts = 0;

    const result = await prerender({
      routes: ['/'],
      siteUrl: 'https://example.com',
      distDir: DIST,
      waitFor: 'meta[name="description"]',
      retries: 1,
      isReady: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('échec simulé du premier essai');
      },
    });

    expect(attempts).toBe(2);
    expect(result.pages).toHaveLength(1);
    expect(existsSync(resolve(DIST, 'index.html'))).toBe(true);
  }, 30000);
});

describe('prerender() — chemins d\'erreur jamais exercés avant', () => {
  test('rejette avec un message clair si dist/index.html est introuvable', async () => {
    const empty = mkdtempSync(resolve(tmpdir(), 'astratra-prerender-empty-'));
    try {
      await expect(prerender({
        routes: ['/'],
        siteUrl: 'https://example.com',
        distDir: empty,
      })).rejects.toThrow(/Missing .*index\.html.*Run vite build first/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test('dependency() rejette avec un message explicite pour un module réellement absent', async () => {
    await expect(dependency('ce-module-n-existe-nulle-part-astratra-test'))
      .rejects.toThrow('@astratra/prerender requires ce-module-n-existe-nulle-part-astratra-test. Install it in your project.');
  });
});

describe('astratra-prerender — binaire CLI', () => {
  const CLI_BIN = resolve(__dirname, '..', 'bin', 'astratra-prerender.js');
  let cliFixture;

  beforeEach(() => {
    // Le répertoire de travail doit rester SOUS packages/prerender : la
    // résolution de vite/playwright par le binaire (require.resolve avec
    // paths: [process.cwd()]) remonte l'arborescence depuis process.cwd() —
    // un dossier dans os.tmpdir() n'atteindrait jamais astratra/node_modules.
    cliFixture = mkdtempSync(resolve(__dirname, 'fixtures', 'astratra-prerender-cli-'));
    execFileSync(VITE_BIN, ['build'], { cwd: FIXTURE, stdio: 'pipe' });
    // Réutilise le dist déjà buildé du fixture principal, copié dans un
    // répertoire de travail isolé pour ne pas interférer avec les autres tests.
    const { cpSync } = require('fs');
    cpSync(DIST, resolve(cliFixture, 'dist'), { recursive: true });
  });

  afterEach(() => {
    rmSync(cliFixture, { recursive: true, force: true });
  });

  test('exécute le prérendu via un fichier de config par défaut', () => {
    writeFileSync(resolve(cliFixture, 'astratra.prerender.config.cjs'), `
      module.exports = {
        routes: ['/', '/about'],
        siteUrl: 'https://example.com',
        distDir: 'dist',
        waitFor: 'meta[name="description"]',
      };
    `);

    execFileSync('node', [CLI_BIN], { cwd: cliFixture, stdio: 'pipe' });

    expect(existsSync(resolve(cliFixture, 'dist', 'index.html'))).toBe(true);
    expect(existsSync(resolve(cliFixture, 'dist', 'about', 'index.html'))).toBe(true);
  }, 30000);

  test('accepte --config avec un chemin personnalisé', () => {
    writeFileSync(resolve(cliFixture, 'custom.cjs'), `
      module.exports = {
        routes: ['/'],
        siteUrl: 'https://example.com',
        distDir: 'dist',
        waitFor: 'meta[name="description"]',
      };
    `);

    execFileSync('node', [CLI_BIN, '--config', 'custom.cjs'], { cwd: cliFixture, stdio: 'pipe' });

    expect(existsSync(resolve(cliFixture, 'dist', 'index.html'))).toBe(true);
  }, 30000);

  test('sort avec un code d\'erreur non-zéro si le prérendu échoue', () => {
    writeFileSync(resolve(cliFixture, 'astratra.prerender.config.cjs'), `
      module.exports = {
        routes: ['/route-inconnue'],
        siteUrl: 'https://example.com',
        distDir: 'dist',
        waitFor: 'meta[name="description"]',
        retries: 0,
      };
    `);

    expect(() => execFileSync('node', [CLI_BIN], { cwd: cliFixture, stdio: 'pipe' })).toThrow();
  }, 30000);
});
