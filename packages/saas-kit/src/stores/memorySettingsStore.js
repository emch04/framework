function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createMemorySettingsStore(initialSettings = {}) {
  // Dev-only adapter: stores settings in process memory and is not persistent.
  const settings = new Map(Object.entries(initialSettings));

  return {
    async get(key) {
      return settings.has(key) ? clone(settings.get(key)) : null;
    },

    async set(key, value) {
      settings.set(key, clone(value));
      return clone(value);
    },

    async getAll() {
      return Object.fromEntries([...settings.entries()].map(([key, value]) => [key, clone(value)]));
    }
  };
}

module.exports = createMemorySettingsStore;
