'use strict';
const { createMemoryConscienceStore } = require('../src');
const { createMemoryGovernorStore } = require('../src/governor');
const { governorContract } = require('./governorContract');
const { conscienceContract } = require('./conscienceContract');

governorContract('memory', () => ({ store: createMemoryGovernorStore() }));
conscienceContract('memory', () => ({ store: createMemoryConscienceStore(), governorStore: createMemoryGovernorStore() }));
