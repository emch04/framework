const DEFAULT_USERS = [
  {
    id: 'user-owner',
    email: 'owner@example.test',
    role: 'owner',
    password: 'password'
  },
  {
    id: 'user-member',
    email: 'member@example.test',
    role: 'member',
    password: 'password'
  }
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createMemoryUsersStore(options = {}) {
  // Dev-only adapter: keeps data in process memory and loses it on restart.
  const users = new Map();
  const seedUsers = options.users || DEFAULT_USERS;
  let nextId = seedUsers.length + 1;

  for (const user of seedUsers) {
    users.set(String(user.id), clone(user));
  }

  return {
    async findByEmail(email) {
      const normalized = String(email || '').toLowerCase();
      const user = [...users.values()].find((item) => String(item.email || '').toLowerCase() === normalized);
      return user ? clone(user) : null;
    },

    async findById(id) {
      const user = users.get(String(id));
      return user ? clone(user) : null;
    },

    async create(userData) {
      const id = userData.id || `user-${nextId++}`;
      const user = { ...clone(userData), id };
      users.set(String(id), user);
      return clone(user);
    },

    async list({ role, limit = 50, offset = 0 } = {}) {
      let items = [...users.values()];
      if (role) {
        items = items.filter((user) => user.role === role);
      }

      const safeOffset = Math.max(Number(offset) || 0, 0);
      const safeLimit = Math.max(Number(limit) || 50, 0);
      return clone(items.slice(safeOffset, safeOffset + safeLimit));
    },

    async update(id, patch) {
      const key = String(id);
      const current = users.get(key);
      if (!current) return null;

      const updated = { ...current, ...clone(patch), id: current.id };
      users.set(key, updated);
      return clone(updated);
    },

    async count({ role } = {}) {
      let items = [...users.values()];
      if (role) {
        items = items.filter((user) => user.role === role);
      }
      return items.length;
    },

    async countByRole() {
      return [...users.values()].reduce((counts, user) => {
        const role = user.role || 'unknown';
        counts[role] = (counts[role] || 0) + 1;
        return counts;
      }, {});
    }
  };
}

module.exports = createMemoryUsersStore;
