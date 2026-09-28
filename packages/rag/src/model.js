function createLocalEmbedder({ modelId, load, prefixes = { query: '', passage: '' } } = {}) {
  if (!modelId || typeof load !== 'function') throw new TypeError('INVALID_LOCAL_MODEL');
  let loading;
  return {
    modelId,
    async embed(texts, { kind = 'passage' } = {}) {
      if (!texts.length) return [];
      loading ||= Promise.resolve().then(load).catch((error) => { loading = null; throw error; });
      const model = await loading;
      const run = typeof model === 'function' ? model : model.embed?.bind(model);
      if (!run) throw new TypeError('INVALID_LOCAL_MODEL');
      return run(texts.map((text) => `${prefixes[kind] ?? ''}${text}`), { kind, modelId });
    }
  };
}
module.exports = { createLocalEmbedder };
