const { buildSitemap, sitemapPaths, auditSitemap } = require('../src');

const SITE = 'https://www.example.cd';

const table = [
  { path: '/', label: 'Home', lastmod: '2026-07-16', changefreq: 'daily', priority: '1.0' },
  { path: '/login', sitemap: false },
  { path: '/pricing', label: 'Pricing', lastmod: '2026-07-16', changefreq: 'monthly', priority: '0.9' }
];

describe('buildSitemap', () => {
  test('produces a valid document carrying the editorial metadata', () => {
    const xml = buildSitemap(table, { siteUrl: SITE });

    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<loc>https://www.example.cd/pricing</loc>');
    expect(xml).toContain('<changefreq>monthly</changefreq>');
    expect(xml).toContain('<priority>0.9</priority>');
    expect(xml).toContain('<!-- Pricing -->');
    expect(xml.trimEnd().endsWith('</urlset>')).toBe(true);
  });

  test('omits a page rendered but not meant to be indexed', () => {
    /* A sign-in page is worth rendering for a crawler following a link,
       without deserving a place in a site plan. */
    expect(sitemapPaths(buildSitemap(table, { siteUrl: SITE }), SITE)).toEqual(['/', '/pricing']);
  });

  test('accepts bare strings — the existing contract still works', () => {
    const xml = buildSitemap(['/', '/about'], { siteUrl: SITE, defaultLastmod: '2026-08-25' });

    expect(sitemapPaths(xml, SITE)).toEqual(['/', '/about']);
    expect(xml).toContain('<lastmod>2026-08-25</lastmod>');
  });

  test('a trailing slash on siteUrl does not double up', () => {
    expect(buildSitemap(['/about'], { siteUrl: 'https://www.example.cd/' }))
      .toContain('<loc>https://www.example.cd/about</loc>');
  });

  test('the home page keeps its slash rather than becoming an empty path', () => {
    expect(sitemapPaths(buildSitemap(['/'], { siteUrl: SITE }), SITE)).toEqual(['/']);
  });

  test('without siteUrl it refuses rather than emitting relative URLs', () => {
    expect(() => buildSitemap(['/'], {})).toThrow(/siteUrl/);
  });
});

describe('auditSitemap', () => {
  test('says nothing when every announced URL has a page', () => {
    const xml = buildSitemap(table, { siteUrl: SITE });

    expect(auditSitemap(xml, ['/', '/pricing', '/login'], SITE)).toEqual([]);
  });

  test('catches a URL announced without a page behind it', () => {
    /* The real failure: a route listed in the sitemap but excluded from
       prerendering. The host falls back to SPA handling and the crawler
       receives the home page under that address. */
    const xml = buildSitemap([...table, { path: '/blog', label: 'Blog' }], { siteUrl: SITE });

    const errors = auditSitemap(xml, ['/', '/pricing'], SITE);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('/blog');
    expect(errors[0]).toContain('home page');
  });

  test('reads a hand-written sitemap just as well as a generated one', () => {
    const handWritten = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      `  <url><loc>${SITE}/</loc></url>`,
      `  <url><loc>${SITE}/ghost</loc></url>`,
      '</urlset>'
    ].join('\n');

    expect(auditSitemap(handWritten, ['/'], SITE)).toHaveLength(1);
  });

  test('an empty sitemap is not an error', () => {
    expect(auditSitemap('<urlset></urlset>', ['/'], SITE)).toEqual([]);
  });
});
