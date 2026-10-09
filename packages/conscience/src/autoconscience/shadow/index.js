'use strict';
/* P4 · shadow mode (21 shadow mode, 32 sandbox of the shadow mode). */
const runner = require('./runner');
const store = require('./store');
const report = require('./report');

module.exports = {
  createShadowRunner: runner.createShadowRunner, SHADOW_CONCLUSIONS: report.CONCLUSIONS,
  createMemoryShadowStore: store.createMemoryShadowStore, createPostgresShadowStore: store.createPostgresShadowStore,
  postgresShadowSchema: store.postgresShadowSchema, shadowEraser: store.shadowEraser
};
