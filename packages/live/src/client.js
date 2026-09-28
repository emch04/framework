'use strict';

const SERVER_REASONS = new Set([
  'UNAVAILABLE', 'BUSY', 'DAILY_LIMIT', 'GROUP_LIMIT', 'SUSPENDED',
  'ORIGIN', 'PLAN', 'QUOTA_EXHAUSTED', 'LOCAL_UNAVAILABLE', 'PROVIDER_UNAVAILABLE',
  'CALL_LIMIT', 'IDLE', 'REPLACED', 'SERVER_CLOSED'
]);
function serverReason(reason) {
  return typeof reason === 'string' && SERVER_REASONS.has(reason) ? reason : null;
}
function closeOutcome(code, {
  reason = null,
  refreshed = false
} = {}) {
  if (reason === 'IDLE' || reason === 'CALL_LIMIT' || reason === 'SERVER_CLOSED') {
    return { kind: 'ended', code: reason };
  }
  if (serverReason(reason)) return {
    kind: 'failed',
    code: reason
  };
  if (code === 1000) return {
    kind: 'ended'
  };
  if (code === 4401) return refreshed ? {
    kind: 'failed',
    code: 'SESSION'
  } : {
    kind: 'refresh'
  };
  if (code === 4409) return {
    kind: 'failed',
    code: 'REPLACED'
  };
  if (code === 4429) return {
    kind: 'failed',
    code: 'BUSY'
  };
  if (code === 4503 || code === 1011 || code === 4403) return {
    kind: 'failed',
    code: 'UNAVAILABLE'
  };
  return {
    kind: 'failed',
    code: 'NETWORK'
  };
}
function nextSubtitle(state = {
  text: '',
  fresh: true
}, event) {
  if (event.type === 'said') return {
    text: state.fresh ? event.text : state.text + event.text,
    fresh: false
  };
  return state.fresh ? state : {
    ...state,
    fresh: true
  };
}
function subtitleTail(text, max = 110) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const tail = clean.slice(-max);
  const space = tail.indexOf(' ');
  return `…${space >= 0 && space < max / 3 ? tail.slice(space + 1) : tail}`;
}
function nextConsent(state, event) {
  if (event.type === 'confirm') return {
    actionId: event.actionId,
    readback: ''
  };
  if (!state) return null;
  if (event.type === 'said') return {
    ...state,
    readback: state.readback + event.text
  };
  if ((event.type === 'action_done' || event.type === 'action_cancelled') && event.actionId === state.actionId) return null;
  return state;
}
function nextTranscript(turns, event) {
  const role = event.type === 'heard' ? 'user' : event.type === 'said' ? 'assistant' : null;
  if (!role || !event.text) return turns;
  const previous = turns.at(-1);
  if (previous?.role === role) return [...turns.slice(0, -1), {
    role,
    text: previous.text + event.text
  }];
  return [...turns, {
    role,
    text: event.text
  }];
}
function cleanTranscript(turns) {
  return turns.map(turn => ({
    ...turn,
    text: String(turn.text || '').replace(/\s+/g, ' ').trim()
  })).filter(turn => turn.text);
}
function nextHeard(state = {
  text: '',
  fresh: true,
  uncertain: false
}, event) {
  if (event.type !== 'heard') return state.fresh ? state : {
    ...state,
    fresh: true
  };
  return {
    text: state.fresh ? event.text : state.text + event.text,
    fresh: false,
    uncertain: Boolean(event.uncertain)
  };
}
function callUrl(baseUrl, {
  path = '/live',
  language,
  conversationId,
  mode
} = {}) {
  const base = String(baseUrl).trim().replace(/\/+$/, '').replace(/^http(s?):/i, (_all, secure) => `ws${secure}:`);
  const params = [`lang=${encodeURIComponent(language || '')}`];
  if (conversationId) params.push(`conversation=${encodeURIComponent(conversationId)}`);
  if (mode) params.push(`mode=${encodeURIComponent(mode)}`);
  return `${base}${path}?${params.join('&')}`;
}
function languageCode(value, supported = [], fallback = 'en') {
  const code = String(value || '').toLowerCase().split(/[-_]/)[0];
  return supported.includes(code) ? code : fallback;
}
module.exports = {
  serverReason,
  closeOutcome,
  nextSubtitle,
  subtitleTail,
  nextConsent,
  nextTranscript,
  cleanTranscript,
  nextHeard,
  callUrl,
  languageCode
};
