/**
 * The phones a person receives notifications on.
 *
 * Keyed on the INSTALLATION id, not on the push token: the push token changes
 * on reinstall, on restore, whenever the platform feels like it. Keyed on the
 * token, one phone becomes six rows, five of them dead, and every send gets
 * slower and noisier.
 *
 * Dev-only adapter: in process memory, lost on restart.
 */
function createMemoryDevicesStore() {
  const devices = new Map();

  return {
    async upsert(device) {
      const existing = devices.get(device.installationId);
      const record = { ...(existing || {}), ...device, enabled: device.enabled !== false };
      devices.set(record.installationId, record);
      return { ...record };
    },
    async find(installationId) {
      const record = devices.get(installationId);
      return record ? { ...record } : null;
    },
    async listForUser(userId) {
      return [...devices.values()]
        .filter((device) => device.userId === userId)
        .map((device) => ({ ...device }));
    },
    async remove(installationId) {
      return devices.delete(installationId);
    }
  };
}

module.exports = createMemoryDevicesStore;
