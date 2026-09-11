import { getCurrentUser } from './api.js';
import { useRoute } from './hooks.js';
import Landing from './pages/Landing.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Admin from './pages/Admin.jsx';
import Staff from './pages/Staff.jsx';
import StaffLogin from './pages/StaffLogin.jsx';
import Logs from './pages/Logs.jsx';

export default function App() {
  const [route, nav] = useRoute();

  // session guard: deep-linking to a gated route without a session bounces home
  const user = getCurrentUser();
  let page = route;
  if (page === '/dashboard' && user?.role !== 'team') page = '/';
  if (page === '/admin' && user?.role !== 'admin') page = '/';
  if (page === '/staff' && user?.role !== 'judge' && user?.role !== 'admin') page = '/';
  if (page === '/logs' && user?.role !== 'judge' && user?.role !== 'admin') page = '/';

  // /#/judge and /#/gm are linked from the landing footer; /#/logs stays a
  // direct link only — it's empty until the event starts producing entries.
  if (page === '/judge') return <StaffLogin kind="judge" nav={nav} />;
  if (page === '/gm') return <StaffLogin kind="admin" nav={nav} />;

  if (page === '/dashboard') return <Dashboard nav={nav} />;
  if (page === '/staff') return <Staff nav={nav} />;
  if (page === '/logs') return <Logs nav={nav} />;
  if (page === '/admin') return <Admin nav={nav} />;
  return <Landing nav={nav} />;
}
