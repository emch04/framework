const { randomUUID } = require('node:crypto');
const { createMongoCredentialStore, createMongoChallengeStore, createMongoVersionedCredentialStore } = require('../src');
const uri = process.env.MONGO_TEST_URL;
const mongoTest = uri ? test : test.skip;

mongoTest('real Mongo credential scopes, challenges and concurrent version history', async () => {
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(uri); await client.connect();
  const suffix = randomUUID().replaceAll('-', '');
  const collections = ['credentials', 'challenges', 'versions'].map(name => client.db().collection(`integration_${name}_${suffix}`));
  let ready = true;
  const store = createMongoCredentialStore({ collection: collections[0], isReady: () => ready });
  const challenge = createMongoChallengeStore({ collection: collections[1] });
  const versions = createMongoVersionedCredentialStore({ collection: collections[2], isReady: () => ready });
  const scope = { tenant: 'tenant-a', environment: 'test' };
  try {
    await store.upsert({ key: 'setting', value: 'global', secret: false });
    await store.upsert({ key: 'setting', value: 'first', secret: false, ...scope });
    await store.upsert({ key: 'setting', value: 'updated', secret: false, ...scope });
    expect((await store.findAll()).map(row => row.value)).toEqual(['global']);
    expect((await store.findAll(scope)).map(row => row.value)).toEqual(['updated']);
    expect(await store.findAll({ ...scope, tenant: 'tenant-b' })).toEqual([]);
    expect(await challenge.find('missing')).toBeNull();
    await challenge.save('subject', { attempts: 1 }); await challenge.save('subject', { attempts: 2 });
    expect(await challenge.find('subject')).toMatchObject({ attempts: 2 });
    expect(await collections[1].countDocuments()).toBe(1);
    const build = version => ({ key: 'setting', ...scope, version, value: `value-${version}`, secret: false, updatedAt: new Date(1000 * version) });
    await Promise.all(Array.from({ length: 6 }, () => versions.appendVersion('setting', scope, build, 100)));
    expect((await versions.listVersions('setting', scope)).map(row => row.version)).toEqual([6, 5, 4, 3, 2, 1]);
    expect((await versions.findAll(scope))[0].version).toBe(6);
    expect(await versions.findVersion('setting', 1, { ...scope, tenant: 'tenant-b' })).toBeNull();
    expect(await versions.purgeVersions(new Date(10000), scope)).toBe(5);
    expect(await versions.findVersion('setting', 1, scope)).toMatchObject({ purged: true });
    expect((await versions.findVersion('setting', 1, scope)).value).toBeUndefined();
    expect((await versions.findVersion('setting', 6, scope)).value).toBe('value-6');
    ready = false; expect(await store.findAll()).toEqual([]);
    await expect(store.findAll(scope, { strict: true })).rejects.toThrow('unavailable');
    await expect(versions.findAll(scope)).rejects.toThrow('unavailable');
  } finally { for (const collection of collections) await collection.drop(); await client.close(); }
  await expect(challenge.find('subject')).rejects.toThrow();
});
