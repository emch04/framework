const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../src/app');

async function login(app, email, password) {
  const response = await request(app)
    .post('/auth/login')
    .send({ email, password });

  return response.body.data.token;
}

test('login emits a JWT for a valid demo user', async () => {
  const app = createApp();

  const response = await request(app)
    .post('/auth/login')
    .send({ email: 'ada.admin@clinic.test', password: 'demo-admin' });

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.message, 'Login successful');
  assert.equal(typeof response.body.data.token, 'string');
  assert.equal(response.body.data.user.role, 'admin');
});

test('protected routes reject requests without a bearer token', async () => {
  const app = createApp();

  const response = await request(app).get('/me');

  assert.equal(response.status, 401);
  assert.equal(response.body.success, false);
});

test('admin route rejects authenticated users with the wrong role', async () => {
  const app = createApp();
  const token = await login(app, 'pat.patient@clinic.test', 'demo-patient');

  const response = await request(app)
    .get('/admin/patients')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(response.status, 403);
  assert.equal(response.body.success, false);
});

test('login limiter blocks after the configured number of attempts', async () => {
  const app = createApp({ loginRateLimit: { max: 2, windowMs: 60 * 1000 } });

  await request(app).post('/auth/login').send({ email: 'unknown@clinic.test', password: 'bad' });
  await request(app).post('/auth/login').send({ email: 'unknown@clinic.test', password: 'bad' });

  const response = await request(app)
    .post('/auth/login')
    .send({ email: 'unknown@clinic.test', password: 'bad' });

  assert.equal(response.status, 429);
  assert.equal(response.body.success, false);
});

test('WAF blocks obvious SQL injection payloads', async () => {
  const app = createApp();

  const response = await request(app)
    .post('/auth/login')
    .send({ email: 'select * from users', password: 'demo-admin' });

  assert.equal(response.status, 403);
  assert.equal(response.body.success, false);
});
