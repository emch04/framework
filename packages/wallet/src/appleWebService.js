const express = require('express');
const { asyncHandler } = require('@astratra/core');

/**
 * Le service web qu'Apple Wallet appelle pour tenir une carte à jour, selon le
 * protocole d'Apple (monté sous le `webServiceURL` de la carte) :
 *
 *   POST   /v1/devices/:device/registrations/:passType/:serial   inscrire un appareil
 *   GET    /v1/devices/:device/registrations/:passType           cartes changées depuis
 *   GET    /v1/passes/:passType/:serial                          dernière version
 *   DELETE /v1/devices/:device/registrations/:passType/:serial   désinscrire
 *   POST   /v1/log                                               erreurs remontées par l'appareil
 *
 * Tout ce qui touche à une carte précise exige l'en-tête
 * `Authorization: ApplePass <authenticationToken>` de cette carte.
 *
 * @param {object} options
 * @param {() => Promise<{passTypeIdentifier: string} | null>} options.resolveConfig
 *        null tant qu'Apple Wallet n'est pas configuré (503) — relu à chaque appel,
 *        pour que des clés changées prennent effet sans redémarrage.
 * @param {(serialNumber: string) => Promise<{authenticationToken: string, updatedAt?: Date|string} | null>} options.findPass
 * @param {(serialNumber: string) => Promise<Buffer>} options.buildPass
 * @param {object} options.registrations  voir registrations.js.
 * @param {{warn: Function}} [options.logger=console]
 */
function createAppleWebServiceRouter({ resolveConfig, findPass, buildPass, registrations, logger = console }) {
  const router = express.Router();

  async function contexte(req, res, { authentifier = true } = {}) {
    const config = await resolveConfig();
    if (!config) {
      res.sendStatus(503);
      return null;
    }
    if (req.params.passTypeIdentifier !== config.passTypeIdentifier) {
      res.sendStatus(404);
      return null;
    }
    if (!req.params.serialNumber) return { config };
    const pass = await findPass(req.params.serialNumber);
    if (!pass) {
      res.sendStatus(404);
      return null;
    }
    if (authentifier && req.get('authorization') !== `ApplePass ${pass.authenticationToken}`) {
      res.sendStatus(401);
      return null;
    }
    return { config, pass };
  }

  router.post('/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber', asyncHandler(async (req, res) => {
    if (!await contexte(req, res)) return undefined;
    if (!req.body?.pushToken || typeof req.body.pushToken !== 'string') return res.sendStatus(400);
    const { deviceLibraryIdentifier, passTypeIdentifier, serialNumber } = req.params;
    const nouvelle = await registrations.register({ deviceLibraryIdentifier, passTypeIdentifier, serialNumber, pushToken: req.body.pushToken });
    return res.sendStatus(nouvelle ? 201 : 200);
  }));

  router.get('/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier', asyncHandler(async (req, res) => {
    if (!await contexte(req, res)) return undefined;
    const { deviceLibraryIdentifier, passTypeIdentifier } = req.params;
    const inscriptions = await registrations.listForDevice(deviceLibraryIdentifier, passTypeIdentifier);
    const depuis = req.query.passesUpdatedSince ? new Date(req.query.passesUpdatedSince) : new Date(0);
    const cartes = (await Promise.all(inscriptions.map(async ({ serialNumber }) => {
      const pass = await findPass(serialNumber);
      return pass ? { serialNumber, updatedAt: new Date(pass.updatedAt || 0) } : null;
    }))).filter(Boolean);
    const changees = cartes.filter(({ updatedAt }) => Number.isNaN(depuis.getTime()) || updatedAt > depuis);
    if (!changees.length) return res.sendStatus(204);
    return res.json({
      serialNumbers: changees.map(({ serialNumber }) => serialNumber),
      lastUpdated: new Date(Math.max(...changees.map(({ updatedAt }) => updatedAt.getTime()))).toISOString()
    });
  }));

  router.get('/v1/passes/:passTypeIdentifier/:serialNumber', asyncHandler(async (req, res) => {
    const ctx = await contexte(req, res);
    if (!ctx) return undefined;
    res.type('application/vnd.apple.pkpass');
    res.set('Last-Modified', new Date(ctx.pass.updatedAt || Date.now()).toUTCString());
    return res.send(await buildPass(req.params.serialNumber));
  }));

  router.delete('/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber', asyncHandler(async (req, res) => {
    if (!await contexte(req, res)) return undefined;
    const { deviceLibraryIdentifier, passTypeIdentifier, serialNumber } = req.params;
    await registrations.unregister({ deviceLibraryIdentifier, passTypeIdentifier, serialNumber });
    return res.sendStatus(200);
  }));

  router.post('/v1/log', (req, res) => {
    for (const message of req.body?.logs || []) logger.warn(`Apple Wallet: ${String(message)}`);
    res.sendStatus(200);
  });

  return router;
}

module.exports = { createAppleWebServiceRouter };
