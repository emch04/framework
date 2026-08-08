const express = require('express');
const { apiResponse, asyncHandler } = require('@astratra/core');

function createDashboardRoutes({ usersStore }) {
  const router = express.Router();

  router.get('/summary', asyncHandler(async (req, res) => {
    const users = await usersStore.list({ limit: Number.MAX_SAFE_INTEGER, offset: 0 });
    const roleBreakdown = users.reduce((counts, user) => {
      const role = user.role || 'unknown';
      counts[role] = (counts[role] || 0) + 1;
      return counts;
    }, {});

    return apiResponse(res, 200, 'Dashboard summary', {
      userCount: users.length,
      roleBreakdown
    });
  }));

  return router;
}

module.exports = createDashboardRoutes;
