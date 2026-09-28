module.exports = {
  ...require('./redactor'),
  ...require('./exporter'),
  ...require('./anonymizer'),
  ...require('./erasure'),
  ...require('./accountDeletion'),
  ...require('./stores'),
  ...require('./consent'),
  ...require('./consentClient'),
  ...require('./testing/consentStoreContract')
};
