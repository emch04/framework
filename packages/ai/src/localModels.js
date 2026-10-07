'use strict';
const { createTokenFileReader, serviceRequest, endpoint, AiServiceError } = require('./serviceHttp');

const LOCAL_VECTOR_MODEL = 'bge-m3-onnx-int8';
const LOCAL_VECTOR_DIMENSIONS = 1024;
const text = (value) => typeof value === 'string' && Boolean(value.trim());
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const array = (value, max, validate) => Array.isArray(value) && value.length > 0 && value.length <= max && value.every(validate);
const probability = (value) => finite(value) && value >= 0 && value <= 1;

function validPcmAudio(audio) {
  if (typeof audio !== 'string' || !audio || audio.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(audio)) return false;
  const size = audio.length / 4 * 3 - (audio.endsWith('==') ? 2 : audio.endsWith('=') ? 1 : 0);
  return size >= 6400 && size <= 960000 && size % 2 === 0;
}

function createLocalModelsClient(options = {}) {
  const circuits = new Map();
  const now = options.now || Date.now;
  const token = createTokenFileReader({ tokenFile: options.tokenFile, read: options.readTokenFile, now, refreshMs: options.tokenRefreshMs });
  const model = options.vectorModel || LOCAL_VECTOR_MODEL;
  const dimensions = options.vectorDimensions || LOCAL_VECTOR_DIMENSIONS;
  const circuit = (path) => {
    if (!circuits.has(path)) circuits.set(path, { failures: 0, until: 0, probing: false });
    return circuits.get(path);
  };
  const report = (error, route) => {
    if (typeof options.onError === 'function') {
      try { options.onError(error, route); } catch { /* Diagnostics must not break an optional model. */ }
    }
  };
  async function call(path, body, settings, defaultTimeout, validate) {
    const state = circuit(path);
    if (!options.baseUrl || now() < state.until || state.probing) return null;
    const probe = state.until > 0;
    if (probe) state.probing = true;
    try {
      const bearer = await token();
      const timeoutMs = settings.timeoutMs ?? options.timeoutMs ?? defaultTimeout;
      const result = await serviceRequest(endpoint(options.baseUrl, path), {
        fetch: options.fetch, timeoutMs, signal: settings.signal, body,
        headers: { 'X-Delai-Ms': String(timeoutMs), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }
      });
      const value = validate(result);
      if (value === null) throw new AiServiceError('AI_SERVICE_RESPONSE');
      Object.assign(state, { failures: 0, until: 0 });
      return value;
    } catch (error) {
      if (settings.signal?.aborted) throw settings.signal.reason;
      if (error.status >= 400 && error.status < 500) Object.assign(state, { failures: 0, until: 0 });
      else {
        state.failures += 1;
        if (probe || state.failures >= (options.maxFailures ?? 3)) state.until = now() + (options.cooldownMs ?? 60000);
      }
      report(error, path);
      return null;
    } finally { state.probing = false; }
  }
  function invalid(path) { report(new AiServiceError('AI_SERVICE_INPUT'), path); return null; }
  async function reclasser(question, passages, settings = {}) {
    if (!text(question) || !array(passages, 50, (p) => typeof p === 'string')) return invalid('/reclasser');
    return call('/reclasser', { question, passages }, settings, 1000, (data) => Array.isArray(data?.scores) && data.scores.length === passages.length && data.scores.every(finite) ? data.scores : null);
  }
  async function nli(paires, settings = {}) {
    if (!array(paires, 20, (pair) => text(pair?.premisse) && text(pair?.hypothese))) return invalid('/nli');
    return call('/nli', { paires }, settings, 1500, (data) => Array.isArray(data?.resultats) && data.resultats.length === paires.length && data.resultats.every((r) => probability(r?.accord) && probability(r?.neutre) && probability(r?.contradiction)) ? data.resultats : null);
  }
  async function entites(texte, etiquettes, settings = {}) {
    if (!text(texte) || texte.length > 8000 || !array(etiquettes, 10, (label) => text(label) && label.length <= 50)) return invalid('/entites');
    const labels = new Set(etiquettes.map((label) => label.trim()));
    return call('/entites', { texte, etiquettes }, settings, 800, (data) => Array.isArray(data?.entites) && data.entites.every((e) => typeof e.texte === 'string' && labels.has(e.type) && Number.isInteger(e.debut) && Number.isInteger(e.fin) && e.debut >= 0 && e.fin > e.debut && e.fin <= texte.length && probability(e.score)) ? data.entites : null);
  }
  async function vecteurs(textes, settings = {}) {
    if (!array(textes, 32, (t) => text(t) && t.length <= 2000)) return invalid('/vecteurs');
    return call('/vecteurs', { textes }, settings, 1500, (data) => {
      if (data?.modele !== model || data.dimensions !== dimensions || !Array.isArray(data.vecteurs) || data.vecteurs.length !== textes.length || !data.vecteurs.every((v) => Array.isArray(v) && v.length === dimensions && v.every(finite))) return null;
      Object.defineProperties(data.vecteurs, { modele: { value: model }, dimensions: { value: dimensions } });
      return data.vecteurs;
    });
  }
  async function transcrire(audio, { langue, vocabulaire = '', ...settings } = {}) {
    if (!validPcmAudio(audio) || !['fr', 'en', 'es', 'ln'].includes(langue) || typeof vocabulaire !== 'string' || vocabulaire.length > 600) return invalid('/transcrire');
    return call('/transcrire', { audio, langue, vocabulaire }, settings, 15000, (data) => typeof data?.texte === 'string' && text(data.langue) && finite(data.logprob) && probability(data.sans_parole) && finite(data.duree_ms) && data.duree_ms >= 0
      ? { texte: data.texte, langue: data.langue, logprob: data.logprob, sansParole: data.sans_parole, dureeMs: data.duree_ms } : null);
  }
  const disponible = (path) => Boolean(options.baseUrl) && now() >= circuit(path).until && !circuit(path).probing;
  // English adapters plug directly into the package's generic source/mask APIs.
  async function compare(pairs, settings = {}) {
    if (!Array.isArray(pairs)) return invalid('/nli');
    const results = await nli(pairs.map((pair) => ({ premisse: pair?.premise, hypothese: pair?.hypothesis })), settings);
    return results?.map((result) => ({ entailment: result.accord, neutral: result.neutre, contradiction: result.contradiction })) ?? null;
  }
  async function entities(value, labels, settings = {}) {
    const results = await entites(value, labels, settings);
    return results?.map((entity) => ({ text: entity.texte, type: entity.type, start: entity.debut, end: entity.fin, score: entity.score })) ?? null;
  }
  return { reclasser, rerank: reclasser, nli, comparer: nli, compare, entites, entities, vecteurs, embed: vecteurs, transcrire, disponible, available: disponible };
}
module.exports = { createLocalModelsClient, LOCAL_VECTOR_MODEL, LOCAL_VECTOR_DIMENSIONS, validPcmAudio };
