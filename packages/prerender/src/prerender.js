const { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('fs');
const { resolve } = require('path');
const { pathToFileURL } = require('url');
const { cleanHtml, assertFreshShell } = require('./html');
const { auditPages } = require('./audit');

// import() dynamique plutôt que require() : Vite 7 est ESM-only pour son API
// Node (preview()), et un require() CommonJS ne sait pas charger un module
// ESM — "Cannot use import statement outside a module". import() gère les
// deux formats indifféremment (ESM comme CJS), donc ce chargeur fonctionne
// quel que soit le format publié par la dépendance installée chez le
// consommateur. Trouvé en lançant le test d'intégration sous Jest : un simple
// script Node l'encaissait silencieusement grâce au require(esm) natif de
// Node 24+, que Jest n'implémente pas — sans ce test, ce package aurait
// cassé chez tout consommateur utilisant Vite 7 sous Jest.
async function dependency(name) {
  let resolved;
  try {
    resolved = require.resolve(name, { paths: [process.cwd()] });
  } catch (_error) {
    throw new Error(`@astratra/prerender requires ${name}. Install it in your project.`);
  }

  return import(pathToFileURL(resolved).href);
}

function writeRoute(distDir, route, html) {
  const target = route === '/' ? resolve(distDir, 'index.html') : resolve(distDir, route.slice(1), 'index.html');
  mkdirSync(resolve(target, '..'), { recursive: true });
  writeFileSync(target, html, 'utf8');
}

async function prerender(options = {}) {
  const { routes, siteUrl, distDir = 'dist', apiPatterns = ['**/api/**'], retries = 1, audit = true } = options;
  if (!Array.isArray(routes) || routes.length === 0) throw new Error('prerender requires a non-empty routes array.');
  if (!siteUrl) throw new Error('prerender requires siteUrl.');
  const output = resolve(process.cwd(), distDir);
  const indexPath = resolve(output, 'index.html');
  if (!existsSync(indexPath)) throw new Error(`Missing ${indexPath}. Run vite build first.`);
  assertFreshShell(readFileSync(indexPath, 'utf8'));
  copyFileSync(indexPath, resolve(output, '_shell.html'));

  const viteModule = await dependency('vite');
  const playwrightModule = await dependency('playwright');
  // .default en repli : cjs-module-lexer (utilisé par Node pour synthétiser
  // les exports nommés d'un module CommonJS chargé via import()) reconnaît le
  // patron `module.exports = { a, b }`, mais rien ne garantit qu'une version
  // future de ces packages y reste fidèle — la casse serait silencieuse
  // (preview/chromium undefined) sans ce repli explicite.
  const preview = viteModule.preview ?? viteModule.default?.preview;
  const chromium = playwrightModule.chromium ?? playwrightModule.default?.chromium;
  if (typeof preview !== 'function') throw new Error('@astratra/prerender: vite.preview is not available.');
  if (!chromium) throw new Error('@astratra/prerender: playwright.chromium is not available.');
  // build.outDir en absolu, explicitement : sans lui, vite preview() retombe
  // sur process.cwd() pour localiser dist/, ce qui n'est correct QUE si le
  // process appelant tourne déjà depuis la racine du projet cible (le cas
  // documenté "vite build && astratra-prerender" en script npm, où npm fixe
  // le cwd). Le README documente aussi prerender() comme fonction appelable
  // directement — un appel programmatique depuis un autre répertoire (un
  // test, un outil monorepo) servait alors un dist/ vide ou erroné, en
  // silence : la navigation "réussissait" sur une page vide, et
  // waitFor ne trouvait jamais l'élément attendu. Trouvé en lançant le
  // test d'intégration depuis packages/prerender plutôt que depuis le
  // fixture lui-même.
  const server = await preview({ build: { outDir: output }, preview: { port: 0 } });
  const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
  const browser = await chromium.launch();
  const context = await browser.newContext({ serviceWorkers: 'block' });
  for (const pattern of apiPatterns) await context.route(pattern, route => route.fulfill({ status: 200, body: '{}' }));
  await context.route('**/socket.io/**', route => route.abort());
  const pages = [];
  try {
    // Phase 1 — capture uniquement, aucune écriture disque ici. vite preview
    // sert dist/ en temps réel depuis le disque : écrire une route pendant
    // qu'on en capture d'autres pollue le repli SPA des routes suivantes.
    // Trouvé en exécutant ce package sur un vrai mini-site : /about, dont le
    // fichier n'existe pas encore au moment de sa navigation, retombait sur
    // dist/index.html — déjà réécrit par la capture de "/" juste avant — et
    // héritait silencieusement de ses balises meta/canonical en plus des
    // siennes. Capturer d'abord TOUT, puis écrire, garantit que chaque route
    // parte toujours du build Vite original, jamais d'un dist/ déjà modifié
    // par cette même exécution.
    for (const route of routes) {
      let lastError;
      for (let attempt = 0; attempt <= retries; attempt++) {
        const page = await context.newPage();
        try {
          await page.goto(`${origin}${route}`, { waitUntil: 'networkidle', timeout: 15000 });
          // state: 'attached' (pas la valeur par défaut 'visible') : le README
          // recommande waitFor: 'meta[name="description"]' comme exemple, mais
          // une balise <meta> n'a jamais de rendu visuel — Playwright la
          // considère "hidden" pour toujours et l'attente de visibilité
          // n'aboutit jamais. Trouvé en exécutant réellement le prérendu sur
          // un site de test, pas en lisant le code.
          if (options.waitFor) await page.waitForSelector(options.waitFor, { state: 'attached', timeout: 5000 });
          if (options.isReady) await options.isReady(page, route);
          const html = options.transformHtml ? await options.transformHtml(await page.content(), { route, origin }) : await page.content();
          const cleaned = cleanHtml(html, { origin, siteUrl });
          pages.push({ route, html: cleaned });
          lastError = null;
          break;
        } catch (error) { lastError = error; } finally { await page.close(); }
      }
      if (lastError) throw new Error(`Unable to prerender ${route}: ${lastError.message}`);
    }

    const report = audit ? auditPages(pages) : { errors: [], warnings: [] };
    if (report.errors.length) throw new Error(`Prerender audit failed:\n${report.errors.join('\n')}`);

    // Phase 2 — écriture, seulement une fois TOUTES les routes capturées et
    // auditées avec succès. Une erreur en cours de route (échec ou audit) ne
    // laisse donc jamais un dist/ à moitié réécrit derrière elle.
    for (const { route, html } of pages) writeRoute(output, route, html);

    return { pages, warnings: report.warnings };
  } finally {
    await browser.close();
    server.httpServer.close();
  }
}

// dependency() est exposée uniquement pour être testée directement : simuler
// un vrai peer dependency manquant sans désinstaller vite/playwright (dont
// dépendent aussi les autres tests) n'est possible qu'en l'appelant avec un
// nom de module qui n'existe nulle part.
module.exports = { prerender, dependency };
