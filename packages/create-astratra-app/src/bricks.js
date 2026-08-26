/**
 * Les briques optionnelles, et le fichier d'exemple qui va avec chacune.
 *
 * Le générateur n'installe PAS tout par défaut, et c'est un choix : la plupart
 * de ces packages n'ont aucune dépendance précisément pour qu'on n'en prenne
 * que ce dont on a besoin. Un site vitrine qui veut un moteur PDF n'a que faire
 * d'un tuyau de webhooks de paiement.
 *
 * Une brique demandée fait deux choses : elle s'ajoute aux dépendances, et elle
 * écrit un fichier montrant comment la câbler dans CE projet — pas un extrait
 * de README à recopier, du code qui compile et qu'on branche quand on veut.
 *
 * Rien n'est câblé automatiquement dans server.js. Même raison que pour
 * store-mongo, déjà scaffoldé sans être branché : une application fraîchement
 * générée doit démarrer sans configuration, pas réclamer six variables
 * d'environnement avant son premier `npm run dev:api`.
 */

/** Briques réservées au gabarit fullstack (elles touchent au navigateur ou au build). */
const FULLSTACK_ONLY = new Set(['client', 'prerender']);

const BRICKS = {
  credentials: {
    package: '@astratra/credentials',
    version: '^0.3.0',
    summary: 'clés de service chiffrées en base, modifiables sans redémarrage',
    file: 'api/bricks/credentials.js',
    contents: () => `import { createFieldCipher } from '@astratra/security';
import {
  createCredentialCatalog,
  createCredentialVault,
  createEnvHydrator,
  createMemoryCredentialStore
} from '@astratra/credentials';

// Ce que l'interface a le droit de piloter. Jamais un champ libre : sans
// catalogue, n'importe quel nom de variable pourrait être écrit en base puis
// lu au démarrage.
export const catalog = createCredentialCatalog({
  spaces: [
    {
      id: 'providers',
      label: 'Fournisseurs',
      keys: [
        {
          key: 'SOME_API_KEY',
          label: 'Clé du fournisseur',
          help: "Ce qui cesse de marcher sans elle.",
          where: 'console.example.com → API Keys'
        }
      ]
    }
  ],
  // La serrure ne se range pas dans le coffre qu'elle ferme.
  reservedKeys: ['ENCRYPTION_KEY', 'JWT_SECRET', 'MONGODB_URI']
});

// En mémoire pour démarrer. En production : createMongoCredentialStore({ collection }).
const store = createMemoryCredentialStore();

export const vault = createCredentialVault({
  store,
  catalog,
  cipher: createFieldCipher({ key: process.env.ENCRYPTION_KEY })
});

// Le reste du code continue de lire process.env — il n'a rien à changer.
export const hydrator = createEnvHydrator({ vault });
`
  },

  entitlements: {
    package: '@astratra/entitlements',
    version: '^0.4.0',
    summary: 'plans, droits d’accès, isolation par locataire, invitations',
    file: 'api/bricks/entitlements.js',
    contents: () => `import { createFeatureGuard, createPlanCatalog, createTenantScope } from '@astratra/entitlements';

export const plans = createPlanCatalog({
  plans: {
    free: ['dashboard'],
    pro: ['dashboard', 'reports', 'analytics']
  },
  labels: { free: 'Free', pro: 'Pro' },
  upgradePath: { free: 'pro' },
  // Un plan inconnu retombe sur le PLUS PETIT, jamais sur le plus généreux.
  fallbackPlan: 'free'
});

export const featureGuard = createFeatureGuard({
  plans,
  // Où vit le plan du compte : à toi de le dire. null = rien à facturer ici.
  resolveAccount: async (req) => (req.user ? { plan: req.user.plan, overrides: [] } : null)
});

// Pas de locataire = AUCUNE ligne, jamais toutes les lignes.
export const tenants = createTenantScope({
  field: 'organisation',
  globalRoles: ['owner'],
  onMissingTenant: (user) => console.error('compte sans organisation', user)
});
`
  },

  notify: {
    package: '@astratra/notify',
    version: '^0.2.0',
    summary: 'e-mail, SMS et notifications poussées, transport injecté',
    file: 'api/bricks/notify.js',
    contents: () => `import { createCaptureChannel, createMailer, renderEmail, renderText } from '@astratra/notify';

// En développement, on capture au lieu d'envoyer : un envoi réel atteindrait
// une vraie personne. Remplacer par un transport (nodemailer, une API HTTP)
// quand le projet a des identifiants.
export const capture = createCaptureChannel({ from: 'no-reply@example.com', fromName: 'Astratra' });

export const mailer = createMailer({ channels: { transactional: capture } });

export async function sendWelcome(to, name) {
  const blocks = [
    { type: 'heading', text: \`Bienvenue \${name}\` },
    { type: 'paragraph', text: 'Votre compte est actif.' },
    { type: 'button', label: 'Ouvrir', url: 'https://example.com/login' }
  ];

  // Ne lève jamais : un e-mail est la conséquence d'une action, pas l'action.
  return mailer.send({
    to,
    subject: 'Bienvenue',
    html: renderEmail({ blocks, preheader: 'Votre compte est actif' }),
    text: renderText({ blocks })
  });
}
`
  },

  payments: {
    package: '@astratra/payments',
    version: '^0.2.0',
    summary: 'webhooks de paiement : signature, rejeux, exemptions',
    file: 'api/bricks/payments.js',
    contents: () => `import {
  createMemoryEventLog,
  createWebhookExemption,
  createWebhookHandler
} from '@astratra/payments';

// UN seul prédicat, partagé par le parseur JSON, le CSRF et les gardes.
// Quatre couches qui l'écrivent chacune de leur côté finissent par diverger,
// et un webhook meurt en silence.
export const isWebhook = createWebhookExemption({ prefix: '/api/payments/', suffix: '/webhook' });

export const webhook = createWebhookHandler({
  // Propre au prestataire, et DOIT lever si la signature ne correspond pas.
  verify: ({ payload, headers, secret }) => {
    void [payload, headers, secret];
    throw new Error('Branche ici stripe.webhooks.constructEvent (ou équivalent).');
  },
  secret: () => process.env.PAYMENT_WEBHOOK_SECRET,
  eventLog: createMemoryEventLog(),
  events: {
    'checkout.session.completed': async (event, { sideEffect, unrelated }) => {
      const order = null; // await orders.findBySession(event.data.object.id)
      // Un point d'entrée reçoit les événements de TOUS les flux du compte.
      if (!order) return unrelated('cette session n\\'est pas une commande');

      // L'argent est déjà pris : un envoi raté ne doit pas provoquer de relance.
      await sideEffect('reçu', async () => {});
    }
  }
});

// app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), webhook.middleware);
`
  },

  privacy: {
    package: '@astratra/privacy',
    version: '^0.1.0',
    summary: 'droit d’accès, droit à l’oubli, nettoyage des journaux',
    file: 'api/bricks/privacy.js',
    contents: () => `import {
  createAnonymizer,
  createDataExporter,
  createErasureWorkflow,
  createMemoryErasureStore,
  createRedactor
} from '@astratra/privacy';

// À écrire avant tout journal : une adresse qui part chez un tiers a quitté
// ton système, quoi que dise ta politique de confidentialité.
export const redactor = createRedactor();

export const exporter = createDataExporter({
  sources: [
    { key: 'account', collect: async (id) => ({ id }) },
    // Nommé, pas caché : un export auquel il manque une section en silence a
    // l'air complet et ne l'est pas.
    { key: 'payments', label: 'Paiements', elsewhere: 'service de facturation — écrire au support' }
  ]
});

// ANONYMISER, PAS SUPPRIMER : les factures et les dossiers ont leur propre
// conservation légale. Ce que la loi demande, c'est que la personne cesse
// d'être identifiable.
const anonymizer = createAnonymizer({
  fields: {
    fullName: 'redact',
    email: (_value, { token }) => \`efface-\${token}@invalid\`,
    phone: 'clear'
  }
});

export const erasure = createErasureWorkflow({
  store: createMemoryErasureStore(),
  erase: async (request) => anonymizer.anonymise({ id: request.subject })
});
`
  },

  resilience: {
    package: '@astratra/resilience',
    version: '^0.1.0',
    summary: 'disjoncteur, cache TTL, relance avec brouillage',
    file: 'api/bricks/resilience.js',
    contents: () => `import { createCache, createCircuitBreaker, retry } from '@astratra/resilience';

// Une dépendance en panne échoue LENTEMENT : chaque appel attend son délai et
// les requêtes s'empilent. Le disjoncteur remplace l'échec lent par un rapide.
export const breaker = createCircuitBreaker({
  name: 'provider',
  failureThreshold: 3,
  recoveryMs: 20_000,
  // Un 404 est une réponse, pas une panne.
  isFailure: (error) => !error.statusCode || error.statusCode >= 500
});

// Un cache dont l'absence est survivable : un store cassé se lit comme une
// absence, jamais comme une erreur.
export const cache = createCache({ prefix: 'app', ttlSeconds: 300 });

export async function fetchWithGuards(key, call) {
  return cache.remember(key, () => breaker.call(() => retry(call)));
}
`
  },

  'i18n-server': {
    package: '@astratra/i18n-server',
    version: '^0.1.0',
    summary: 'messages du serveur traduits, audit de lisibilité',
    file: 'api/bricks/i18n.js',
    contents: () => `import {
  createLanguageResolver,
  createMessageCatalog,
  createTranslationMiddleware
} from '@astratra/i18n-server';

const languages = ['en', 'fr'];

// La CLÉ est la phrase source elle-même : aucun identifiant à inventer, aucun
// appel à modifier, et une phrase absente revient dans la langue d'origine.
export const catalog = createMessageCatalog({
  languages,
  defaultLanguage: 'en',
  messages: {
    'This item could not be found.': { fr: 'Cet élément est introuvable.' }
  }
});

export const resolver = createLanguageResolver({ languages, defaultLanguage: 'en' });

// La traduction se fait UNE fois, à la sortie. Les contrôleurs ne changent pas.
export const translation = createTranslationMiddleware({ catalog, resolver });
`
  },

  pdf: {
    package: '@astratra/pdf',
    version: '^0.1.0',
    summary: 'texte borné et tableaux qui se paginent (PDFKit)',
    file: 'api/bricks/pdf.js',
    contents: () => `import { drawTable, keepTogether, line } from '@astratra/pdf';

// Nécessite pdfkit : npm install pdfkit
export function renderInvoice(doc, invoice) {
  // Bornée et coupée, une valeur ne peut plus mordre sur sa voisine.
  line(doc, invoice.customer, 40, 60, 260);

  const { y } = drawTable(doc, {
    x: 40,
    y: 110,
    width: 515,
    columns: [
      { key: 'label', label: 'DÉSIGNATION', width: 300 },
      { key: 'amount', label: 'MONTANT', align: 'right', format: (v) => \`\${v} €\` }
    ],
    rows: invoice.lines,
    // Réserve la place du bloc de total qui suit.
    bottom: doc.page.height - 160,
    zebra: '#FAFAFA'
  });

  // Un total coupé en deux est pire qu'une coupure de page avant lui.
  const totalY = keepTogether(doc, { y: y + 20, height: 80 });
  doc.text(\`Total : \${invoice.total} €\`, 360, totalY);
}
`
  },

  closure: {
    package: '@astratra/closure',
    version: '^0.1.0',
    summary: 'clôture de période et archives sans identifiants',
    file: 'api/bricks/closure.js',
    contents: () => `import { createArchiveBuilder, createClosureChecklist, createScrubber } from '@astratra/closure';

// \`blocking\` interdit de fermer ; le reste demande seulement à être VU.
// Fermer avec des impayés est légitime — le faire sans avoir regardé ne l'est pas.
export const checklist = createClosureChecklist([
  { id: 'pending_reviews', label: 'Décisions à trancher', blocking: true },
  { id: 'unpaid_invoices', label: 'Factures impayées', blocking: false }
]);

export const archive = createArchiveBuilder({
  // Le nettoyage se fait À LA FRONTIÈRE, pas en faisant confiance à chaque
  // lecteur : c'est la seule version qui survit au prochain qui ajoute une
  // collection.
  scrubber: createScrubber(),
  sections: [
    { name: 'accounts', read: async (scope) => [{ id: scope.periodId }] }
  ]
});
`
  },

  client: {
    package: '@astratra/client',
    version: '^0.3.0',
    summary: 'session sur 401, garde de route, mots de passe, file hors ligne',
    file: 'web/src/lib/client.js',
    contents: () => `import { createPasswordRules, createRouteGuard, createSessionClient } from '@astratra/client';

export const session = createSessionClient({
  request: async (path, init) => {
    const response = await fetch(path, { credentials: 'include', ...init });
    if (!response.ok) throw Object.assign(new Error(response.statusText), { status: response.status });
    return response.json();
  },
  refresh: async () => {
    const response = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
    if (!response.ok) throw new Error('refresh failed');
  },
  // Sinon : le refresh répond 401, on tente de rafraîchir, qui répond 401…
  excluded: ['/api/auth/refresh', '/api/auth/login'],
  onSessionExpired: () => { window.location.href = '/login'; }
});

// La liste nomme ce qui est PUBLIC — tout le reste est fermé. Une liste
// d'écrans protégés laisse passer chaque écran ajouté puis oublié.
export const guard = createRouteGuard({ publicSegments: ['login', 'reset-password'] });

// Le même module tourne sur le serveur : les deux bouts ne peuvent plus diverger.
export const passwordRules = createPasswordRules();
`
  },

  prerender: {
    package: '@astratra/prerender',
    version: '^0.2.0',
    summary: 'prérendu SEO + sitemap tiré de la même liste',
    file: 'astratra.prerender.config.cjs',
    contents: () => `// Lancé après le build : "vite build && astratra-prerender"
module.exports = {
  siteUrl: 'https://www.example.com',
  distDir: 'dist',
  waitFor: 'meta[name="description"]',
  routes: [
    { path: '/', label: 'Accueil', changefreq: 'daily', priority: '1.0' },
    // Rendue pour un robot qui suit un lien, sans place au plan de site.
    { path: '/login', sitemap: false }
  ],
  // Écrit dist/sitemap.xml depuis la MÊME liste que les pages : les deux ne
  // peuvent plus diverger. Laissé absent, un sitemap déjà présent est relu
  // sans être touché et ses URLs sans page remontent en avertissement.
  sitemap: true
};
`
  }
};

export const BRICK_NAMES = Object.keys(BRICKS);

/** Une brique est-elle compatible avec ce gabarit ? */
export function brickFitsTemplate(name, template) {
  return template === 'fullstack' || !FULLSTACK_ONLY.has(name);
}

/**
 * Résout la liste demandée. `all` prend tout ce que le gabarit accepte.
 *
 * Un nom inconnu est refusé avec la liste des noms valides : se tromper de
 * brique doit coûter une seconde, pas une recherche dans la documentation.
 */
export function resolveBricks(requested, template) {
  const names = [];
  for (const raw of requested || []) {
    const name = String(raw).trim();
    if (!name) continue;
    if (name === 'all') {
      for (const candidate of BRICK_NAMES) {
        if (brickFitsTemplate(candidate, template) && !names.includes(candidate)) names.push(candidate);
      }
      continue;
    }
    if (!BRICKS[name]) {
      throw new Error(`Unknown brick "${name}". Available: ${BRICK_NAMES.join(', ')}, all`);
    }
    if (!brickFitsTemplate(name, template)) {
      throw new Error(`Brick "${name}" needs the fullstack template.`);
    }
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

export function brickDependencies(names) {
  const dependencies = {};
  for (const name of names) dependencies[BRICKS[name].package] = BRICKS[name].version;
  return dependencies;
}

export function brickFiles(names) {
  return names.map((name) => ({ path: BRICKS[name].file, contents: BRICKS[name].contents() }));
}

export { BRICKS };
