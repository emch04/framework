'use strict';
const { FeedbackError, identifier } = require('./model');

const BODY_FIELDS = ['rating', 'reason', 'comment', 'messageId'];
const view = (f) => ({ id: f.id, runId: f.runId, messageId: f.messageId, rating: f.rating, reason: f.reason, comment: f.comment, createdAt: f.createdAt, updatedAt: f.updatedAt });
const send = (res, status, message, data = null) => res.status(status).json({ success: status < 400, message, data, timestamp: new Date().toISOString(), ...(status >= 400 ? { error: message } : {}) });

/**
 * Express router for one person's feedback on one run.
 *
 *   POST   /runs/:runId/feedback   give (or replace) — 201 created, 200 replaced
 *   PATCH  /runs/:runId/feedback   modify some fields
 *   GET    /runs/:runId/feedback   read
 *   DELETE /runs/:runId/feedback   withdraw — 204
 *
 * `identify(req)` returns `{ userId, tenantId? }` or a falsy value (401).
 * `resolveRun(req, runId, identity)` must return the run only if it belongs to
 * that person; anything falsy answers 404, same as an unknown run.
 */
function createFeedbackRouter(options = {}) {
  const { feedback, identify, resolveRun } = options;
  if (!feedback || typeof feedback.give !== 'function') throw new Error('createFeedbackRouter requires feedback from createFeedback().');
  if (typeof identify !== 'function' || typeof resolveRun !== 'function') throw new Error('createFeedbackRouter requires identify and resolveRun.');
  let express = options.express;
  if (!express) {
    try { express = require('express'); } catch (_error) { throw new Error('createFeedbackRouter needs express: install it or pass options.express.'); }
  }
  const router = express.Router();
  router.use(express.json({ limit: options.maxBodyBytes ?? 8192, strict: true }));

  async function guard(req, res, next) {
    try {
      const identity = await identify(req);
      if (!identity || typeof identity.userId !== 'string' || !identity.userId) return send(res, 401, 'Authentication required.');
      let runId;
      try { runId = identifier(req.params.runId, 'runId'); } catch (_error) { return send(res, 400, 'Invalid run id.'); }
      const run = await resolveRun(req, runId, identity);
      if (!run) return send(res, 404, 'Run not found.');
      req.feedbackContext = { key: { tenantId: identity.tenantId ?? null, userId: identity.userId, runId }, run: typeof run === 'object' ? run : {} };
      return next();
    } catch (error) { return next(error); }
  }
  function bodyOf(req) {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new FeedbackError('invalid', 'A JSON object body is required.');
    for (const field of Object.keys(body)) if (!BODY_FIELDS.includes(field)) throw new FeedbackError('invalid', `Unknown field: ${field}.`);
    return body;
  }
  const handle = (work) => async (req, res, next) => {
    try { return await work(req, res); } catch (error) {
      if (error instanceof FeedbackError) return send(res, error.status, error.message);
      return next(error);
    }
  };
  const path = '/runs/:runId/feedback';
  router.post(path, guard, handle(async (req, res) => {
    const { key, run } = req.feedbackContext;
    const { feedback: saved, created } = await feedback.give({ ...bodyOf(req), agent: run.agent, mode: run.mode, ...key });
    return send(res, created ? 201 : 200, created ? 'Feedback recorded.' : 'Feedback replaced.', view(saved));
  }));
  router.patch(path, guard, handle(async (req, res) => send(res, 200, 'Feedback updated.', view(await feedback.update(req.feedbackContext.key, bodyOf(req))))));
  router.get(path, guard, handle(async (req, res) => {
    const found = await feedback.get(req.feedbackContext.key);
    return found ? send(res, 200, 'Feedback found.', view(found)) : send(res, 404, 'No feedback.');
  }));
  router.delete(path, guard, handle(async (req, res) => {
    if (!await feedback.remove(req.feedbackContext.key)) return send(res, 404, 'No feedback.');
    return res.status(204).end();
  }));
  router.use((error, _req, res, next) => {
    if (error?.type === 'entity.too.large') return send(res, 413, 'Body too large.');
    if (error?.type === 'entity.parse.failed' || error?.type === 'encoding.unsupported' || error?.type === 'charset.unsupported') return send(res, 400, 'Invalid JSON body.');
    return next(error);
  });
  return router;
}
module.exports = { createFeedbackRouter };
