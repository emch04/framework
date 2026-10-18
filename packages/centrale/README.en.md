# @astratra/centrale

English | [Français](README.md)

The collection package of a self-hosted monitoring dashboard: errors, crashes, views, usage, sessions and AI calls, masked at the source and sent in batches to the backend. It also holds the light client of the dashboard's "conscience" routes for an AI agent.

- **No dependency** at run time, no other Astratra package.
- **Never throws** at the caller and never blocks the host project (the conscience client, which you call explicitly, rejects with `ErreurConscience`).
- Written in TypeScript, published as JavaScript with its types (`dist/`, built by `npm run build` before each release).
- Holds the sending contract (`@astratra/centrale/envoi`) and the masking (`@astratra/centrale/masquage`): the dashboard backend takes them from here, there is a single source.

The API is in French, like the dashboard it talks to.

## Installation

```sh
npm install @astratra/centrale
```

## Minimal example

```ts
import { creerCentrale } from '@astratra/centrale';

const centrale = creerCentrale({
  cle: 'clj_pub_…',                          // public key of the project
  adresse: 'https://dashboard.example.com',  // dashboard backend
  environnement: 'production',
  version: '2.14.0'
});

centrale.vue('/student/123');                // recorded as "/student/:id"
centrale.usage('export_pdf', { pages: 3 });
try {
  // …
} catch (e) {
  centrale.erreur(e);
}
await centrale.vider();                      // sends what is left in the queue; never rejects
```

For Node, the browser, Expo or AI call measurement, use the dedicated entry point (table below).

## Configuration

Only `cle`, `adresse` and `environnement` are required.

| Option | Role |
| --- | --- |
| `cle` | Public key of the project (`clj_pub_…`): it can only send. |
| `adresse` | Backend address. |
| `environnement` | `'production'`, `'preproduction'` or `'developpement'`. |
| `version` | Version of the app or server. |
| `sel` | Salt used to hash the user id. |
| `noms` | Proper names masked everywhere. |
| `echantillonnage` | Rates from 0 to 1 for `vues`, `usages` and `ia`; never applied to errors or sessions. |
| `strict` | No user, no precise device. |
| `desactive` | Turns everything off: the instance does nothing. |
| `debug` | Prints internal errors with `console.warn`. |
| `robots` | Browser only. `false` by default: a browser driven by a robot (`navigator.webdriver`, i.e. Playwright, Selenium, Puppeteer) collects nothing. `true` to collect anyway (to test the collection itself). |

### Automated tests: nothing is sent

Since 1.5.0, `demarrer` from `/navigateur` returns an inactive instance (`centrale.actif === false`) when
`navigator.webdriver` is `true`: end-to-end tests run against a deployment no longer fill the dashboard with false
errors. To check the collection in a Playwright test, ask for it:

```ts
const centrale = demarrer({ ...config, robots: true });
```

## The 6 entry points

| Entry | Use |
| --- | --- |
| `@astratra/centrale` | `creerCentrale(config, transport?)`: `erreur(e, extra?)`, `vue(nom)`, `usage(nom, props?)`, `ia({…})`, `session(etat)`, `miette(categorie, message, donnees?)`, `definirUtilisateur(id)`, `vider()`. The transport (fetch by default) can be injected. |
| `@astratra/centrale/node` | `demarrer(config)`; `app.use(centrale.intergiciel())` first, `app.use(centrale.gestionnaireErreurs())` last. |
| `@astratra/centrale/navigateur` | `demarrer(config)` when the web app loads. |
| `@astratra/centrale/expo` | `demarrer({ ...config, plateforme: Platform.OS, version, build, miseAJour, os, appareil, appState: AppState, stockage })`, then `centrale.ecran(nom)` from navigation. `stockage` (AsyncStorage, expo-file-system…) keeps the state between two launches. |
| `@astratra/centrale/ia` | `mesurerAppelIA({ fournisseur, modele, outil?, jetons?, estRepli? }, () => call())`. |
| `@astratra/centrale/conscience` | `creerConscienceCentrale({ adresse, jeton })`: settings of an AI's conscience, morning report, human decisions (section below). |

## Key gateway (`/passerelle`)

An app only keeps a project token (`CENTRALE_PASSERELLE_JETON`, `clj_pas_…`) and the Centrale address (`CENTRALE_ADRESSE`): Centrale calls the providers with the keys of its vault and counts usage per project. `lirePasserelle(env)` reads them (null when not set); `modeleDiscussion(p)` gives an OpenAI-format model (`auto`, with `thoughtSignatures: true`: the gateway relays the thought signatures of Gemini 3) to put first in an AI's relay; `plongements`, `rechercher` and `voix` cover embeddings, web search and voice. A gateway outage throws `PasserelleIndisponible` and `passerelleDabord` then falls back to the direct keys; a request refused for itself (400, 413) throws `RequetePasserelleRefusee`, without fallback.

## Agent journal (`/agents`)

An AI sends each of its runs (model turns, tools called, tokens, duration, cost, status, proposed actions) to the dashboard: `POST /v1/agents`, with the project's **public** key (`X-Centrale-Cle`), at most 100 runs per batch.

```ts
import { construireExecution, creerJournalAgents } from '@astratra/centrale/agents';

const journal = creerJournalAgents({ adresse: process.env.CENTRALE_ADRESSE!, cle: process.env.CENTRALE_CLE! });

await journal.envoyer([construireExecution({
  identifiant: 'run-123', agent: 'Elsa', mode: 'discussion', utilisateur: accountId,    // opaque identifier
  debut, fin, statut: 'ok',                                                              // ok | erreur | interrompue | en_attente_confirmation
  tours: [{ modele: 'model-a', dureeMs: 900, jetonsEntree: 1200, jetonsSortie: 80, cout: 0.002 }],
  outils: [{ outil: 'read_stock', succes: true, dureeMs: 25 }],
  actions: [{ outil: 'refund', etat: 'proposee' }]
})]);
```

- `construireExecution(bilan, { inclureContenu? })`: pure function. **No content by default**: no question, answer, tool arguments or tool results, even if the bilan carries them; the error is a short code (`ia_indisponible`), never a message. `inclureContenu: true` adds them (masked before sending); only turn it on when a use really needs it.
- `creerJournalAgents({ adresse, cle, fetch? })`: `envoyer(executions)` validates locally (an unknown key, status, step type or action state **rejects** the run; steps, sources and actions are cut to the format's bounds; dates to the second, `Z`), masks texts, queues and sends. Also `vider()`, `enAttente()`, `arreter()`.
- The queue lives in memory (1,000 runs at most). A network failure, a 5xx or a 429 (`Retry-After` honoured) puts the batch back with progressive back-off (2 s, doubling up to 5 min); a 4xx refusal drops the batch silently. Never throws; `debug: true` explains rejections.

## Conscience of an AI (`/conscience`)

The dashboard sets an AI's conscience (on, emergency stop, approvers, automatic reflection, cycles per day), receives its morning report and pending proposals, and records human decisions. It never applies anything: the AI reads its settings and the decisions, then submits them to its own governor. Authentication uses the project token (`Authorization: Bearer …`).

```ts
import { creerConscienceCentrale } from '@astratra/centrale/conscience';

const dashboard = creerConscienceCentrale({ adresse: 'https://dashboard.example.com', jeton: process.env.PROJECT_TOKEN! });

const settings = await dashboard.lireReglages();             // kept with their ETag: a 304 returns the copy
await dashboard.envoyerBilan(await governor.morningReport({ organisationId, since }),
  await governor.listProposals({ organisationId, status: 'pending_approval' }));
const decisions = await dashboard.lireDecisions();           // those not acknowledged yet
await dashboard.accuserDecisions(results);                   // applied, already_applied, refused (+ code)
```

| Method | Route | Role |
| --- | --- | --- |
| `lireReglages()` | `GET /v1/conscience/settings` | Settings (`conscience-settings/1`) with `If-None-Match`; rejects with `ErreurConscience` when the dashboard does not answer |
| `envoyerBilan(report, proposals?)` | `POST /v1/conscience/report` | Report and the **complete** list of pending proposals, reduced by `resumerBilan` |
| `lireDecisions({ toutes? })` | `GET /v1/conscience/decisions` | Decisions not acknowledged yet (with `toutes`: all of them, cursor in memory) |
| `accuserDecision(id, { result, code })` | `POST /v1/conscience/decisions/:id/ack` | What the governor did with the decision |
| `accuserDecisions(results)` | same | Acknowledges a list; a `failed` result is not acknowledged and comes back next time |

`resumerBilan(report, proposals?)` keeps only ids, codes (`answer_style`, `tool_reliability`…) and numbers: no question, answer, note, decision id, `tests` object, rollback plan, owner, nor the identity of a person who proposed. A string the masking would change is dropped. The dashboard checks again and refuses anything else.

Errors are `ErreurConscience`: HTTP `statut` (or `null` when offline) and `code` (`invalid_api_key`, `sensitive_data`, `reseau`…).

## What is captured

- **Node**: uncaught exceptions (recorded as `fatal`, then Node's normal behaviour), unhandled rejections, Express requests (`X-Request-Id`, templated route, duration, status, breadcrumb), Express errors (status ≥ 500: `erreur`, otherwise `avertissement`), flush on exit (`beforeExit`, `SIGTERM`, `SIGINT`, 2 s at most).
- **Browser**: `error` and `unhandledrejection` (without replacing `window.onerror`), templated SPA views, first page load time, sessions, final send with `navigator.sendBeacon` and `?cle=`.
- **Expo**: `ErrorUtils.setGlobalHandler`, sessions tied to `AppState` (end after 30 s in the background), screens. `signalerPlantageNatif(report)` waits for the future native module.
- **Reinforced monitoring** (browser and Expo, `/vigilance`, each part can be switched off):
  - `fetch` requests in the breadcrumbs (template, status, duration); no response, 5xx, 408 and 429 reported (`RequeteSansReponse`, `RequeteEchouee`); sends to the Centrale and aborted requests are ignored (`requetes`);
  - `console.error` reported (once per message every 10 s), `console.warn` in the breadcrumbs (`console`);
  - connectivity checks made by operating systems and libraries (Google's `generate_204`, `captive.apple.com`, `msftconnecttest.com`, `detectportal.firefox.com`…) stay in the breadcrumbs but are never reported: their failure only means the network is missing (`estVerificationDeConnexion(adresse)`);
  - main-thread watchdog: an interface frozen for more than 2 s is reported (`AppBloquee`, an error beyond 5 s), paused in the background and, on Expo, as soon as the state is `inactive` (control centre, app switcher, locking in progress) (`blocages`). A timer delay of more than 60 s is not a freeze but an **app pause** (phone locked, tab asleep: JavaScript was suspended before it learned it went to the background): only a breadcrumb « Pause de l'app N s », no error. This ceiling is set with `plafondMs` when calling `surveillerBlocages(centrale, { plafondMs })` from `@astratra/centrale/vigilance`;
  - Expo: unhandled promise rejections (Hermes, `promesses`), iOS memory warning (`MemoireSaturee`, at most once a minute), foreground, background and launch in the breadcrumbs;
  - with a `stockage`: breadcrumbs, screen and open session are kept as they change; on the next launch, a session left open is closed as `anormal` (or `plantage` after a fatal error), and a close while in the foreground is reported (`FermetureInattendue`, with breadcrumbs and screen). Browser: only for apps used in a single tab.
- **AI**: provider, model, tool, duration, tokens, outcome (`ok`, `erreur`, `quota`, `repli`). **Never the content.**

Sending: batches of at most 100 events (1 MiB at most), every 10 s or as soon as 50 events wait; queue of 500 events; progressive backoff (2 s, 4 s… capped at 5 min); `Retry-After` honoured on 429; silent drop on 400, 401, 413; offline, the queue waits.

## Source maps

If the build went through `centrale injecter` (package `@astratra/centrale-cli`), each stack frame gets the `debugId` of its file, and the error too when the whole stack comes from one file. The backend uses it to find the real line. Nothing to configure.

## Privacy

- No cookie; no local storage without `stockage` (it only keeps the already masked breadcrumbs, the screen and the session id).
- Masking **before any send**: e-mails, phone numbers, cards, IBAN, keys, tokens, passwords, and the given `noms`.
- Addresses reduced to their template (`/student/123?token=x` becomes `/student/:id`).
- User: only a salted SHA-256 fingerprint, never the raw id.
- `strict` mode: no user, no precise device.
- Usage: simple properties only (short text, number, boolean).

## What the package does not do

- It hosts neither backend nor dashboard: it sends events to the address you give.
- It captures neither the content of AI calls nor cookies.
- Native crash reports (iOS, Android) are not captured yet.

## License

MIT.

## Tests

```sh
npm test -w @astratra/centrale
npx tsc -p packages/centrale/tsconfig.json --noEmit
```
