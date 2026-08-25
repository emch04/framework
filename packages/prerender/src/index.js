const { prerender, dependency } = require('./prerender');
const { buildSitemap, sitemapPaths, auditSitemap } = require('./sitemap');
const { auditPages, extractVisibleText } = require('./audit');

module.exports = { prerender, dependency, buildSitemap, sitemapPaths, auditSitemap, auditPages, extractVisibleText };
