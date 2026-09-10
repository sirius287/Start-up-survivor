import { getCurrentUser } from './api.js';
import { useRoute } from './hooks.js';
import Landing from './pages/Landing.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Admin from './pages/Admin.jsx';

export default function App() {
  const [route, nav] = useRoute();

  // session guard: deep-linking to a gated route without a session bounces home
  const user = getCurrentUser();
  let page = route;
  if (page === '/dashboard' && user?.role !== 'team') page = '/';
  if (page === '/admin' && user?.role !== 'judge') page = '/';

  if (page === '/dashboard') return <Dashboard nav={nav} />;
  if (page === '/admin') return <Admin nav={nav} />;
  return <Landing nav={nav} />;
}
