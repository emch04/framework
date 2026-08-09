const jwt = require('jsonwebtoken');
const { createAuthMiddleware, authorizeRoles } = require('../src');

const createRes = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

describe('jwtAuth', () => {
  test('injects decoded user for a valid bearer token', async () => {
    const token = jwt.sign({ id: 'u1', role: 'admin' }, 'secret');
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = createRes();
    const next = jest.fn();

    await createAuthMiddleware({ secret: 'secret' })(req, res, next);

    expect(req.user).toMatchObject({ id: 'u1', role: 'admin' });
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test('returns 401 when token is absent', async () => {
    const res = createRes();
    const next = jest.fn();

    await createAuthMiddleware({ secret: 'secret' })({ headers: {} }, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('returns 401 for expired tokens', async () => {
    const token = jwt.sign({ id: 'u1' }, 'secret', { expiresIn: -1 });
    const res = createRes();
    const next = jest.fn();

    await createAuthMiddleware({ secret: 'secret' })({ headers: { authorization: `Bearer ${token}` } }, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('returns 401 for invalid signatures', async () => {
    const token = jwt.sign({ id: 'u1' }, 'other-secret');
    const res = createRes();
    const next = jest.fn();

    await createAuthMiddleware({ secret: 'secret' })({ cookies: { token } }, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('rejects tokens signed with algorithms outside the configured allowlist', async () => {
    const token = jwt.sign({ id: 'u1' }, 'secret', { algorithm: 'HS512' });
    const res = createRes();
    const next = jest.fn();

    await createAuthMiddleware({ secret: 'secret', algorithms: ['HS256'] })(
      { headers: { authorization: `Bearer ${token}` } },
      res,
      next
    );

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('verifies issuer and audience when configured', async () => {
    const token = jwt.sign({ id: 'u1' }, 'secret', {
      algorithm: 'HS256',
      issuer: 'other-app',
      audience: 'my-api'
    });
    const res = createRes();
    const next = jest.fn();

    await createAuthMiddleware({
      secret: 'secret',
      algorithms: ['HS256'],
      issuer: 'my-app',
      audience: 'my-api'
    })({ headers: { authorization: `Bearer ${token}` } }, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('accepts legacy secret when primary signature fails', async () => {
    const token = jwt.sign({ id: 'u1', role: 'member' }, 'old-secret');
    const req = { cookies: { token }, headers: {} };
    const next = jest.fn();

    await createAuthMiddleware({ secret: 'new-secret', legacySecret: 'old-secret' })(req, createRes(), next);

    expect(req.user).toMatchObject({ id: 'u1', role: 'member' });
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('calls verifySession when provided and rejects revoked sessions', async () => {
    const token = jwt.sign({ id: 'u1', tokenVersion: 2 }, 'secret');
    const verifySession = jest.fn().mockResolvedValue(false);
    const res = createRes();
    const next = jest.fn();

    await createAuthMiddleware({ secret: 'secret', verifySession })(
      { headers: { authorization: `Bearer ${token}` } },
      res,
      next
    );

    expect(verifySession).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1', tokenVersion: 2 }));
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('uses revocationStore to reject a revoked token id', async () => {
    const token = jwt.sign({ id: 'u1', jti: 'revoked-token' }, 'secret', { expiresIn: '1h' });
    const revocationStore = {
      isRevoked: jest.fn().mockResolvedValue(true)
    };
    const res = createRes();
    const next = jest.fn();

    await createAuthMiddleware({ secret: 'secret', revocationStore })(
      { headers: { authorization: `Bearer ${token}` } },
      res,
      next
    );

    expect(revocationStore.isRevoked).toHaveBeenCalledWith('revoked-token');
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('uses revocationStore to reject tokens issued before user logout-all', async () => {
    const issuedAt = Math.floor(Date.now() / 1000);
    const token = jwt.sign({ id: 'u1', jti: 'active-token', iat: issuedAt }, 'secret', { expiresIn: '1h' });
    const revocationStore = {
      isRevoked: jest.fn().mockResolvedValue(false),
      isRevokedForUser: jest.fn().mockResolvedValue(true)
    };
    const res = createRes();
    const next = jest.fn();

    await createAuthMiddleware({ secret: 'secret', revocationStore })(
      { headers: { authorization: `Bearer ${token}` } },
      res,
      next
    );

    expect(revocationStore.isRevoked).toHaveBeenCalledWith('active-token');
    expect(revocationStore.isRevokedForUser).toHaveBeenCalledWith('u1', issuedAt);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('keeps explicit verifySession in control when revocationStore is also provided', async () => {
    const token = jwt.sign({ id: 'u1', jti: 'revoked-token' }, 'secret', { expiresIn: '1h' });
    const revocationStore = {
      isRevoked: jest.fn().mockResolvedValue(true)
    };
    const verifySession = jest.fn().mockResolvedValue(true);
    const req = { headers: { authorization: `Bearer ${token}` } };
    const next = jest.fn();

    await createAuthMiddleware({ secret: 'secret', revocationStore, verifySession })(req, createRes(), next);

    expect(verifySession).toHaveBeenCalledWith(expect.objectContaining({ jti: 'revoked-token' }));
    expect(revocationStore.isRevoked).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('does not verify sessions when callback is absent', async () => {
    const token = jwt.sign({ id: 'u1', tokenVersion: 2 }, 'secret');
    const req = { headers: { authorization: `Bearer ${token}` } };
    const next = jest.fn();

    await createAuthMiddleware({ secret: 'secret' })(req, createRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  test('authorizeRoles allows configured roles and rejects others', () => {
    const allowedNext = jest.fn();
    authorizeRoles('owner', 'editor')({ user: { role: 'owner' } }, createRes(), allowedNext);
    expect(allowedNext).toHaveBeenCalledTimes(1);

    const deniedRes = createRes();
    authorizeRoles('owner')({ user: { role: 'viewer' } }, deniedRes, jest.fn());
    expect(deniedRes.status).toHaveBeenCalledWith(403);
  });
});
