'use strict';

function createMemoryMinuteStore({
  now
}) {
  const users = new Map();
  const groups = new Map();
  const day = () => new Date(now()).toISOString().slice(0, 10);
  const key = (...parts) => JSON.stringify([day(), ...parts]);
  return {
    async usedMs(userId, plan, role) {
      return users.get(key(userId, plan, role)) || 0;
    },
    async addMs(userId, plan, role, ms) {
      const id = key(userId, plan, role);
      users.set(id, (users.get(id) || 0) + ms);
    },
    async usedGroupMs(groupId, plan) {
      return groups.get(key(groupId, plan)) || 0;
    },
    async addGroupMs(groupId, plan, ms) {
      const id = key(groupId, plan);
      groups.set(id, (groups.get(id) || 0) + ms);
    }
  };
}
function createMinuteQuota({
  store,
  limits = {},
  now,
  warningBeforeMs = 60000,
  maxCallMs = 1800000,
  countGroup = ctx => Boolean(ctx.groupId)
}) {
  if (typeof now !== 'function') throw new TypeError('CLOCK_REQUIRED');
  const fallback = createMemoryMinuteStore({
    now
  });
  let storeAvailable = true;
  function limitFor(ctx) {
    const value = limits[ctx.plan]?.[ctx.role] ?? limits[ctx.plan]?.default ?? limits[ctx.role] ?? limits.default;
    return value == null ? Infinity : Number(value);
  }
  function groupLimitFor(ctx) {
    if (!countGroup(ctx)) return Infinity;
    const value = limits.groups?.[ctx.plan] ?? limits.groups?.default;
    return value == null ? Infinity : Number(value);
  }
  async function use(method, args) {
    try {
      if (storeAvailable && typeof store?.[method] === 'function') {
        const result = await store[method](...args);
        if (method.startsWith('add')) await fallback[method](...args);
        return result;
      }
    } catch (_error) {
      storeAvailable = false;
    }
    return fallback[method](...args);
  }
  async function check(ctx, startedAt, chargedMs = 0) {
    const elapsedMs = Math.max(0, now() - startedAt);
    const unchargedMs = Math.max(0, elapsedMs - chargedMs);
    const userUsed = Number(await use('usedMs', [ctx.userId, ctx.plan, ctx.role])) || 0;
    const userRemaining = limitFor(ctx) * 60000 - userUsed - unchargedMs;
    const groupUsed = countGroup(ctx) ? Number(await use('usedGroupMs', [ctx.groupId, ctx.plan])) || 0 : 0;
    const groupRemaining = groupLimitFor(ctx) * 60000 - groupUsed - unchargedMs;
    const callRemaining = maxCallMs - elapsedMs;
    const remainingMs = Math.max(0, Math.min(userRemaining, groupRemaining, callRemaining));
    const reason = groupRemaining < userRemaining && groupRemaining <= callRemaining ? 'GROUP_LIMIT' : 'QUOTA_EXHAUSTED';
    const code = remainingMs <= 0 ? reason : remainingMs <= warningBeforeMs ? 'QUOTA_WARNING' : 'QUOTA_OK';
    return {
      remainingMs,
      code,
      reason
    };
  }
  async function debit(ctx, ms) {
    const amount = Math.max(0, Math.round(ms));
    if (!amount) return 0;
    await use('addMs', [ctx.userId, ctx.plan, ctx.role, amount]);
    if (countGroup(ctx)) await use('addGroupMs', [ctx.groupId, ctx.plan, amount]);
    return amount;
  }
  async function charge(ctx, startedAt, chargedMs = 0) {
    const elapsedMs = Math.max(0, Math.min(maxCallMs, now() - startedAt));
    await debit(ctx, elapsedMs - chargedMs);
    return elapsedMs;
  }
  return {
    check,
    debit,
    charge,
    limitFor,
    groupLimitFor
  };
}
function createDailyCounter({
  store,
  now
}) {
  if (typeof now !== 'function') throw new TypeError('CLOCK_REQUIRED');
  const local = new Map();
  let storeAvailable = true;
  function key(id) {
    return JSON.stringify([new Date(now()).toISOString().slice(0, 10), id]);
  }
  function untilMidnightMs() {
    const current = now();
    return (Math.floor(current / 86400000) + 1) * 86400000 - current;
  }
  return {
    async used(id) {
      const name = key(id);
      if (storeAvailable && store?.get) {
        try {
          return Number(await store.get(name)) || 0;
        } catch (_error) {
          storeAvailable = false;
        }
      }
      return local.get(name) || 0;
    },
    async add(id, amount = 1) {
      const name = key(id);
      local.set(name, (local.get(name) || 0) + Math.max(0, amount));
      if (storeAvailable && store?.add) {
        try {
          await store.add(name, Math.max(0, amount), untilMidnightMs());
        } catch (_error) {
          storeAvailable = false;
        }
      }
      return local.get(name);
    }
  };
}
function createCallLease({
  store,
  ttlMs = 90000
}) {
  if (!store?.get || !store?.set || !store?.delete) throw new TypeError('LEASE_DEPENDENCY_REQUIRED');
  return {
    async acquire(userId, callId) {
      await store.set(userId, callId, ttlMs);
    },
    async isOwner(userId, callId) {
      if ((await store.get(userId)) !== callId) return false;
      await store.set(userId, callId, ttlMs);
      return true;
    },
    async release(userId, callId) {
      if ((await store.get(userId)) === callId) await store.delete(userId);
    }
  };
}
module.exports = {
  createMemoryMinuteStore,
  createMinuteQuota,
  createDailyCounter,
  createCallLease
};
