import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext.jsx';
import Notice from '../components/Notice.jsx';
import styles from './Screen.module.css';

export default function Users() {
  const { request } = useAuth();
  const [users, setUsers] = useState([]);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [form, setForm] = useState({ email: '', role: 'member', password: 'password' });
  const [loading, setLoading] = useState(true);

  async function loadUsers() {
    setLoading(true);
    setError('');
    try {
      const data = await request('/users?limit=50&offset=0');
      setUsers(data.items || []);
    } catch (apiError) {
      setError(apiError.status === 403 ? 'Not authorized to manage users.' : apiError.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadUsers();
  }, []);

  async function createUser(event) {
    event.preventDefault();
    setError('');
    setSuccess('');
    try {
      await request('/users', { method: 'POST', body: form });
      setForm({ email: '', role: 'member', password: 'password' });
      setSuccess('User created.');
      await loadUsers();
    } catch (apiError) {
      setError(apiError.status === 403 ? 'Not authorized to create users.' : apiError.message);
    }
  }

  return (
    <section className={styles.screen}>
      <header className={styles.header}>
        <p>Administration</p>
        <h1>Users</h1>
      </header>
      <Notice tone="error">{error}</Notice>
      <Notice tone="success">{success}</Notice>
      <form className={styles.inlineForm} onSubmit={createUser}>
        <input
          aria-label="Email"
          placeholder="email@example.test"
          type="email"
          value={form.email}
          onChange={(event) => setForm({ ...form, email: event.target.value })}
          required
        />
        <select
          aria-label="Role"
          value={form.role}
          onChange={(event) => setForm({ ...form, role: event.target.value })}
        >
          <option value="member">member</option>
          <option value="admin">admin</option>
          <option value="owner">owner</option>
        </select>
        <input
          aria-label="Password"
          value={form.password}
          onChange={(event) => setForm({ ...form, password: event.target.value })}
          required
        />
        <button type="submit">Create user</button>
      </form>
      {loading ? <p className={styles.muted}>Loading users...</p> : null}
      <div className={styles.tableWrap}>
        <table>
          <thead>
            <tr>
              <th>Email</th>
              <th>Role</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>{user.email}</td>
                <td>{user.role || 'unknown'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
