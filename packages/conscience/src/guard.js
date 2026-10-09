'use strict';
/*
 * Memory guard (34). Everything this package stores (context, observations,
 * lessons, corrections) is untrusted data: it may have been written by a
 * person, a tool or a model that was itself manipulated. Nothing here ever
 * reads stored text as an instruction, and the helpers below frame it before
 * a future model reads it, with the framing of @astratra/ai/guards.
 */
const { frameUntrusted } = require('@astratra/ai/guards');

/** Frames one stored text as data for a model. */
function frameStoredText(text, { source = 'conscience-memory', nonce } = {}) {
  return frameUntrusted(String(text ?? ''), { source, nonce });
}

/** Frames records (decisions, outcomes, lessons...) as one JSON block of data. */
function frameRecordsForModel(records, { source = 'conscience-memory', nonce } = {}) {
  return frameUntrusted(JSON.stringify(records ?? [], null, 2), { source, nonce });
}

module.exports = { frameStoredText, frameRecordsForModel };
