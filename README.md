# Astratra

[English](README.md) | [Français](README.fr.md)

**Astratra is a framework and a set of SDKs for building apps with AI built in.**

It is both, and the difference is who is in charge:

- **The framework.** `createSaasApp()` (`@astratra/saas-kit`) assembles the
  whole application — sign-in, sessions, CSRF, accounts, errors — and calls
  your code at the places it provides (`extendRoutes`, `verifyPassword`, the
  stores). `create-astratra-app` sets the shape of a new project.
- **The SDKs.** Packages that talk to a service for you, such as
  `@astratra/centrale` (monitoring, key gateway, search) or the client of the
  local model service in `@astratra/models`.
- **The building blocks.** Libraries you call yourself, with no structure
  imposed: `@astratra/security`, `@astratra/client`, `@astratra/ai`,
  `@astratra/ledger` and the others.

They ship as independent npm packages for SaaS back ends and web or mobile
front ends: users, roles, sessions, security middleware, persistence adapters,
a dashboard, and the common pieces behind AI assistants, payments, accounting,
booking and mobile apps.

Each package does one job and takes its dependencies by injection: a store, a
transport, a model, a clock, a key source. Your application decides the
business rules, the database and the providers; Astratra supplies the parts
that are the same from one project to the next.

## Who it is for

- Developers starting a SaaS, an internal tool or an MVP who want a solid base
  instead of rewriting authentication, rate limiting, roles and settings.
- Teams that already have an application and want to adopt one package at a
  time, for example the audit log, the webhook pipeline or the AI router.

## What it is not

- It is not a finished application. You still write your domain model, your
  screens and your product rules.
- It is not a hosted service and does not run anything for you.
- It is not a security audit, a compliance framework or legal advice. The
  security packages reduce common risks; they do not remove the need for a
  review of your own application.
- It does not impose a role model. Roles are plain strings supplied by your
  project.

## Requirements

- Node.js 20 or later (CI runs on 20.x and 22.x).
- npm workspaces: the repository root is an npm workspace.
- Docker, only for `@astratra/testkit` (throwaway MongoDB or PostgreSQL
  containers).

## Quick start

Create a full application (API, web dashboard, authentication, roles, settings,
notifications):

```bash
npm create astratra-app@latest my-app
cd my-app
npm install
npm run dev:api
npm run dev:web
```

Create an API only:

```bash
npm create astratra-app@latest my-api -- --template api
```

Add optional building blocks at generation time with `--with`, for example
`--with payments,privacy,notify`, or `--with all`. Without `--with`, the project
is exactly the same as before.

## Installing packages in an existing project

Each package is published on its own. Install only what you use:

```bash
npm install @astratra/core @astratra/security
npm install @astratra/saas-kit @astratra/store-postgres pg
npm install @astratra/ai
```

Every package has a README with its installation, a minimal example, its main
options and what it does not do. The table below links to them.

## Packages

The 44 packages in [`packages/`](packages/) are all published under the
`@astratra` scope, except `create-astratra-app`, which is published under its
own name. Versions are the ones in each `package.json`; the history of every
package is in [CHANGELOG.md](CHANGELOG.md).

### Foundations and security

| Package | Version | What it does |
|---|---|---|
| [`@astratra/core`](packages/core/README.md) | 1.1.0 | API responses, errors, logs, request IDs, environment configuration |
| [`@astratra/security`](packages/security/README.md) | 1.13.0 | JWT and RBAC, rate limiting (memory or Redis), CSP, heuristic WAF, WebAuthn passkeys, HMAC between services, chained audit log |
| [`@astratra/credentials`](packages/credentials/README.md) | 1.1.0 | Encrypted service keys stored in your database, editable from the interface without a restart |
| [`@astratra/entitlements`](packages/entitlements/README.md) | 1.0.0 | Plans, features, billing and status guards, tenant isolation that fails closed, invitations by link, AI quotas and budgets |
| [`@astratra/flags`](packages/flags/README.md) | 1.0.2 | Deterministic feature flags and experiments: targeting, gradual rollout, OpenFeature-compatible provider |
| [`@astratra/privacy`](packages/privacy/README.md) | 1.0.1 | Right of access, right to erasure with human approval, anonymisation, log redaction |
| [`@astratra/resilience`](packages/resilience/README.md) | 1.1.0 | Circuit breaker, TTL cache that degrades instead of failing, retry with jitter, cluster job lock |
| [`@astratra/i18n-server`](packages/i18n-server/README.md) | 1.0.0 | Translation of API messages, locale resolution, readability audit of error messages |

### AI

| Package | Version | What it does |
|---|---|---|
| [`@astratra/ai`](packages/ai/README.md) | 1.11.0 | Multi-provider AI routing with quotas and fallback, tool registry, agent loop, risk levels with confirmation, local llama.cpp provider |
| [`@astratra/agent`](packages/agent/README.md) | 1.1.0 | Durable tasks, budgets, plans, completion checks, context summaries, consumption tracking, and user feedback (👍/👎) the agent learns from |
| [`@astratra/models`](packages/models/README.md) | 1.1.0 | Local CPU model service (embeddings, reranking, NLI, entities, speech-to-text) and its Node client; price catalogue and cost calculation |
| [`@astratra/conscience`](packages/conscience/README.md) | 1.2.0 | Documented memory of an agent's decisions (outcomes, corrections, lessons with evidence, self-model, lineage, erasure) under a deterministic governor without any language model |
| [`@astratra/memory`](packages/memory/README.md) | 2.0.0 | Per-person memories for an assistant: hybrid recall, duplicate merging, undoable corrections, PostgreSQL store |
| [`@astratra/rag`](packages/rag/README.md) | 1.0.0 | Document retrieval: chunking, injected embeddings, hybrid search, source verification, document reading through an optional service |
| [`@astratra/voice`](packages/voice/README.md) | 1.1.1 | Server-side text-to-speech (Piper, ffmpeg), versioned caches, provider chain with key rotation, local transcription |
| [`@astratra/live`](packages/live/README.md) | 1.0.0 | Real-time voice call sessions and client protocol helpers |
| [`@astratra/app-guide`](packages/app-guide/README.md) | 1.0.0 | Role-aware in-app guide generated from the screen configuration, with coverage checks |
| [`@astratra/repomap`](packages/repomap/README.md) | 1.0.1 | Weighted symbol map of a repository, for exploring code within a token budget |

### Business logic

| Package | Version | What it does |
|---|---|---|
| [`@astratra/payments`](packages/payments/README.md) | 1.0.1 | Payment webhook pipeline: raw-body signature checks, replay protection, provider-safe responses |
| [`@astratra/ledger`](packages/ledger/README.md) | 1.0.0 | Double-entry accounting: balanced, immutable entries, sequential numbering, period closing, reconciliation, OHADA charts of accounts |
| [`@astratra/booking`](packages/booking/README.md) | 1.0.0 | Appointment slot engine without a database: availability, exceptions, time zones, capacity, atomic booking through an injected store |
| [`@astratra/collab`](packages/collab/README.md) | 1.0.0 | Real-time collaborative editing: Hocuspocus server wired to your authentication, Yjs snapshots, named versions |
| [`@astratra/srs`](packages/srs/README.md) | 1.0.0 | Spaced repetition on FSRS: cards, grading, due dates, daily queue, statistics |
| [`@astratra/fhir`](packages/fhir/README.md) | 1.0.0 | FHIR R4 helpers on the official Medplum types: minimal validation, references, builders |
| [`@astratra/loyalty`](packages/loyalty/README.md) | 1.0.1 | Stamp cards and monthly-quota passes, computed without a database |
| [`@astratra/wallet`](packages/wallet/README.md) | 1.0.0 | Apple Wallet and Google Wallet passes kept up to date: signing, web service, add-to-wallet links, removal |
| [`@astratra/pdf`](packages/pdf/README.md) | 1.0.0 | PDFKit layout primitives: text that fits its box, paginated tables, card sheets with vector QR codes |
| [`@astratra/closure`](packages/closure/README.md) | 1.0.0 | Period closing checklist with blocking and acknowledged items, and an archive free of credentials |
| [`@astratra/notify`](packages/notify/README.md) | 1.1.0 | Outbound e-mail, SMS and push: injected transport, header-injection safe, never throws |

### Web and mobile

| Package | Version | What it does |
|---|---|---|
| [`@astratra/saas-kit`](packages/saas-kit/README.md) | 2.0.1 | Backend starter: `createSaasApp()` assembles users, authentication, settings, notifications and dashboard routes |
| [`@astratra/store-mongo`](packages/store-mongo/README.md) | 1.1.0 | MongoDB (Mongoose) persistence adapters for the SaaS stores |
| [`@astratra/store-postgres`](packages/store-postgres/README.md) | 1.1.0 | PostgreSQL (`pg`) persistence adapters for the SaaS stores |
| [`@astratra/saas-kit-ui`](packages/saas-kit-ui/README.md) | 1.4.0 | React dashboard for `@astratra/saas-kit`, 👍/👎 feedback bar |
| [`@astratra/react`](packages/react/README.md) | 1.0.0 | Bare React primitives for sessions, permissions and API calls, without an imposed dashboard |
| [`@astratra/client`](packages/client/README.md) | 1.1.0 | Framework-agnostic client plumbing: refresh on 401, route guard, password rules, offline queue |
| [`@astratra/prerender`](packages/prerender/README.md) | 1.0.1 | SEO prerendering for Vite and React sites: one HTML file per route, sitemap from the same list |
| [`@astratra/native`](packages/native/README.md) | 1.0.0 | Mobile plumbing: keychain session, biometric gate, push registration, payment return |
| [`@astratra/native-ui`](packages/native-ui/README.md) | 1.2.0 | UI kit for React Native and Expo, with pure logic testable in Node, 👍/👎 feedback bar |
| [`@astratra/app-version`](packages/app-version/README.md) | 1.0.0 | Announcements of new mobile builds: public version route, one announcement per version |
| [`create-astratra-app`](packages/create-astratra-app/README.md) | 1.11.1 | Project generator: full stack, API only, or Expo app, with optional building blocks |

### Monitoring and tooling

| Package | Version | What it does |
|---|---|---|
| [`@astratra/centrale`](packages/centrale/README.md) | 1.4.0 | Collection package for a self-hosted monitoring dashboard: errors, crashes, views, usage, AI calls; masked at the source, sent in batches; no dependencies |
| [`@astratra/centrale-cli`](packages/centrale-cli/README.md) | 1.0.1 | Command-line tool for the same dashboard: debug IDs and source maps, deployment declaration |
| [`@astratra/tooling`](packages/tooling/README.md) | 1.5.0 | Workspace audit (secrets, routes, translations), test runner, deployment with rollback, app publishing, AI evaluation |
| [`@astratra/testkit`](packages/testkit/README.md) | 1.1.0 | Disposable MongoDB or PostgreSQL test databases, reproducible per-country fake data, guard against production databases |

The example [`examples/dashboard-ui`](examples/dashboard-ui/README.md) shows
`@astratra/saas-kit-ui` against the `saas-kit` API. It is not published.

## Principles

- **Injection, not assumptions.** Stores, transports, models, providers, keys
  and clocks are passed in. A package never hard-codes your database, your
  mail provider or your AI vendor.
- **Security as a constraint.** Security-sensitive packages document their
  defaults in their README, and each package says how it handles secrets.
- **Stable 1.x contracts.** All packages are at version 1.x or later. A minor
  version adds without breaking; a major version changes behaviour and is
  described in [CHANGELOG.md](CHANGELOG.md).
- **Independent packages.** Each package has its own version and its own
  dependencies. You install the ones you need; none forces another on you
  except through a declared dependency.
- **Tested and verified.** The continuous integration runs lint, typecheck,
  all workspace test suites, and installs every published package in a clean
  project.

## Limits of the current version

- There is no generic SQL adapter (MySQL, SQLite) and no migration tool. The
  MongoDB and PostgreSQL adapters are the two real persistence adapters.
- The agent loop in `@astratra/ai` does not handle images (vision). Human
  confirmation by risk level and token streaming are supported.
- The WAF in `@astratra/security` is a heuristic layer. It does not replace
  parameterised queries, context-aware output encoding or a network WAF.
- WebAuthn passkeys are an integration primitive; the credential store is an
  interface without a provided implementation.
- Astratra does not provide encryption at rest for your whole database
  (only service keys stored by `@astratra/credentials` are encrypted), nor a
  centralised security log. Your project decides what its compliance needs.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, tests, lint, versioning and
pull requests. To report a vulnerability, see [SECURITY.md](SECURITY.md); please
do not open a public issue for it.

## Development

```bash
npm install
npm test --workspaces
npm run lint
npm run typecheck
```

Publishing rules (versions, order, checks) are in
[docs/PUBLISHING.md](docs/PUBLISHING.md).

## Repository layout

```
.github/workflows/   continuous integration (lint, typecheck, tests, package installation)
packages/            the 43 published packages, one directory each
examples/            the unpublished dashboard example
scripts/             publication script and package installation check
docs/                publishing rules, design notes, guides
```

## License

[MIT](LICENSE). Copyright (c) 2026 Astratra contributors.
