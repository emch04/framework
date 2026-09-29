const { normalizeDocument, contentHash } = require('./documents');
const { chunkBlocks } = require('./chunk');
const IDLE = { code: 'SKIPPED', added: 0, removed: 0, kept: 0, sources: 0, unchanged: 0, failed: 0, parked: 0, remaining: false, ms: 0 };
// Un magasin ou un vectoriseur peut être fourni par une fonction, relue à chaque passe (le modèle d'une application peut changer sous un `watch` de longue durée).
const resolve = (value) => typeof value === 'function' ? value() : value;
const readable = (doc) => [doc.title, doc.text, doc.context].filter(Boolean).join('\n');
// Une erreur `fatal` (vectoriseur injoignable, mauvais modèle, dimension refusée) termine la passe : chaque source échouerait de la même façon.
const isFatal = (error) => error?.fatal === true || error?.code === 'EMBEDDER_UNAVAILABLE';
const fatal = (message) => Object.assign(new TypeError(message), { fatal: true });
const reason = (error) => String(error?.message ?? error).slice(0, 200);
// Les passages à vectoriser, par tranches d'un lot du vectoriseur : chaque tranche est écrite dès qu'elle est calculée.
function slices(docs, size, characters) {
  const result = []; let current = []; let chars = 0;
  for (const doc of docs) {
    const length = readable(doc).length;
    if (current.length && (current.length >= size || chars + length > characters)) { result.push(current); current = []; chars = 0; }
    current.push(doc); chars += length;
  }
  if (current.length) result.push(current);
  return result;
}
// Une source dont l'application a déjà fait les passages (`chunks`) ne passe ni par la normalisation ni par le découpage.
function prepare(source, id, { extractors, chunk }) {
  if (Array.isArray(source.chunks)) {
    const chunks = source.chunks.map((part) => {
      if (!part || typeof part.text !== 'string') throw new TypeError('INVALID_CHUNKS');
      const hash = part.contentHash ?? contentHash({ text: part.text, context: part.context ?? '', title: part.title ?? '', metadata: part.metadata ?? {} });
      return { ...part, contentHash: hash, id: part.id ?? `${id}:${hash}` };
    });
    return { title: source.title ?? '', metadata: source.metadata || {}, version: source.version ?? null, chunks, signature: contentHash(chunks.map((part) => [part.id, part.contentHash])) };
  }
  const normalized = normalizeDocument({ ...source, id }, { extractors });
  const chunks = chunk(normalized.blocks, { sourceId: id, context: normalized.title, minLength: 1, ...(source.chunkOptions || {}) });
  return { title: normalized.title, metadata: normalized.metadata, version: normalized.version, chunks, signature: contentHash(normalized.blocks) };
}
function createIndexer({ sources, store, embedder, chunk = chunkBlocks, extractors, lock, lockName = 'rag:index', lockHoldMs = 60_000, maxPassages = Infinity, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, logger } = {}) {
  if (!sources || typeof sources.list !== 'function' || !store || !embedder || !(maxPassages > 0)) throw new TypeError('INVALID_INDEXER');
  let running = false;
  let watching = false;
  const read = async (source) => typeof source.read === 'function' ? { ...source, ...await source.read() } : source;
  async function run({ full = false, maxPassages: bound = maxPassages } = {}) {
    if (running) return { ...IDLE };
    const work = async () => {
      running = true;
      const started = now();
      const stats = { code: 'OK', added: 0, removed: 0, kept: 0, sources: 0, unchanged: 0, failed: 0, parked: 0, remaining: false, ms: 0 };
      try {
        const target = resolve(store);
        const model = resolve(embedder);
        const modelId = model.modelId;
        // Un magasin incrémental écrit tranche par tranche et ne charge jamais les vecteurs déjà stockés ; les autres remplacent une source d'un bloc.
        const incremental = ['listSourceChunkIds', 'putDocuments', 'commitSource'].every((name) => typeof target[name] === 'function');
        const limits = { batchSize: 32, maxBatchCharacters: 16_000, ...model.limits };
        const listed = await sources.list({ full });
        const seen = new Set();
        for await (const entry of listed) {
          if (!entry?.id || seen.has(String(entry.id))) continue;
          const id = String(entry.id);
          seen.add(id);
          // Une empreinte connue sans lire la source (taille et date d'un fichier, révision d'une ligne) évite de la lire quand le magasin la tient déjà pour ce modèle.
          const wanted = entry.fingerprint === undefined || entry.fingerprint === null ? null : `${entry.fingerprint}:${modelId}`;
          try {
            if (wanted !== null && await target.getSourceVersion(id) === wanted) { stats.sources++; stats.unchanged++; continue; }
            // Borne atteinte : les sources qui restent à faire attendent la passe suivante, celles qui n'ont rien à faire ne comptent pas.
            if (stats.added >= bound) { stats.remaining = true; continue; }
            stats.sources++;
            const source = await read(entry);
            const prepared = prepare(source, id, { extractors, chunk });
            const version = wanted ?? `${prepared.version ?? ''}:${prepared.signature}:${modelId}`;
            if (wanted === null && await target.getSourceVersion(id) === version) { stats.unchanged++; continue; }
            const previous = incremental ? [] : await target.getSourceDocuments(id);
            const held = incremental ? new Set(await target.listSourceChunkIds(id, modelId)) : new Map(previous.filter((doc) => doc.modelId === modelId).map((doc) => [doc.id, doc]));
            const occurrences = new Map();
            const pending = [];
            const documents = [];
            let keptHere = 0;
            for (const part of prepared.chunks) {
              const count = occurrences.get(part.id) || 0;
              occurrences.set(part.id, count + 1);
              const chunkId = `${part.id}:${count}`;
              const existing = incremental ? (held.has(chunkId) ? { vector: null } : null) : held.get(chunkId);
              const doc = { ...prepared.metadata, ...(part.metadata || {}), id: chunkId, sourceId: id, documentId: id, version, title: part.title ?? prepared.title, text: part.text, context: part.context ?? '', numbers: part.numbers ?? [], contentHash: part.contentHash, modelId, vector: existing?.vector ?? null };
              if (existing) keptHere++;
              else pending.push(doc);
              documents.push(doc);
            }
            // Un lot va aussi vite que son passage le plus long : les passages de longueur voisine partent ensemble.
            pending.sort((a, b) => readable(a).length - readable(b).length);
            for (const slice of slices(pending, limits.batchSize, limits.maxBatchCharacters)) {
              const embedded = await model.embedTexts(slice.map(readable), { kind: 'passage' });
              if (!embedded || embedded.modelId !== modelId || embedded.vectors?.length !== slice.length) throw fatal('EMBEDDING_UNAVAILABLE');
              slice.forEach((doc, index) => { doc.vector = embedded.vectors[index]; });
              if (incremental) {
                await target.putDocuments(id, slice);
                slice.forEach((doc) => { doc.vector = null; });
                stats.added += slice.length;
              }
            }
            if (incremental) stats.removed += (await target.commitSource(id, version, documents.map((doc) => doc.id))).removed;
            else {
              await target.replaceSource(id, version, documents);
              stats.added += pending.length;
              stats.removed += previous.length - keptHere;
            }
            stats.kept += keptHere;
          } catch (error) {
            if (isFatal(error)) throw error;
            stats.failed++;
            // Une source dont l'empreinte est connue et que le magasin peut noter en échec n'est relue qu'une fois changée ; ses anciens passages restent.
            const parked = wanted !== null && typeof target.noteSourceFailure === 'function' ? await (async () => target.noteSourceFailure(id, wanted, error))().catch(() => false) : false;
            if (parked) stats.parked++;
            logger?.warn?.({ code: 'SOURCE_INDEX_FAILED', sourceId: id, reason: reason(error) });
          }
        }
        // `seen` couvre aussi les sources laissées à la passe suivante : une borne atteinte ne les fait jamais passer pour disparues.
        if (full) for (const id of await target.listSourceIds()) if (!seen.has(id)) stats.removed += await target.removeSource(id);
        stats.ms = now() - started;
        return stats;
      } finally { running = false; }
    };
    if (!lock) return work();
    const result = await lock.run(lockName, lockHoldMs, work);
    return result === null ? { ...IDLE } : result;
  }
  function watch({ shortEveryMs = 30_000, fullEveryMs = 600_000, pauseAfterFailureMs = 300_000, onRun, onError } = {}) {
    if (watching) throw new TypeError('WATCH_ALREADY_RUNNING');
    if (!(shortEveryMs > 0 && fullEveryMs > 0 && pauseAfterFailureMs > 0)) throw new TypeError('INVALID_SCHEDULE');
    watching = true;
    let stopped = false; let timer; let wake; let lastFull = -Infinity;
    const notify = (hook, ...args) => { try { hook?.(...args); } catch (_error) { logger?.warn?.({ code: 'WATCH_HOOK_FAILED' }); } };
    const loop = (async () => {
      try {
        while (!stopped) {
          const full = now() - lastFull >= fullEveryMs;
          let delay = shortEveryMs;
          try {
            const result = await run({ full });
            // Une passe complète arrêtée à sa borne n'est pas finie : la suivante est encore complète.
            if (full && result.code === 'OK' && !result.remaining) lastFull = now();
            // Une source notée en échec n'est pas relue avant d'avoir changé : elle ne justifie pas la pause.
            if (result.failed > result.parked) delay = pauseAfterFailureMs;
            notify(onRun, result, { full });
          } catch (error) { logger?.warn?.({ code: 'INDEX_RUN_FAILED' }); notify(onError, error); delay = pauseAfterFailureMs; }
          if (stopped) break;
          await new Promise((resolveWait) => { wake = resolveWait; timer = setTimer(resolveWait, delay); });
          wake = null; timer = undefined;
        }
      } finally { watching = false; }
    })();
    return { async stop() { stopped = true; if (timer !== undefined) clearTimer(timer); wake?.(); await loop; } };
  }
  return { run, watch };
}
module.exports = { createIndexer };
