import { useState } from 'react';
import { AuthProvider, useAuth } from './auth/AuthContext.jsx';
import Layout from './components/Layout.jsx';
import Dashboard from './screens/Dashboard.jsx';
import Login from './screens/Login.jsx';
import Settings from './screens/Settings.jsx';
import Users from './screens/Users.jsx';
import './styles/global.css';

const VIEWS = {
  dashboard: Dashboard,
  users: Users,
  settings: Settings
};

function GuardedApp() {
  const [view, setView] = useState('dashboard');
  const auth = useAuth();

  if (!auth.isAuthenticated) {
    return <Login onLoggedIn={() => setView('dashboard')} />;
  }

  const Screen = VIEWS[view] || Dashboard;
  return (
    <Layout activeView={view} onNavigate={setView}>
      <Screen />
    </Layout>
  );
}

export default function AstratraDashboardApp() {
  return (
    <AuthProvider>
      <GuardedApp />
    </AuthProvider>
  );
}
