'use strict';
const TASK_STATES = Object.freeze(['pending', 'running', 'waiting_confirmation', 'completed', 'failed', 'cancelled']);
const copy = (value) => value == null ? null : JSON.parse(JSON.stringify(value));
function validateTask(task) {
  if (!task || typeof task.id !== 'string' || !task.id || !TASK_STATES.includes(task.state)) throw new Error('Invalid task.');
  return copy(task);
}
function createMemoryTaskStore({ now = Date.now } = {}) {
  const tasks = new Map();
  const locks = new Map();
  const owned = (id, owner) => { const lock = locks.get(id); return lock?.owner === owner && lock.until > now(); };
  return {
    async create(task) { const data = validateTask(task); if (tasks.has(data.id)) throw new Error('Task already exists.'); tasks.set(data.id, data); return copy(data); },
    async get(id) { return copy(tasks.get(id)); },
    async acquire(id, owner, leaseMs) {
      if (!tasks.has(id)) return false;
      const lock = locks.get(id);
      if (lock && lock.until > now()) return false;
      locks.set(id, { owner, until: now() + leaseMs }); return true;
    },
    async renew(id, owner, leaseMs) { if (!owned(id, owner)) return false; locks.set(id, { owner, until: now() + leaseMs }); return true; },
    async save(task, owner) { const data = validateTask(task); if (!owned(data.id, owner)) throw new Error('Task lock lost.'); tasks.set(data.id, data); return copy(data); },
    async release(id, owner) { if (locks.get(id)?.owner === owner) locks.delete(id); }
  };
}
module.exports = { TASK_STATES, validateTask, createMemoryTaskStore };
