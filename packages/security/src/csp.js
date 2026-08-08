const DEFAULT_DIRECTIVES = {
  'default-src': ["'none'"],
  'frame-ancestors': ["'none'"],
  'base-uri': ["'none'"]
};

function buildHeaderValue(directives) {
  return Object.entries(directives)
    .filter(([, sources]) => Array.isArray(sources) && sources.length > 0)
    .map(([directive, sources]) => `${directive} ${sources.join(' ')}`)
    .join('; ');
}

function mergeDirectives(base, overrides) {
  const merged = { ...base };
  for (const [directive, sources] of Object.entries(overrides || {})) {
    merged[directive] = sources;
  }
  return merged;
}

function createCspMiddleware(options = {}) {
  const directives = mergeDirectives(DEFAULT_DIRECTIVES, options.directives);
  const headerValue = buildHeaderValue(directives);
  const headerName = options.reportOnly
    ? 'Content-Security-Policy-Report-Only'
    : 'Content-Security-Policy';

  return (req, res, next) => {
    if (headerValue) {
      res.setHeader(headerName, headerValue);
    }
    next();
  };
}

module.exports = {
  createCspMiddleware,
  DEFAULT_CSP_DIRECTIVES: DEFAULT_DIRECTIVES
};
