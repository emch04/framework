const DEFAULT_PERMISSIONS_POLICY = 'geolocation=(), camera=(), microphone=(), payment=()';
const DEFAULT_HSTS_MAX_AGE = 15552000; // 180 days

const isProduction = () => process.env.NODE_ENV === 'production';

/**
 * The standard response-header hardening set beyond CSP (which
 * createCspMiddleware already covers separately): clickjacking, MIME
 * sniffing, referrer leakage, browser feature access, and HTTP downgrade.
 * Every header here has a safe universal default — unlike CORS, nothing
 * here needs a project-specific decision — so createSaasApp mounts this
 * unconditionally, the same way it already does for CSP and the WAF.
 */
const createSecurityHeadersMiddleware = (options = {}) => {
  const frameOptions = options.frameOptions === undefined ? 'DENY' : options.frameOptions;
  const contentTypeOptions = options.contentTypeOptions !== false;
  const referrerPolicy = options.referrerPolicy === undefined ? 'strict-origin-when-cross-origin' : options.referrerPolicy;
  const permissionsPolicy = options.permissionsPolicy === undefined ? DEFAULT_PERMISSIONS_POLICY : options.permissionsPolicy;
  const hsts = options.hsts === undefined ? isProduction() : options.hsts;
  const hstsMaxAge = (hsts && typeof hsts === 'object' && hsts.maxAge) || DEFAULT_HSTS_MAX_AGE;
  const hstsIncludeSubDomains = !(hsts && typeof hsts === 'object' && hsts.includeSubDomains === false);

  return (req, res, next) => {
    if (frameOptions) {
      res.setHeader('X-Frame-Options', frameOptions);
    }
    if (contentTypeOptions) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
    }
    if (referrerPolicy) {
      res.setHeader('Referrer-Policy', referrerPolicy);
    }
    if (permissionsPolicy) {
      res.setHeader('Permissions-Policy', permissionsPolicy);
    }
    if (hsts) {
      res.setHeader(
        'Strict-Transport-Security',
        `max-age=${hstsMaxAge}${hstsIncludeSubDomains ? '; includeSubDomains' : ''}`
      );
    }
    next();
  };
};

module.exports = {
  createSecurityHeadersMiddleware,
  DEFAULT_PERMISSIONS_POLICY
};
