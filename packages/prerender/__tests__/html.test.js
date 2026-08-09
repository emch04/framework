const { cleanHtml, assertFreshShell } = require('../src/html');
const { auditPages } = require('../src/audit');

test('cleans the local origin and marks prerendered HTML', () => {
  const html = cleanHtml('<html><head><title>About</title><meta name="description" content="About us"></head><body>http://127.0.0.1:5173/about</body></html>', {
    origin: 'http://127.0.0.1:5173', siteUrl: 'https://example.com'
  });
  expect(html).toContain('https://example.com/about');
  expect(html).toContain('data-astratra-prerendered="true"');
});

test('rejects an already prerendered SPA shell', () => {
  expect(() => assertFreshShell('<html data-astratra-prerendered="true">')).toThrow('already prerendered');
});

test('reports duplicate titles as an audit error', () => {
  const result = auditPages([
    { route: '/', html: '<title>Same</title><meta name="description" content="one"><main>first content</main>' },
    { route: '/about', html: '<title>Same</title><meta name="description" content="two"><main>second content</main>' }
  ]);
  expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining('duplicate title')]));
});

// Régression : une route derrière une redirection d'authentification capturait
// la page de connexion sur un site consommateur (Scolaris) et la publiait sous
// sa propre URL, titre ET contenu compris. Un titre différent n'aurait pas
// suffi à masquer ce bug — la détection doit porter sur le contenu réellement
// rendu, pas seulement sur les métadonnées.
const LOREM = Array.from({ length: 40 }, (_, i) => `alpha${i}`).join(' ');
const AUTRE = Array.from({ length: 40 }, (_, i) => `omega${i}`).join(' ');
const page = (route, body, title = route, description = `desc ${route}`) => ({
  route,
  html: `<head><title>${title}</title><meta name="description" content="${description}"></head><body><p>${body}</p></body>`
});

test('detects two routes rendering the same content, even with different titles', () => {
  const result = auditPages([page('/blog', LOREM, 'Blog'), page('/login', LOREM, 'Login')]);
  expect(result.errors).toContain('/blog and /login render the same content');
});

test('accepts pages with genuinely distinct content', () => {
  const result = auditPages([page('/a', LOREM), page('/b', AUTRE)]);
  expect(result.errors).toEqual([]);
});

test('warns without blocking on thin content, legitimate for a form page', () => {
  const result = auditPages([page('/login', 'Email Password Sign in')]);
  expect(result.errors).toEqual([]);
  expect(result.warnings.some((w) => w.includes('/login'))).toBe(true);
});

test('does not compare pages too short to conclude anything', () => {
  const result = auditPages([page('/a', 'short text'), page('/b', 'short text')]);
  expect(result.errors.filter((e) => e.includes('render the same content'))).toEqual([]);
});
