import express from 'express';
import saasKit from '@astratra/saas-kit';

const { createSaasApp, createMemorySettingsStore } = saasKit;
const port = Number(process.env.PORT || 4000);
const host = process.env.HOST || '127.0.0.1';
const allowedOrigins = new Set([
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  ...(process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map((origin) => origin.trim()) : [])
]);

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

const saasApp = createSaasApp({
  jwtSecret: process.env.JWT_SECRET || 'dashboard-ui-dev-secret',
  settingsStore: createMemorySettingsStore({
    productName: 'Astratra',
    supportEmail: 'support@example.test',
    onboardingEnabled: true
  }),
  verifyPassword: async (user, password) => user.password === password,
  notify: async () => ({ delivered: true })
});

app.use(saasApp);

const server = app.listen(port, host, () => {
  console.log(`Astratra dashboard dev backend listening on http://${host}:${port}`);
  console.log('Seeded owner: owner@example.test / password');
  console.log('Seeded member: member@example.test / password');
});

server.on('error', (error) => {
  console.error(`Unable to start dev backend on http://${host}:${port}: ${error.message}`);
  process.exit(1);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
