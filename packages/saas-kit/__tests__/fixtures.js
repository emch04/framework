const { verifyPasswordHash } = require('@astratra/security');

/**
 * Test accounts. Their password is only ever kept as a scrypt hash (made with
 * hashPassword('password')) and checked with verifyPasswordHash — the tests
 * follow the same rule as a real app: never a clear-text comparison.
 */
const TEST_PASSWORD = 'password';
const TEST_PASSWORD_HASH = 'scrypt$16384$8$1$7QndRARhiSoDIBW7pFt-Pg$W3S8B5xfG6L11c87XnTVvF-Zsvj1Z21U2H6DMo0Di2YXwh58PfAWijsLe9zMk3NZY2QKICuuHJgBpZV4lI08mA';

function testUser(id, email, role) {
  return { id, email, role, passwordHash: TEST_PASSWORD_HASH };
}

function testUsers() {
  return [testUser('user-owner', 'owner@example.test', 'owner'), testUser('user-member', 'member@example.test', 'member')];
}

const verifyTestPassword = async (user, password) => verifyPasswordHash(password, user.passwordHash);

module.exports = { TEST_PASSWORD, TEST_PASSWORD_HASH, testUser, testUsers, verifyTestPassword };
