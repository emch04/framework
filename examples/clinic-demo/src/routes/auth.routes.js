const express = require('express');
const jwt = require('jsonwebtoken');
const { apiResponse } = require('@astratra/core');
const { demoUsers, toPublicUser } = require('../demoUsers');

function buildAuthRoutes(options = {}) {
  const router = express.Router();
  const jwtSecret = options.jwtSecret || 'clinic-demo-secret';
  const expiresIn = options.expiresIn || '1h';

  // public
  router.post('/login', (req, res) => {
    const { email, password } = req.body || {};
    const user = demoUsers.find((candidate) => candidate.email === email && candidate.password === password);

    if (!user) {
      return apiResponse(res, 401, 'Invalid credentials', null, false);
    }

    const publicUser = toPublicUser(user);
    const token = jwt.sign(publicUser, jwtSecret, { expiresIn });

    return apiResponse(res, 200, 'Login successful', {
      token,
      user: publicUser
    });
  });

  return router;
}

module.exports = buildAuthRoutes;
