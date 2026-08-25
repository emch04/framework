/**
 * The sitemap, built from the same list as the pages.
 *
 * A sitemap is usually a hand-written file with no link to the route list, and
 * the two drift. The failure is silent and expensive: the file tells a crawler
 * to fetch a URL that was never prerendered, the host falls back to
 * single-page-application handling, and the crawler receives the HOME PAGE —
 * title, description and all — under that address. A duplicate of the home page
 * indexed under someone else's URL is exactly what `auditPages` exists to catch
 * on the rendering side; this closes the same hole on the announcing side.
 *
 * One list, therefore. A page you stop prerendering leaves the sitemap the same
 * day.
 */

/** A route entry may be a bare path or a table row carrying its SEO metadata. */
function normalizeRoute(route) {
  return typeof route === 'string' ? { path: route } : { ...route };
}

function normalizeRoutes(routes) {
  return (routes || []).map(normalizeRoute);
}

/**
 * @param {Array<string|object>} routes  entries: { path, lastmod?, changefreq?,
 *   priority?, label?, sitemap? }. `sitemap: false` prerenders the page without
 *   announcing it — a sign-in page is worth rendering for a crawler following a
 *   link, without deserving a place in a site plan.
 * @param {{siteUrl: string, defaultLastmod?: string}} options
 * @returns {string} the sitemap XML.
 */
function buildSitemap(routes, { siteUrl, defaultLastmod } = {}) {
  if (!siteUrl) throw new Error('buildSitemap requires siteUrl.');

  const base = String(siteUrl).replace(/\/$/, '');
  const today = defaultLastmod || new Date().toISOString().slice(0, 10);
  const listed = normalizeRoutes(routes).filter((route) => route.sitemap !== false);

  const urls = listed.map((route) => [
    route.label ? `  <!-- ${route.label} -->` : null,
    '  <url>',
    `    <loc>${base}${route.path}</loc>`,
    `    <lastmod>${route.lastmod || today}</lastmod>`,
    route.changefreq ? `    <changefreq>${route.changefreq}</changefreq>` : null,
    route.priority ? `    <priority>${route.priority}</priority>` : null,
    '  </url>'
  ].filter(Boolean).join('\n'));

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    urls.join('\n\n'),
    '</urlset>',
    ''
  ].join('\n');
}

/** The paths a sitemap announces, relative to the site root. */
function sitemapPaths(xml, siteUrl) {
  const base = String(siteUrl).replace(/\/$/, '');
  return [...String(xml).matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((match) => match[1].replace(base, ''))
    .map((path) => (path === '' ? '/' : path));
}

/**
 * Every announced URL must have a page behind it.
 *
 * @param {string} xml
 * @param {string[]} renderedPaths
 * @param {string} siteUrl
 * @returns {string[]} one message per URL announced without a page.
 */
function auditSitemap(xml, renderedPaths, siteUrl) {
  const rendered = new Set(renderedPaths);
  return sitemapPaths(xml, siteUrl)
    .filter((path) => !rendered.has(path))
    .map((path) => `${path} is announced in the sitemap but was not prerendered — that URL would serve the home page to crawlers`);
}

module.exports = { buildSitemap, sitemapPaths, auditSitemap, normalizeRoutes };
