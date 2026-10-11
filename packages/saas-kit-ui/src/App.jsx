import { useState } from 'react';
import { AuthProvider, useAuth } from './auth/AuthContext.jsx';
import Layout from './components/Layout.jsx';
import Dashboard from './screens/Dashboard.jsx';
import Login from './screens/Login.jsx';
import Settings from './screens/Settings.jsx';
import Users from './screens/Users.jsx';
import { canSeeView, visibleViews } from './lib/access.js';
import './styles/global.css';

const VIEWS = {
  dashboard: Dashboard,
  users: Users,
  settings: Settings
};

function GuardedApp({ adminRoles }) {
  const [view, setView] = useState('dashboard');
  const auth = useAuth();

  if (!auth.isAuthenticated) {
    return <Login onLoggedIn={() => setView('dashboard')} />;
  }

  /* A screen the person's role does not allow is never rendered, even if asked for. */
  const shown = canSeeView(view, auth.user, { adminRoles }) ? view : 'dashboard';
  const Screen = VIEWS[shown] || Dashboard;
  return (
    <Layout activeView={shown} onNavigate={setView} views={visibleViews(auth.user, { adminRoles })}>
      <Screen />
    </Layout>
  );
}

export default function AstratraDashboardApp({ adminRoles } = {}) {
  return (
    <AuthProvider>
      <GuardedApp adminRoles={adminRoles} />
    </AuthProvider>
  );
}
