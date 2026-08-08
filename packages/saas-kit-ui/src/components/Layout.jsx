import { useAuth } from '../auth/AuthContext.jsx';
import logoUrl from '../assets/logo.svg';
import styles from './Layout.module.css';

const NAV_ITEMS = [
  { id: 'dashboard', index: '01', label: 'Dashboard' },
  { id: 'users', index: '02', label: 'Users' },
  { id: 'settings', index: '03', label: 'Settings' }
];

export default function Layout({ activeView, children, onNavigate }) {
  const { logout, user } = useAuth();

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <img src={logoUrl} alt="Astratra" className={styles.brandMark} />
          <span>
            <strong>Astratra</strong>
            <small>saas_starter@v0.1.0</small>
          </span>
        </div>

        <nav className={styles.nav} aria-label="Primary">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={item.id === activeView ? styles.activeNavItem : styles.navItem}
              onClick={() => onNavigate(item.id)}
            >
              <span className={styles.navIndex}>{item.index}</span>
              {item.label}
            </button>
          ))}
        </nav>

        <div className={styles.status}>
          <span className={styles.statusDot} aria-hidden="true" />
          session active
        </div>

        <div className={styles.account}>
          <span>{user?.email}</span>
          <small>role: {user?.role}</small>
          <button type="button" onClick={logout}>[ logout ]</button>
        </div>
      </aside>
      <main className={styles.content}>{children}</main>
    </div>
  );
}
