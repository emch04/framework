module.exports = {
  ...require('./redactor'),
  ...require('./exporter'),
  ...require('./anonymizer'),
  ...require('./erasure'),
  ...require('./stores')
};
