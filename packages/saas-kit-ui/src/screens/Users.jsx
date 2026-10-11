import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext.jsx';
import Notice from '../components/Notice.jsx';
import styles from './Screen.module.css';
import { assignableRoles } from '../lib/access.js';

export default function Users() {
  const { request, user } = useAuth();
  const roles = assignableRoles(user);
  const [users, setUsers] = useState([]);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [form, setForm] = useState({ email: '', role: 'member' });
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(true);

  async function loadUsers() {
    setLoading(true);
    setError('');
    try {
      const data = await request('/users?limit=50&offset=0');
      setUsers(data.items || []);
      setAuthorized(true);
    } catch (apiError) {
      if (apiError.status === 403) {
        setAuthorized(false);
        setError('Vous n etes pas autorise a gerer les utilisateurs.');
      } else {
        setError(apiError.message);
      }
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
      setForm({ email: '', role: 'member' });
      setSuccess('Utilisateur cree.');
      await loadUsers();
    } catch (apiError) {
      setError(apiError.status === 403 ? 'Vous n etes pas autorise a creer des utilisateurs.' : apiError.message);
    }
  }

  return (
    <section className={styles.screen}>
      <header className={styles.header}>
        <p>Administration</p>
        <h1>Utilisateurs</h1>
      </header>
      <Notice tone="error">{error}</Notice>
      <Notice tone="success">{success}</Notice>
      {authorized ? (
        <>
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
              {/* Admin roles are offered to owners only (the server refuses them to an admin anyway). */}
              {roles.map((role) => <option key={role} value={role}>{role}</option>)}
            </select>
            <button type="submit">Creer un utilisateur</button>
          </form>
          {loading ? <p className={styles.muted}>Chargement des utilisateurs...</p> : null}
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
                    <td>{user.role || 'inconnu'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}
