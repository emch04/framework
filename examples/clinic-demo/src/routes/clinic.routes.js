const express = require('express');
const { apiResponse } = require('@astratra/core');
const { authorizeRoles } = require('@astratra/security');
const { demoUsers, toPublicUser } = require('../demoUsers');

const appointments = [
  {
    id: 'apt_001',
    patientId: 'usr_patient_1',
    doctorId: 'usr_doctor_1',
    startsAt: '2026-08-10T09:00:00.000Z',
    reason: 'Annual checkup'
  }
];

function createClinicRoutes(authMiddleware) {
  const router = express.Router();

  router.use(authMiddleware);

  router.get('/me', (req, res) => {
    return apiResponse(res, 200, 'Current user', { user: req.user });
  });

  router.get('/appointments', authorizeRoles('doctor', 'admin'), (req, res) => {
    return apiResponse(res, 200, 'Appointments', { appointments });
  });

  router.get('/admin/patients', authorizeRoles('admin'), (req, res) => {
    const patients = demoUsers
      .filter((user) => user.role === 'patient')
      .map(toPublicUser);

    return apiResponse(res, 200, 'Patients', { patients });
  });

  return router;
}

module.exports = createClinicRoutes;
