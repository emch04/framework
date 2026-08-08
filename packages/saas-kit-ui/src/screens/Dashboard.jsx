import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext.jsx';
import Notice from '../components/Notice.jsx';
import styles from './Screen.module.css';

export default function Dashboard() {
  const { request } = useAuth();
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    request('/dashboard/summary')
      .then((data) => {
        if (active) setSummary(data);
      })
      .catch((apiError) => {
        if (active) setError(apiError.message);
      });
    return () => {
      active = false;
    };
  }, [request]);

  const roles = Object.entries(summary?.roleBreakdown || {});
  const maxRoleCount = Math.max(1, ...roles.map(([, count]) => count));

  return (
    <section className={styles.screen}>
      <header className={styles.header}>
        <p>Overview</p>
        <h1>Dashboard</h1>
      </header>
      <Notice tone="error">{error}</Notice>
      {!summary && !error ? <p className={styles.muted}>Loading dashboard...</p> : null}
      {summary ? (
        <div className={styles.grid}>
          <article className={styles.statCard}>
            <span>Total users</span>
            <strong>{summary.userCount}</strong>
          </article>
          <article className={styles.wideCard}>
            <span>Role breakdown</span>
            <div className={styles.bars}>
              {roles.map(([role, count]) => (
                <div key={role} className={styles.barRow}>
                  <span>{role}</span>
                  <div className={styles.track}>
                    <div style={{ width: `${(count / maxRoleCount) * 100}%` }} />
                  </div>
                  <strong>{count}</strong>
                </div>
              ))}
            </div>
          </article>
        </div>
      ) : null}
    </section>
  );
}
