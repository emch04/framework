'use strict';

/**
 * Préréglage Jest pour les projets qui utilisent @astratra/testkit.
 *
 * `@faker-js/faker` 10 n'existe qu'en module ES. Node le charge par `require()`
 * (22.12 et plus), mais Jest a son propre chargeur : en CommonJS, il ne sait le
 * faire qu'à partir de Node 24.9 et avec `--experimental-vm-modules`. Ce
 * préréglage fait convertir faker en CommonJS par babel-jest (déjà fourni par
 * Jest), et lui seul parmi les `node_modules`. Le reste du projet garde la
 * transformation par défaut de Jest.
 *
 * Usage, dans la configuration Jest du projet : `preset: '@astratra/testkit'`.
 */
module.exports = {
  transform: {
    '\\.[jt]sx?$': ['babel-jest', { plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')] }]
  },
  transformIgnorePatterns: ['/node_modules/(?!@faker-js/faker/)']
};
