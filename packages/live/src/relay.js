'use strict';

/**
 * The confidential path where the provider still speaks: the microphone's sound
 * stays on this server and is transcribed here (`transcriber`, sentence by
 * sentence); the provider receives text only, and answers with its own voice,
 * tools and transcription. A sentence the local decoder doubts is never sent: the
 * person is asked to repeat (`repeat`), and after repeated doubt (or a decoder
 * that fails) the policy may move the call to normal, where the sound goes to
 * the provider as it is, the last sentence replayed first.
 *
 * @param {{ transcriber: { push: (base64: string) => Promise<{ text: string, confidence?: number | null, audio?: string }[]>, finish: () => Promise<{ text: string, confidence?: number | null, audio?: string }[]> },
 *           decision: ReturnType<typeof import('@astratra/voice').createConfidentialSession>,
 *           send: (message: object) => void, onHeard: (text: string) => void, onSentence: (text: string) => void,
 *           onFallback: (reason: string, audio?: string) => Promise<void> | void, onUnavailable: () => Promise<void> | void,
 *           minConfidence?: number }} options
 *   `onHeard`: a sentence was transcribed (the call is alive); `onSentence`: it is sure enough to go to the provider
 */
function createTranscribedRelay({ transcriber, decision, send, onHeard, onSentence, onFallback, onUnavailable, minConfidence = 0.35 }) {
  if (!transcriber || typeof transcriber.push !== 'function' || typeof transcriber.finish !== 'function') throw new TypeError('LOCAL_DEPENDENCY_REQUIRED');
  const doubtful = item => Number.isFinite(item.confidence) && item.confidence < minConfidence;
  const sentence = item => String(item?.text ?? '').trim();
  return {
    /** Sound the gates let through, in order (never two at once): the sentences it ends are handled one after the other. */
    async push(base64) {
      let items;
      try {
        items = await transcriber.push(base64);
      } catch (error) {
        const verdict = decision.onLocalFailure();
        if (verdict.mode === 'normal') await onFallback(verdict.reason, typeof error?.audio === 'string' ? error.audio : base64);else if (verdict.state === 'ended') {
          send({
            type: 'error',
            reason: 'LOCAL_UNAVAILABLE'
          });
          await onUnavailable();
        } else send({
          type: 'repeat',
          code: verdict.reason
        });
        return;
      }
      for (const item of items) {
        const text = sentence(item);
        if (!text) continue;
        onHeard(text);
        /* The person sees what was heard, even when it is not trusted. */
        send({
          type: 'heard',
          text,
          ...(doubtful(item) ? {
            uncertain: true
          } : {})
        });
        if (doubtful(item)) {
          const verdict = decision.onDoubt();
          if (verdict.mode === 'normal') {
            await onFallback(verdict.reason, item.audio);
            return;
          }
          send({
            type: 'repeat',
            code: verdict.reason
          });
          continue;
        }
        decision.onAccepted();
        onSentence(text);
      }
    },
    /** What the person was still saying when the call ends: written down, asked again if doubtful, never a reason for the call to fail. */
    async finish() {
      let items;
      try {
        items = await transcriber.finish();
      } catch (_error) {
        return;
      }
      for (const item of items) {
        const text = sentence(item);
        if (!text) continue;
        send({
          type: 'heard',
          text,
          ...(doubtful(item) ? {
            uncertain: true
          } : {})
        });
        if (doubtful(item)) {
          send({
            type: 'repeat'
          });
          continue;
        }
        onSentence(text);
      }
    }
  };
}
module.exports = {
  createTranscribedRelay
};
