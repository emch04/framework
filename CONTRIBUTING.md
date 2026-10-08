# Contributing to Astratra

Thank you for taking the time to contribute. This document covers the setup,
the checks a change must pass, the versioning rules and how to open a pull
request. The detailed publishing procedure is in
[docs/PUBLISHING.md](docs/PUBLISHING.md).

## Prerequisites

- Node.js 20 or later. Continuous integration runs on 20.x and 22.x.
- npm (the repository is an npm workspace; use the `package-lock.json` as is).
- Docker, only if you work on `@astratra/testkit`, which starts throwaway
  database containers.

## Setup

```bash
git clone <this repository>
cd astratra
npm install
```

Run commands from the repository root unless a step says otherwise.

## Tests

Each package has its own test suite. Run one package with its workspace name:

```bash
npm test -w @astratra/<name>          # for example: npm test -w @astratra/loyalty
npm test -w create-astratra-app       # the generator is not scoped
```

Run every suite:

```bash
npm test --workspaces
```

A few suites need external services (a Python model server for
`@astratra/models`, a Postgres in-memory test driver for some `ledger`,
`collab` and `booking` tests). Say in your pull request which suites you could
not run and why.

## Lint and typecheck

```bash
npm run lint          # ESLint on the whole repository
npm run typecheck     # TypeScript on each packages/*/typecheck.ts
npm run verify:packages   # packs each public package and installs it in a clean project
```

Before you open a pull request, run at least the tests of every package you
touched, `npm run lint` and `npm run typecheck`.

## Versioning

Each package is versioned on its own, in its `package.json`, following semver:

- A new package starts at `1.0.0`, never at `0.x`.
- A fix with no API change is a patch version (`1.2.3` → `1.2.4`).
- An addition that keeps existing behaviour (a new function, a new option) is
  a minor version (`1.2.3` → `1.3.0`).
- A breaking change (changed signature, removed export, changed default
  behaviour) is a major version (`1.2.3` → `2.0.0`), described in
  `CHANGELOG.md` in a section about the break.
- A package whose published content does not change keeps its version.

Changing anything under `packages/<name>/src` (code, comments or strings) counts
as a change of the published content. In that case:

1. Bump the package's version in its `package.json`, and update its entry in
   `package-lock.json` (run `npm install` at the root).
2. Add an entry to `CHANGELOG.md` describing the change.
3. If a sibling package or the `create-astratra-app` templates depend on the
   new version, raise their minimum version too. `create-astratra-app` tests
   compare each dependency floor to the versions in this repository.

Do not change behaviour and version numbers in the same commit without saying
so in the CHANGELOG.

## Code and documentation

- Keep the language of the file you edit. Packages mix French and English
  documentation; new text can be in either, as long as it is consistent within
  the file.
- Keep the code neutral: no company or product names in the code, the tests,
  the examples or the documentation, except where a third-party provider's
  name is the subject (for example `Gemini`, `OpenAI`, `Anthropic` as an AI
  provider).
- Packages should not depend on each other more than they need to. Prefer
  injection (a store, a transport, a model passed as options) over a
  hard-coded integration.
- Prefer no new runtime dependency. If a change needs one, justify it in the
  pull request.
- Do not commit secrets, real credentials, personal data, `.env` files or
  generated archives. Test keys must be assembled at runtime so that secret
  scanners do not flag them (see `packages/privacy/__tests__/dlp.test.js`).

## Commit messages

Follow the style of the existing history: a short subject line that starts
with the package and its version when the change is a release, then a colon and
a description in French or English.

```
loyalty 1.0.1 : commentaires neutres, aucun changement de comportement
```

Keep one logical change per commit. Put the CHANGELOG entry in the same commit
as the version bump it describes.

## Pull requests

1. Open an issue first for a large change or a new package, so the design can
   be discussed before the code is written.
2. Branch from `main`, keep the pull request focused on one change.
3. Describe what changes and why, which tests you ran, and anything you could
   not run.
4. Make sure the continuous integration passes: lint, typecheck, the test
   suites, and the package installation check.
5. A maintainer reviews and merges. Versions are published by the maintainers
   with `scripts/publish-all.sh`; a pull request does not publish anything.

## Security

Do not report vulnerabilities in a public issue or pull request. See
[SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contribution is licensed under the
[MIT License](LICENSE) of this repository.
