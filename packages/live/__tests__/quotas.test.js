const {
  createMinuteQuota,
  createMemoryMinuteStore,
  createCallLease,
  createDailyCounter
} = require('../src');
test('plan and role limit is chosen', () => {
  const quota = createMinuteQuota({
    limits: {
      paid: {
        teacher: 20,
        default: 5
      },
      default: 1
    },
    now: () => 0
  });
  expect(quota.limitFor({
    plan: 'paid',
    role: 'teacher'
  })).toBe(20);
});
test('plan default applies', () => {
  const quota = createMinuteQuota({
    limits: {
      paid: {
        default: 5
      }
    },
    now: () => 0
  });
  expect(quota.limitFor({
    plan: 'paid',
    role: 'other'
  })).toBe(5);
});
test('role default applies', () => {
  const quota = createMinuteQuota({
    limits: {
      teacher: 3
    },
    now: () => 0
  });
  expect(quota.limitFor({
    role: 'teacher'
  })).toBe(3);
});
test('unconfigured quota is unlimited within call limit', async () => {
  const quota = createMinuteQuota({
    now: () => 0
  });
  expect((await quota.check({
    userId: 'u'
  }, 0)).remainingMs).toBe(1800000);
});
test.each([[0, 'QUOTA_OK'], [60000, 'QUOTA_WARNING'], [120000, 'QUOTA_EXHAUSTED']])('quota at elapsed %s is %s', async (elapsed, code) => {
  const quota = createMinuteQuota({
    limits: {
      default: 2
    },
    now: () => elapsed
  });
  expect((await quota.check({
    userId: 'u'
  }, 0)).code).toBe(code);
});
test('used time subtracts from allowance', async () => {
  const quota = createMinuteQuota({
    limits: {
      default: 2
    },
    store: {
      usedMs: async () => 60000
    },
    now: () => 0
  });
  expect((await quota.check({
    userId: 'u'
  }, 0)).remainingMs).toBe(60000);
});
test('charge caps to max call length', async () => {
  const store = {
    addMs: jest.fn()
  };
  const quota = createMinuteQuota({
    store,
    now: () => 3000000
  });
  expect(await quota.charge({
    userId: 'u',
    role: 'r'
  }, 0)).toBe(1800000);
  expect(store.addMs).toHaveBeenCalledWith('u', undefined, 'r', 1800000);
});
test('clock is required', () => {
  expect(() => createMinuteQuota({})).toThrow('CLOCK_REQUIRED');
});
test('group limit takes precedence when lower', async () => {
  const quota = createMinuteQuota({
    limits: {
      default: 10,
      groups: {
        default: 2
      }
    },
    now: () => 0
  });
  expect((await quota.check({
    userId: 'u',
    groupId: 'g'
  }, 0)).remainingMs).toBe(120000);
});
test('group exhaustion has a distinct code', async () => {
  const store = {
    usedMs: async () => 0,
    usedGroupMs: async () => 120000
  };
  const quota = createMinuteQuota({
    limits: {
      default: 10,
      groups: {
        default: 2
      }
    },
    store,
    now: () => 0
  });
  expect((await quota.check({
    userId: 'u',
    groupId: 'g'
  }, 0)).code).toBe('GROUP_LIMIT');
});
test('group exemption skips shared limit', async () => {
  const quota = createMinuteQuota({
    limits: {
      default: 10,
      groups: {
        default: 0
      }
    },
    now: () => 0,
    countGroup: () => false
  });
  expect((await quota.check({
    userId: 'u',
    groupId: 'g'
  }, 0)).code).toBe('QUOTA_OK');
});
test('debit increments user and group counters', async () => {
  const store = createMemoryMinuteStore({
    now: () => 0
  });
  const quota = createMinuteQuota({
    store,
    now: () => 0
  });
  await quota.debit({
    userId: 'u',
    groupId: 'g'
  }, 3500);
  expect(await store.usedMs('u')).toBe(3500);
  expect(await store.usedGroupMs('g')).toBe(3500);
});
test('charged time is not subtracted twice', async () => {
  const store = createMemoryMinuteStore({
    now: () => 60000
  });
  const quota = createMinuteQuota({
    store,
    limits: {
      default: 2
    },
    now: () => 60000
  });
  await quota.debit({
    userId: 'u'
  }, 60000);
  expect((await quota.check({
    userId: 'u'
  }, 0, 60000)).remainingMs).toBe(60000);
});
test('store outage falls back to in-process counters', async () => {
  const store = {
    usedMs: async () => {
      throw new Error();
    },
    addMs: async () => {
      throw new Error();
    }
  };
  const quota = createMinuteQuota({
    store,
    limits: {
      default: 2
    },
    now: () => 0
  });
  await quota.debit({
    userId: 'u'
  }, 60000);
  expect((await quota.check({
    userId: 'u'
  }, 0)).remainingMs).toBe(60000);
});
test('memory counters reset on next UTC day', async () => {
  let now = 0;
  const store = createMemoryMinuteStore({
    now: () => now
  });
  await store.addMs('u', null, null, 60000);
  now = 86400000;
  expect(await store.usedMs('u', null, null)).toBe(0);
});
test('lease tracks and renews only owning call', async () => {
  const values = new Map();
  const store = {
    get: async key => values.get(key),
    set: async (key, value) => {
      values.set(key, value);
    },
    delete: async key => {
      values.delete(key);
    }
  };
  const lease = createCallLease({
    store
  });
  await lease.acquire('u', 'a');
  expect(await lease.isOwner('u', 'a')).toBe(true);
  await lease.acquire('u', 'b');
  expect(await lease.isOwner('u', 'a')).toBe(false);
  await lease.release('u', 'a');
  expect(await lease.isOwner('u', 'b')).toBe(true);
  await lease.release('u', 'b');
  expect(values.has('u')).toBe(false);
});
test('daily counter resets at UTC midnight', async () => {
  let time = 0;
  const counter = createDailyCounter({
    now: () => time
  });
  await counter.add('voice', 2);
  expect(await counter.used('voice')).toBe(2);
  time = 86400000;
  expect(await counter.used('voice')).toBe(0);
});
test('daily counter degrades after a shared store failure', async () => {
  const counter = createDailyCounter({
    store: {
      get: async () => {
        throw new Error('offline');
      },
      add: async () => {
        throw new Error('offline');
      }
    },
    now: () => 0
  });
  await counter.add('voice');
  expect(await counter.used('voice')).toBe(1);
});
test('shared daily counter receives time until UTC midnight', async () => {
  const add = jest.fn();
  const counter = createDailyCounter({
    store: { get: async () => 0, add },
    now: () => 86399000
  });
  await counter.add('voice');
  expect(add.mock.calls[0][2]).toBe(1000);
});
