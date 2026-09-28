const { normalizeDocument, contentHash } = require('./documents');
const { chunkBlocks } = require('./chunk');
function createIndexer({ sources, store, embedder, chunk = chunkBlocks, extractors, lock, lockName = 'rag:index', lockHoldMs = 60_000, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, logger } = {}) {
  if (!sources || typeof sources.list !== 'function' || !store || !embedder) throw new TypeError('INVALID_INDEXER');
  let running = false;
  let watching = false;
  const read = async (source) => typeof source.read === 'function' ? { ...source, ...await source.read() } : source;
  async function run({ full = false } = {}) {
    if (running) return { code: 'SKIPPED', added: 0, removed: 0, kept: 0, sources: 0, unchanged: 0, failed: 0, ms: 0 };
    const work = async () => {
      running = true;
      const started = now();
      const stats = { code: 'OK', added: 0, removed: 0, kept: 0, sources: 0, unchanged: 0, failed: 0, ms: 0 };
      try {
        const listed = await sources.list({ full });
        const seen = new Set();
        for await (const entry of listed) {
          if (!entry?.id || seen.has(String(entry.id))) continue;
          const id = String(entry.id);
          seen.add(id);
          stats.sources++;
          try {
            const source = await read(entry);
            const normalized = normalizeDocument({ ...source, id }, { extractors });
            const chunks = chunk(normalized.blocks, { sourceId: id, context: normalized.title, minLength: 1, ...(source.chunkOptions || {}) });
            const version = `${normalized.version ?? ''}:${contentHash(normalized.blocks)}:${embedder.modelId}`;
            const oldVersion = await store.getSourceVersion(id);
            if (oldVersion === version) { stats.unchanged++; continue; }
            const previous = await store.getSourceDocuments(id);
            const oldById = new Map(previous.filter((doc) => doc.modelId === embedder.modelId).map((doc) => [doc.id, doc]));
            const occurrences = new Map();
            const pending = [];
            let keptHere = 0;
            const documents = chunks.map((part) => {
              const count = occurrences.get(part.id) || 0;
              occurrences.set(part.id, count + 1);
              const chunkId = `${part.id}:${count}`;
              const existing = oldById.get(chunkId);
              const doc = { ...normalized.metadata, id: chunkId, sourceId: id, documentId: id, version, title: normalized.title, text: part.text, context: part.context, numbers: part.numbers, contentHash: part.contentHash, modelId: embedder.modelId, vector: existing?.vector || null };
              if (existing) { stats.kept++; keptHere++; }
              else pending.push(doc);
              return doc;
            });
            if (pending.length) {
              const embedded = await embedder.embedTexts(pending.map((doc) => [doc.title, doc.text, doc.context].filter(Boolean).join('\n')), { kind: 'passage' });
              if (!embedded || embedded.modelId !== embedder.modelId) throw new TypeError('EMBEDDING_UNAVAILABLE');
              pending.forEach((doc, index) => { doc.vector = embedded.vectors[index]; });
            }
            await store.replaceSource(id, version, documents);
            stats.added += pending.length;
            stats.removed += previous.length - keptHere;
          } catch (_error) { stats.failed++; logger?.warn?.({ code: 'SOURCE_INDEX_FAILED', sourceId: id }); }
        }
        if (full) for (const id of await store.listSourceIds()) if (!seen.has(id)) stats.removed += await store.removeSource(id);
        stats.ms = now() - started;
        return stats;
      } finally { running = false; }
    };
    if (!lock) return work();
    const result = await lock.run(lockName, lockHoldMs, work);
    return result === null ? { code: 'SKIPPED', added: 0, removed: 0, kept: 0, sources: 0, unchanged: 0, failed: 0, ms: 0 } : result;
  }
  function watch({ shortEveryMs = 30_000, fullEveryMs = 600_000, pauseAfterFailureMs = 300_000 } = {}) {
    if (watching) throw new TypeError('WATCH_ALREADY_RUNNING');
    if (!(shortEveryMs > 0 && fullEveryMs > 0 && pauseAfterFailureMs > 0)) throw new TypeError('INVALID_SCHEDULE');
    watching = true;
    let stopped = false; let timer; let wake; let lastFull = -Infinity;
    const loop = (async () => {
      try {
        while (!stopped) {
          const full = now() - lastFull >= fullEveryMs;
          let delay = shortEveryMs;
          try {
            const result = await run({ full });
            if (full && result.code === 'OK') lastFull = now();
            if (result.failed) delay = pauseAfterFailureMs;
          } catch (_error) { logger?.warn?.({ code: 'INDEX_RUN_FAILED' }); delay = pauseAfterFailureMs; }
          if (stopped) break;
          await new Promise((resolve) => { wake = resolve; timer = setTimer(resolve, delay); });
          wake = null; timer = undefined;
        }
      } finally { watching = false; }
    })();
    return { async stop() { stopped = true; if (timer !== undefined) clearTimer(timer); wake?.(); await loop; } };
  }
  return { run, watch };
}
module.exports = { createIndexer };
