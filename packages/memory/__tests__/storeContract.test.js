const { createMemoryStore, runStoreContract } = require('../src');

/* The reference store passes its own contract… */
runStoreContract(() => createMemoryStore());

/* …and so does a store that implements only the required methods. */
describe('a minimal store', () => {
  runStoreContract(() => {
    const store = createMemoryStore();
    delete store.search;
    delete store.claimRef;
    delete store.releaseRef;
    delete store.listNeedingVector;
    return store;
  });
});

