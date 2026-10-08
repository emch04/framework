'use strict';

/* global AbortController, AbortSignal */

/** The error a cancelled synthesis ends with: name `AbortError`, code `ABORTED`, the signal's reason as `cause`. */
function abortError(signal) {
  const error = new Error('ABORTED');
  error.name = 'AbortError';
  error.code = 'ABORTED';
  if (signal && signal.reason !== undefined) error.cause = signal.reason;
  return error;
}

function isSignal(signal) {
  return Boolean(signal) && typeof signal === 'object' && typeof signal.aborted === 'boolean' && typeof signal.addEventListener === 'function';
}

/** Throws `abortError` when the signal has been aborted. Anything that is not a signal is ignored. */
function throwIfAborted(signal) {
  if (isSignal(signal) && signal.aborted) throw abortError(signal);
}

/** The signals that matter together: aborted as soon as one is, plus a timeout when `timeoutMs` is given. */
function combineSignals(signals, timeoutMs) {
  const list = (signals || []).filter(isSignal);
  if (timeoutMs > 0) list.push(AbortSignal.timeout(timeoutMs));
  if (list.length === 1) return list[0];
  if (!list.length) return undefined;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list);
  const controller = new AbortController();
  for (const signal of list) {
    if (signal.aborted) { controller.abort(signal.reason); break; }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

module.exports = { abortError, isSignal, throwIfAborted, combineSignals };
