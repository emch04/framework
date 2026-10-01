import { assertSafeTestDatabaseUri, createFakeData, isDockerAvailable, isSafeTestDatabaseUri, startMongo, startPostgres, supportedCountries, UnsafeTestDatabaseError } from './src';
import type { FakeData, FakePerson, TestDatabase } from './src';

const data: FakeData = createFakeData({ country: 'CD', seed: 42 });
const people: FakePerson[] = data.people(3, { minAge: 6, maxAge: 18 });
const phone: string = data.phone();
const countries: string[] = supportedCountries();

async function exercise(): Promise<void> {
  assertSafeTestDatabaseUri('mongodb://localhost:27017/scolaris_test', { allowRemoteHosts: ['ci-db.internal.example'] });
  const safe: boolean = isSafeTestDatabaseUri('mongodb+srv://x.mongodb.net/app');
  if (isDockerAvailable()) {
    const mongo: TestDatabase = await startMongo({ database: 'scolaris_test' });
    const pg: TestDatabase = await startPostgres();
    await mongo.stop();
    await pg.stop();
  }
  try {
    assertSafeTestDatabaseUri('x');
  } catch (error) {
    if (error instanceof UnsafeTestDatabaseError) void error.reason;
  }
  void [people, phone, countries, safe];
}
void exercise;
