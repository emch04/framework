import fs from 'node:fs';
import path from 'node:path';

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

function packageJson(projectName, template) {
  const dependencies = {
    '@astratra/saas-kit': '^0.1.0',
    express: '^4.18.3'
  };
  const devDependencies = {};

  if (template === 'fullstack') {
    dependencies['@astratra/saas-kit-ui'] = '^0.1.0';
    dependencies.react = '^19.0.0';
    dependencies['react-dom'] = '^19.0.0';
    devDependencies['@vitejs/plugin-react'] = '^4.3.4';
    devDependencies.vite = '^7.0.0';
  }

  return JSON.stringify({
    name: toPackageName(projectName),
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: {
      'dev:api': 'node api/server.js',
      ...(template === 'fullstack' ? { 'dev:web': 'vite --host 127.0.0.1' } : {}),
      start: 'node api/server.js'
    },
    dependencies,
    ...(Object.keys(devDependencies).length > 0 ? { devDependencies } : {})
  }, null, 2);
}

function apiServer() {
  return `import express from 'express';
import saasKit from '@astratra/saas-kit';

const { createSaasApp, createMemorySettingsStore } = saasKit;
const port = Number(process.env.PORT || 4000);
const host = process.env.HOST || '127.0.0.1';
const allowedOrigins = new Set((process.env.CORS_ORIGIN || 'http://127.0.0.1:5173,http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean));

const app = express();
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

app.use(createSaasApp({
  jwtSecret: process.env.JWT_SECRET || 'change-me-in-production',
  settingsStore: createMemorySettingsStore({
    productName: 'Astratra App',
    supportEmail: 'support@example.test',
    onboardingEnabled: true
  }),
  verifyPassword: async (user, password) => user.password === password,
  notify: async (message) => ({ delivered: true, message })
}));

app.listen(port, host, () => {
  console.log(\`Astratra API listening on http://\${host}:\${port}\`);
  console.log('Seeded owner: owner@example.test / password');
  console.log('Seeded member: member@example.test / password');
});
`;
}

function viteConfig() {
  return `import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173
  }
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
Dans un deuxieme terminal :

\`\`\`bash
npm run dev:web
\`\`\`
`
    : '';

  return `# ${projectName}

Application generee avec Astratra.

## Installation

\`\`\`bash
npm install
\`\`\`

## Lancement

\`\`\`bash
npm run dev:api
\`\`\`
${webSteps}
Comptes de test :

- \`owner@example.test\` / \`password\`
- \`member@example.test\` / \`password\`

Avant la production, remplace \`JWT_SECRET\`, branche de vrais stores et change
la verification de mot de passe.
`;
}

export function parseArgs(args) {
  const options = {
    targetDir: null,
    template: 'fullstack',
    force: false
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
    } else if (!options.targetDir) {
      options.targetDir = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.targetDir) {
    throw new Error('Usage: create-astratra-app <directory> [--template api|fullstack] [--force]');
  }
  if (!VALID_TEMPLATES.has(options.template)) {
    throw new Error(`Unknown template "${options.template}". Use api or fullstack.`);
  }

  return options;
}

export function createProject({ targetDir, template = 'fullstack', force = false }, cwd = process.cwd()) {
  const absoluteTarget = path.resolve(cwd, targetDir);
  const projectName = path.basename(absoluteTarget);

  assertCanCreate(absoluteTarget, force);
  fs.mkdirSync(absoluteTarget, { recursive: true });

  writeFile(absoluteTarget, 'package.json', `${packageJson(projectName, template)}\n`);
  writeFile(absoluteTarget, 'api/server.js', apiServer());
  writeFile(absoluteTarget, '.env.example', 'PORT=4000\nHOST=127.0.0.1\nJWT_SECRET=change-me\nCORS_ORIGIN=http://127.0.0.1:5173,http://localhost:5173\n');
  writeFile(absoluteTarget, 'README.md', readme(projectName, template));

  if (template === 'fullstack') {
    writeFile(absoluteTarget, 'vite.config.js', viteConfig());
    writeFile(absoluteTarget, 'web/index.html', webIndex());
    writeFile(absoluteTarget, 'web/src/main.jsx', webMain());
  }

  return {
    targetDir: absoluteTarget,
    nextSteps: [
      `cd ${targetDir}`,
      'npm install',
      'npm run dev:api',
      ...(template === 'fullstack' ? ['npm run dev:web'] : [])
    ]
  };
}
