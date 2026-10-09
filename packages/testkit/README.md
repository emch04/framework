# @astratra/testkit

[English](README.md) | [Français](README.fr.md)

Disposable MongoDB and PostgreSQL databases, seeded country-specific fixtures,
production database guards and provider-independent agent evaluations. MIT.
Install as a development dependency. Node >= 22.22.

```sh
npm install --save-dev @astratra/testkit
```

## Agent evaluation

`evaluateAgent({ scenarios, run, signal? })` evaluates an injected runner and
returns `{ results, score, passed, total }`. No model provider is imposed.

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateAgent } = require('@astratra/testkit');

test('uses a lookup result', async () => {
  const report = await evaluateAgent({
    scenarios: [{
      id: 'lookup', question: 'Find the value.',
      tools: [{ name: 'lookup', run: async () => ({ data: '42' }) }],
      expect: { tools: ['lookup'], content: ['42'] }
    }],
    run: async ({ question, tools, signal }) => {
      const value = await tools[0].run({});
      return { text: value.data };
    }
  });
  assert.equal(report.passed, report.total);
});
```

Each scenario has `id`, `question`, optional simulated `tools`, `expect` and
`score`. The runner receives `{ question, tools, signal }` and returns text or
an object with `text`. Tools retain their other fields, allowing native tool
fixtures to be passed to a task runner. Recorded calls include names and args.
Expected tool names must have been called; content expectations accept strings
or regular expressions. The default score is the fraction of satisfied checks,
or one when no checks are defined. `score({ text, calls, output, checks })` can
return an asynchronous number between zero and one. Scenario failures produce
a zero score and an error; cancellation propagates. Overall score is the mean
of scenario scores (zero for an empty report). A scenario passes only when all
checks pass and its score is one. The report is data, suitable for `node --test`
assertions or application reporting. It does not judge tool ordering or absence
unless a custom scoring function does so.

## Disposable databases

Install `@testcontainers/mongodb` or `@testcontainers/postgresql` for the engine
used. Docker is required for real containers.

```js
const { startPostgres, startMongo, isDockerAvailable } = require('@astratra/testkit');
if (isDockerAvailable()) {
  const db = await startPostgres({ database: 'app_test' });
  // Connect the application's driver to db.uri.
  await db.stop();
}
```

MongoDB uses `mongo:8` with a replica set; PostgreSQL uses `postgres:17-alpine`.
Both expose `{ uri, stop }`, use a random port and validate the generated URI.
Without Docker, skip container integration tests explicitly.

## Seeded fixtures

```js
const { createFakeData, supportedCountries } = require('@astratra/testkit');
const data = createFakeData({ country: 'FR', seed: 42 });
data.person();
data.people(3, { minAge: 6, maxAge: 18 });
data.organization();
data.phone();
```

Twenty countries are supported; `supportedCountries()` lists them. The faker
instance is available as `data.faker`. Ages use a fixed reference date so a seed
stays reproducible. Emails use the reserved `example.test` domain. Geographic
fields are independent fixtures and do not form an address directory.

## Database guard

`assertSafeTestDatabaseUri(uri, { allowRemoteHosts? })` throws
`UnsafeTestDatabaseError` with `reason` on refusal; `isSafeTestDatabaseUri`
returns a boolean. Production environment, managed hosts, `mongodb+srv`,
production-looking host/database names, unapproved remote hosts and unmarked
production environment URIs are refused. Even explicitly allowed remote hosts
must use a test-marked database. Call the guard before destructive test setup.

## Jest compatibility

Faker 10 is ESM. Node loads it directly; Jest CommonJS needs the provided
preset to transform faker through Babel:

```json
{ "jest": { "preset": "@astratra/testkit" } }
```

Existing transform settings can copy `jest-preset.js`. Runtime dependencies
are faker 10 and the Babel CommonJS transform plugin, both MIT. The evaluation
harness also works directly with `node --test`.
