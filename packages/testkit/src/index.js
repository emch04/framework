'use strict';

const guard = require('./guard');
const containers = require('./containers');
const { createFakeData, supportedCountries, EMAIL_DOMAIN } = require('./data');

module.exports = { ...guard, ...containers, createFakeData, supportedCountries, EMAIL_DOMAIN };
