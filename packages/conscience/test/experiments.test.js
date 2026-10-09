'use strict';
const { experimentsContract } = require('./experimentsContract');
const { createMemoryConscienceStore } = require('../src');
const { createMemoryGovernorStore } = require('../src/governor');
experimentsContract('memory', () => ({ store: createMemoryConscienceStore(), governorStore: createMemoryGovernorStore() }));
