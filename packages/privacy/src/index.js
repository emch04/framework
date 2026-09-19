module.exports = {
  ...require('./redactor'),
  ...require('./exporter'),
  ...require('./anonymizer'),
  ...require('./erasure'),
  ...require('./accountDeletion'),
  ...require('./stores')
};
