module.exports = {
  ...require('./cors'),
  ...require('./encryption'),
  ...require('./jwtAuth'),
  ...require('./rateLimiters'),
  ...require('./waf'),
  ...require('./webauthn'),
  ...require('./csp'),
  ...require('./cookies'),
  ...require('./csrf'),
  ...require('./revocation')
};
