import fs from 'node:fs';
import path from 'node:path';
import { BRICK_NAMES, brickDependencies, brickFiles, resolveBricks } from './bricks.js';

const VALID_TEMPLATES = new Set(['api', 'fullstack']);

function toPackageName(projectName) {
  return projectName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'astratra-app';
}

function writeFile(targetDir, filePath, content) {
  const absolutePath = path.join(targetDir, filePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
}

function assertCanCreate(targetDir, force) {
  if (!fs.existsSync(targetDir)) return;
  const entries = fs.readdirSync(targetDir);
  if (entries.length > 0 && !force) {
    throw new Error(`Target directory is not empty: ${targetDir}`);
  }
}

function packageJson(projectName, template, bricks = []) {
  const dependencies = {
    '@astratra/ai': '^1.0.0',
    '@astratra/core': '^1.0.0',
    '@astratra/saas-kit': '^1.3.0',
    '@astratra/security': '^1.3.0'
  };
  // Scaffolded (api/stores/mongo.js, api/db/mongo.js) but not wired into
  // api/server.js by default — the project starts on the in-memory store.
  // Kept optional so a from-scratch install doesn't pull in mongoose (a
  // real driver dependency) before the project has ever chosen to use it.
  // `npm install @astratra/store-mongo mongoose` to switch to MongoDB.
  const optionalDependencies = {
    '@astratra/store-mongo': '^1.0.1',
    mongoose: '^8.17.0'
  };
  const devDependencies = {};

  if (template === 'fullstack') {
    dependencies['@astratra/saas-kit-ui'] = '^1.0.0';
    dependencies.react = '^19.0.0';
    dependencies['react-dom'] = '^19.0.0';
    devDependencies['@vitejs/plugin-react'] = '^4.3.4';
    devDependencies.vite = '^7.0.0';
  }

  // Les briques demandées s'ajoutent aux dépendances. Rien n'est ajouté sans
  // qu'on l'ait demandé : la plupart de ces packages n'ont aucune dépendance
  // précisément pour qu'on n'en prenne que ce dont on a besoin.
  Object.assign(dependencies, brickDependencies(bricks));

  return JSON.stringify({
    name: toPackageName(projectName),
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: {
      ...(template === 'fullstack' ? { dev: 'node scripts/dev.js' } : {}),
      'dev:api': 'node api/server.js',
      ...(template === 'fullstack' ? { 'dev:web': 'vite --host 127.0.0.1' } : {}),
      start: 'node api/server.js'
    },
    dependencies,
    optionalDependencies,
    ...(Object.keys(devDependencies).length > 0 ? { devDependencies } : {})
  }, null, 2);
}

function apiServer() {
  return `import fs from 'node:fs';
import path from 'node:path';
import { BRICK_NAMES, brickDependencies, brickFiles, resolveBricks } from './bricks.js';
import saasKit from '@astratra/saas-kit';
import { env } from './config/env.js';
import { createAuthSecurity } from './security/auth.js';
import { createRateLimitSecurity } from './security/rateLimit.js';
import { createWafSecurity } from './security/waf.js';
import { createMemoryStores } from './stores/memory.js';
import { userPublicFields } from './modules/users.js';
import { createNotificationModule } from './modules/notifications.js';
import { createAiTools } from './ai/tools.js';

const { createSaasApp } = saasKit;
const preferredPort = env.port;
const host = env.host;
const stores = createMemoryStores();
const notifications = createNotificationModule();
const aiTools = createAiTools();

const app = createSaasApp({
  // Mounted FIRST, ahead of every other middleware — required for CORS
  // headers to reach the OPTIONS preflight response too. Astratra has no
  // fixed opinion on which origins to allow (that's project-specific);
  // env.corsOrigins comes from CORS_ORIGIN in .env.
  cors: { allowedOrigins: env.corsOrigins },
  ...createAuthSecurity(env),
  ...createRateLimitSecurity(env),
  ...createWafSecurity(env),
  usersStore: stores.usersStore,
  settingsStore: stores.settingsStore,
  publicUserFields: userPublicFields(),
  verifyPassword: async (user, password) => user.password === password,
  notify: notifications.notify,
  // This is where YOUR routes go — not app.use()'d after createSaasApp()
  // returns. createSaasApp() ends its own middleware stack with a
  // catch-all 404 handler, so anything registered on the app afterward
  // is unreachable. extendRoutes runs before that catch-all, with the
  // same authMiddleware/csrfMiddleware instances the built-in routes use.
  extendRoutes: (saasApp, { authMiddleware }) => {
    saasApp.get('/api/status', authMiddleware, async (req, res, next) => {
      try {
        const healthCheck = aiTools.getToolByName('health_check');
        const result = await healthCheck.handler({}, { user: req.user });
        res.status(200).json({ success: true, message: 'Status', data: result });
      } catch (error) {
        next(error);
      }
    });
  }
});

function writeApiRuntimeConfig(port) {
  const configDir = path.resolve('.astratra');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'api.json'), JSON.stringify({
    apiUrl: \`http://\${host}:\${port}\`
  }, null, 2));
}

function listen(port, attemptsLeft = 20) {
  const server = app.listen(port, host, () => {
    const address = server.address();
    const selectedPort = typeof address === 'object' && address ? address.port : port;
    writeApiRuntimeConfig(selectedPort);
    console.log(\`Astratra API listening on http://\${host}:\${selectedPort}\`);
    console.log('Seeded owner: owner@example.test / password');
    console.log('Seeded member: member@example.test / password');
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE' && attemptsLeft > 0 && !process.env.PORT) {
      const nextPort = port + 1;
      console.warn(\`Port \${port} is already in use, trying \${nextPort}...\`);
      listen(nextPort, attemptsLeft - 1);
      return;
    }

    console.error(\`Unable to start Astratra API on http://\${host}:\${port}: \${error.message}\`);
    process.exit(1);
  });
}

listen(preferredPort);
`;
}

function envConfig() {
  return `const nodeEnv = process.env.NODE_ENV || 'development';
const jwtSecret = process.env.JWT_SECRET || 'change-me-in-production';

function assertProductionEnv() {
  if (nodeEnv === 'production' && jwtSecret === 'change-me-in-production') {
    throw new Error('JWT_SECRET is required in production.');
  }
}

assertProductionEnv();

export const env = {
  nodeEnv,
  port: process.env.PORT ? Number(process.env.PORT) : 0,
  host: process.env.HOST || '127.0.0.1',
  jwtSecret,
  legacyJwtSecret: process.env.LEGACY_JWT_SECRET || '',
  jwtIssuer: process.env.JWT_ISSUER || '',
  jwtAudience: process.env.JWT_AUDIENCE || '',
  mongoUri: process.env.MONGO_URI || '',
  redisUrl: process.env.REDIS_URL || '',
  corsOrigins: (process.env.CORS_ORIGIN || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
};
`;
}

function securityAuth() {
  return `export function createAuthSecurity(env) {
  return {
    jwtSecret: env.jwtSecret,
    legacyJwtSecret: env.legacyJwtSecret || undefined,
    jwtAlgorithms: ['HS256'],
    jwtIssuer: env.jwtIssuer || undefined,
    jwtAudience: env.jwtAudience || undefined,
    roles: {
      adminRoles: ['owner', 'admin']
    }
  };
}
`;
}

function securityRateLimit() {
  return `export function createRateLimitSecurity(env) {
  return {
    apiRateLimit: {
      windowMs: 15 * 60 * 1000,
      max: 300,
      redisUrl: env.redisUrl || undefined
    },
    loginRateLimit: {
      windowMs: 15 * 60 * 1000,
      max: 10,
      redisUrl: env.redisUrl || undefined
    }
  };
}
`;
}

function securityWaf() {
  return `export function createWafSecurity() {
  return {
    waf: {
      message: {
        success: false,
        message: 'Request blocked by Astratra security policy.'
      }
    }
  };
}
`;
}

function memoryStores() {
  return `import saasKit from '@astratra/saas-kit';
import { defaultSettings } from '../modules/settings.js';

const { createMemorySettingsStore, createMemoryUsersStore } = saasKit;

export function createMemoryStores() {
  return {
    usersStore: createMemoryUsersStore(),
    settingsStore: createMemorySettingsStore(defaultSettings)
  };
}
`;
}

function mongoDb() {
  return `import mongoose from 'mongoose';

export async function connectMongo(uri, options = {}) {
  if (!uri) {
    throw new Error('MONGO_URI is required to connect MongoDB.');
  }
  await mongoose.connect(uri, options);
  return mongoose.connection;
}
`;
}

function mongoStores() {
  return `import storeMongo from '@astratra/store-mongo';

const { createMongoSettingsStore, createMongoUsersStore } = storeMongo;

export function createMongoStores({ uri, connection } = {}) {
  const options = connection ? { connection } : { uri };
  return {
    usersStore: createMongoUsersStore(options),
    settingsStore: createMongoSettingsStore(options)
  };
}
`;
}

function aiProviders() {
  return `import ai from '@astratra/ai';

const { createProviderRouter } = ai;

export function createAiRouter() {
  return createProviderRouter({
    providers: [
      // Ajoute ici OpenAI, Workers AI, Groq, Mistral, Gemini, etc.
      // Chaque provider doit exposer { id, models, call(prompt, ctx, model) }.
    ],
    intentRouting: {}
  });
}
`;
}

function aiTools() {
  return `import ai from '@astratra/ai';

const { createToolRegistry } = ai;

export function createAiTools() {
  const registry = createToolRegistry();

  registry.register({
    name: 'health_check',
    type: 'internal',
    description: 'Retourne un statut simple de l application.',
    roles: ['owner', 'admin'],
    params: {},
    handler: async () => ({ ok: true })
  });

  return registry;
}
`;
}

function aiAgent() {
  return `import ai from '@astratra/ai';
import { createAiRouter } from './providers.js';
import { createAiTools } from './tools.js';

const { runAgentLoop } = ai;

export function createAgent() {
  const router = createAiRouter();
  const registry = createAiTools();

  return {
    ask: ({ prompt, userRole = 'owner', ctx = {} }) => runAgentLoop({
      prompt,
      userRole,
      ctx,
      registry,
      router
    }),
    stop: () => router.stop()
  };
}
`;
}

function usersModule() {
  return `export function userPublicFields() {
  return ['id', 'email', 'role'];
}
`;
}

function settingsModule() {
  return `export const defaultSettings = {
  productName: 'Astratra App',
  supportEmail: 'support@example.test',
  onboardingEnabled: true
};
`;
}

function notificationsModule() {
  return `export function createNotificationModule() {
  return {
    notify: async (userId, notification) => ({
      delivered: true,
      userId,
      notification
    })
  };
}
`;
}

function viteConfig() {
  return `import fs from 'node:fs';
import path from 'node:path';
import { BRICK_NAMES, brickDependencies, brickFiles, resolveBricks } from './bricks.js';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

function readApiUrl() {
  try {
    const configPath = path.resolve('.astratra/api.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return config.apiUrl || '';
  } catch {
    return '';
  }
}

process.env.VITE_API_URL = process.env.VITE_API_URL || readApiUrl();

export default defineConfig({
  root: 'web',
  plugins: [react()],
  server: {
    host: '127.0.0.1'
  }
});
`;
}

function devScript() {
  return `import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';

const isWindows = process.platform === 'win32';
const npmCommand = isWindows ? 'npm.cmd' : 'npm';
const apiConfigPath = '.astratra/api.json';
const timeoutMs = 15000;
const pollMs = 150;
const startedAt = Date.now();
const children = [];
let shuttingDown = false;

function run(label, args) {
  const child = spawn(npmCommand, args, {
    stdio: 'inherit',
    env: process.env
  });
  children.push(child);
  child.on('exit', (code, signal) => {
    if (!shuttingDown && code !== 0) {
      console.error(\`\${label} exited with \${signal || code}.\`);
      shutdown(code || 1);
    }
  });
  return child;
}

function findFreePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function shutdown(code = 0) {
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  process.exit(code);
}

async function waitForApiConfig() {
  if (fs.existsSync(apiConfigPath)) {
    const webPort = await findFreePort();
    run('web', ['run', 'dev:web', '--', '--port', String(webPort)]);
    return;
  }

  if (Date.now() - startedAt > timeoutMs) {
    console.error(\`Timed out waiting for \${apiConfigPath}. Is dev:api still running?\`);
    shutdown(1);
    return;
  }

  setTimeout(() => {
    waitForApiConfig().catch((error) => {
      console.error(error.message);
      shutdown(1);
    });
  }, pollMs);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

fs.rmSync(apiConfigPath, { force: true });
run('api', ['run', 'dev:api']);
waitForApiConfig().catch((error) => {
  console.error(error.message);
  shutdown(1);
});
`;
}

function webIndex() {
  return `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Astratra App</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`;
}

function webMain() {
  return `import React from 'react';
import { createRoot } from 'react-dom/client';
import { AstratraDashboardApp } from '@astratra/saas-kit-ui';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AstratraDashboardApp />
  </React.StrictMode>
);
`;
}

function readme(projectName, template) {
  const webSteps = template === 'fullstack'
    ? `
Pour lancer l'API et le frontend ensemble :

\`\`\`bash
npm run dev
\`\`\`

Tu peux aussi les lancer separement :

\`\`\`bash
npm run dev:api
npm run dev:web
\`\`\`
`
    : '';

  return `# ${projectName}

Application créée avec Astratra.

## Installation

\`\`\`bash
npm install
\`\`\`

## Lancement

\`\`\`bash
npm run dev:api
\`\`\`
${webSteps}
Par défaut, l'API demande un port libre au système et écrit l'URL choisie
dans \`.astratra/api.json\`. Lance \`dev:api\` avant \`dev:web\` pour que Vite
lise la bonne URL. Laisse \`PORT\` vide pour garder le choix automatique.

## Ajouter tes propres routes

\`api/server.js\` montre le motif à suivre avec \`GET /api/status\` : passe une
fonction \`extendRoutes(app, { authMiddleware, csrfMiddleware })\` à
\`createSaasApp()\`, ne fais pas \`app.use()\` sur l'app retournée après coup —
\`createSaasApp()\` termine sa propre pile de middlewares par un 404
générique avant de te rendre la main, donc toute route ajoutée ensuite est
inatteignable. \`extendRoutes\` s'exécute avant ce 404, avec les mêmes
instances \`authMiddleware\`/\`csrfMiddleware\` que les routes intégrées.

CORS est géré par \`options.cors\` passé directement à \`createSaasApp()\`
dans \`api/server.js\` (origines autorisées via \`CORS_ORIGIN\` dans \`.env\`,
plus \`127.0.0.1\`/\`localhost\` autorisés automatiquement hors production).

## Fichiers Utiles

- \`api/config/env.js\` centralise la configuration.
- \`api/security/auth.js\`, \`api/security/rateLimit.js\` et
  \`api/security/waf.js\` branchent les primitives de sécurité Astratra.
- \`api/stores/memory.js\` lance vite avec des stores en mémoire.
- \`api/db/mongo.js\` et \`api/stores/mongo.js\` préparent MongoDB — installe
  d'abord \`npm install @astratra/store-mongo mongoose\` (dépendances
  optionnelles, pas installées par défaut) avant de les brancher dans
  \`api/server.js\`.
- \`api/ai/providers.js\`, \`api/ai/tools.js\` et \`api/ai/agent.js\`
  préparent la logique IA — \`api/ai/tools.js\` est déjà branché dans
  \`api/server.js\` via \`extendRoutes\` (route \`GET /api/status\`).
- \`api/modules/users.js\`, \`api/modules/settings.js\` et
  \`api/modules/notifications.js\` isolent la logique métier de départ.

Comptes de test :

- \`owner@example.test\` / \`password\`
- \`member@example.test\` / \`password\`

Avant la production, remplace \`JWT_SECRET\`, branche de vrais stores et change
la vérification de mot de passe. Définis aussi \`JWT_ISSUER\` et
\`JWT_AUDIENCE\` quand l'API sort du développement local.
`;
}

export function parseArgs(args) {
  const options = {
    targetDir: null,
    template: 'fullstack',
    force: false,
    bricks: []
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--force') {
      options.force = true;
    } else if (arg === '--template') {
      options.template = args[index + 1];
      index += 1;
    } else if (arg.startsWith('--template=')) {
      options.template = arg.slice('--template='.length);
    } else if (arg === '--with') {
      options.bricks.push(...String(args[index + 1] || '').split(','));
      index += 1;
    } else if (arg.startsWith('--with=')) {
      options.bricks.push(...arg.slice('--with='.length).split(','));
    } else if (!options.targetDir) {
      options.targetDir = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.targetDir) {
    throw new Error(
      'Usage: create-astratra-app <directory> [--template api|fullstack] ' +
      `[--with ${BRICK_NAMES.slice(0, 3).join(',')},...|all] [--force]`
    );
  }
  if (!VALID_TEMPLATES.has(options.template)) {
    throw new Error(`Unknown template "${options.template}". Use api or fullstack.`);
  }

  // Résolu ici plutôt qu'à l'écriture : un nom de brique fautif doit échouer
  // AVANT que le moindre fichier soit créé.
  options.bricks = resolveBricks(options.bricks, options.template);

  return options;
}

export function createProject({ targetDir, template = 'fullstack', force = false, bricks = [] }, cwd = process.cwd()) {
  const absoluteTarget = path.resolve(cwd, targetDir);
  const projectName = path.basename(absoluteTarget);

  assertCanCreate(absoluteTarget, force);
  fs.mkdirSync(absoluteTarget, { recursive: true });

  const selectedBricks = resolveBricks(bricks, template);

  writeFile(absoluteTarget, 'package.json', `${packageJson(projectName, template, selectedBricks)}\n`);
  writeFile(absoluteTarget, 'api/server.js', apiServer());
  writeFile(absoluteTarget, 'api/config/env.js', envConfig());
  writeFile(absoluteTarget, 'api/security/auth.js', securityAuth());
  writeFile(absoluteTarget, 'api/security/rateLimit.js', securityRateLimit());
  writeFile(absoluteTarget, 'api/security/waf.js', securityWaf());
  writeFile(absoluteTarget, 'api/stores/memory.js', memoryStores());
  writeFile(absoluteTarget, 'api/stores/mongo.js', mongoStores());
  writeFile(absoluteTarget, 'api/db/mongo.js', mongoDb());
  writeFile(absoluteTarget, 'api/ai/providers.js', aiProviders());
  writeFile(absoluteTarget, 'api/ai/tools.js', aiTools());
  writeFile(absoluteTarget, 'api/ai/agent.js', aiAgent());
  writeFile(absoluteTarget, 'api/modules/users.js', usersModule());
  writeFile(absoluteTarget, 'api/modules/settings.js', settingsModule());
  writeFile(absoluteTarget, 'api/modules/notifications.js', notificationsModule());
  writeFile(absoluteTarget, '.gitignore', 'node_modules\n.env\n.astratra\n');
  writeFile(absoluteTarget, '.env.example', 'PORT=\nHOST=127.0.0.1\nJWT_SECRET=change-me\nLEGACY_JWT_SECRET=\nJWT_ISSUER=\nJWT_AUDIENCE=\nCORS_ORIGIN=\nMONGO_URI=\nREDIS_URL=\n');
  writeFile(absoluteTarget, 'README.md', readme(projectName, template));

  if (template === 'fullstack') {
    writeFile(absoluteTarget, 'scripts/dev.js', devScript());
    writeFile(absoluteTarget, 'vite.config.js', viteConfig());
    writeFile(absoluteTarget, 'web/index.html', webIndex());
    writeFile(absoluteTarget, 'web/src/main.jsx', webMain());
  }

  // Un fichier d'exemple par brique, câblé pour CE projet — pas un extrait de
  // README à recopier. Rien n'est branché dans server.js : une application
  // fraîchement générée doit démarrer sans configuration.
  for (const brick of brickFiles(selectedBricks)) {
    writeFile(absoluteTarget, brick.path, brick.contents);
  }

  return {
    targetDir: absoluteTarget,
    bricks: selectedBricks,
    nextSteps: [
      `cd ${targetDir}`,
      'npm install',
      template === 'fullstack' ? 'npm run dev' : 'npm run dev:api'
    ]
  };
}
