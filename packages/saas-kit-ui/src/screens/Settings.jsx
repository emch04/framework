import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext.jsx';
import Notice from '../components/Notice.jsx';
import styles from './Screen.module.css';

export default function Settings() {
  const { request } = useAuth();
  const [settings, setSettings] = useState({});
  const [drafts, setDrafts] = useState({});
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  async function loadSettings() {
    setError('');
    try {
      const data = await request('/settings');
      setSettings(data || {});
      setDrafts(Object.fromEntries(Object.entries(data || {}).map(([key, value]) => [key, JSON.stringify(value)])));
    } catch (apiError) {
      setError(apiError.status === 403 ? 'Not authorized to manage settings.' : apiError.message);
    }
  }

  useEffect(() => {
    loadSettings();
  }, []);

  async function saveSetting(key) {
    setError('');
    setSuccess('');
    let value = drafts[key];
    try {
      value = JSON.parse(drafts[key]);
    } catch {
      value = drafts[key];
    }

    try {
      const updated = await request(`/settings/${encodeURIComponent(key)}`, {
        method: 'PATCH',
        body: { value }
      });
      setSettings({ ...settings, [updated.key]: updated.value });
      setDrafts({ ...drafts, [updated.key]: JSON.stringify(updated.value) });
      setSuccess(`${updated.key} saved.`);
    } catch (apiError) {
      setError(apiError.status === 403 ? 'Not authorized to update settings.' : apiError.message);
    }
  }

  const rows = Object.entries(settings);

  return (
    <section className={styles.screen}>
      <header className={styles.header}>
        <p>Configuration</p>
        <h1>Settings</h1>
      </header>
      <Notice tone="error">{error}</Notice>
      <Notice tone="success">{success}</Notice>
      {rows.length === 0 && !error ? <p className={styles.muted}>No settings yet.</p> : null}
      <div className={styles.settingsList}>
        {rows.map(([key]) => (
          <div className={styles.settingRow} key={key}>
            <label>
              <span>{key}</span>
              <input
                value={drafts[key] ?? ''}
                onChange={(event) => setDrafts({ ...drafts, [key]: event.target.value })}
              />
            </label>
            <button type="button" onClick={() => saveSetting(key)}>Save</button>
          </div>
        ))}
      </div>
    </section>
  );
}
