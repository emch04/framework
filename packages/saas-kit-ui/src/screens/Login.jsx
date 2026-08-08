import { useState } from 'react';
import { useAuth } from '../auth/AuthContext.jsx';
import Notice from '../components/Notice.jsx';
import styles from './Login.module.css';

export default function Login({ onLoggedIn }) {
  const { login } = useAuth();
  const [email, setEmail] = useState('owner@example.test');
  const [password, setPassword] = useState('password');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login({ email, password });
      onLoggedIn();
    } catch (apiError) {
      setError(apiError.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className={styles.page}>
      <section className={styles.panel} aria-labelledby="login-title">
        <div className={styles.frame} aria-hidden="true" />
        <div className={styles.identity}>
          <span className={styles.tag}>astratra/saas-kit</span>
          <span className={styles.tagMuted}>v0.1.0</span>
        </div>
        <h1 id="login-title">
          <span className={styles.prompt}>&gt;</span> sign_in
          <span className={styles.cursor} aria-hidden="true" />
        </h1>
        <p className={styles.copy}>
          // authenticate with the seeded owner account to inspect the generic SaaS API screens
        </p>
        <Notice tone="error">{error}</Notice>
        <form className={styles.form} onSubmit={handleSubmit}>
          <label>
            email
            <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" required />
          </label>
          <label>
            password
            <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" required />
          </label>
          <button type="submit" disabled={loading}>{loading ? 'authenticating...' : '[ sign in ]'}</button>
        </form>
      </section>
    </main>
  );
}
