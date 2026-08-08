module.exports = {
  ...require('./jwtAuth'),
  ...require('./rateLimiters'),
  ...require('./waf'),
  ...require('./webauthn')
};
