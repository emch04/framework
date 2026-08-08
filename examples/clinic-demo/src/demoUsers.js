const demoUsers = [
  {
    id: 'usr_admin_1',
    name: 'Ada Admin',
    email: 'ada.admin@clinic.test',
    password: 'demo-admin',
    role: 'admin'
  },
  {
    id: 'usr_doctor_1',
    name: 'Denis Doctor',
    email: 'denis.doctor@clinic.test',
    password: 'demo-doctor',
    role: 'doctor'
  },
  {
    id: 'usr_patient_1',
    name: 'Pat Patient',
    email: 'pat.patient@clinic.test',
    password: 'demo-patient',
    role: 'patient'
  }
];

function toPublicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role
  };
}

module.exports = {
  demoUsers,
  toPublicUser
};
