import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useSession } from "./lib/session";
import Layout from "./components/Layout";
import Logo from "./components/Logo";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Patients from "./pages/Patients";
import PatientDetail from "./pages/PatientDetail";
import Assistant from "./pages/Assistant";
import Alerts from "./pages/Alerts";
import Knowledge from "./pages/Knowledge";
import Model from "./pages/Model";
import PortalApp from "./portal/PortalApp";
import PolicyApp from "./policy/PolicyApp";

export default function App() {
  const { user, ready } = useSession();
  const loc = useLocation();
  if (!ready) {
    return (
      <div className="h-full grid place-items-center">
        <div className="flex flex-col items-center gap-3 text-sm text-muted"><Logo size={44} /><span className="shimmer">Loading SickleGuard…</span></div>
      </div>
    );
  }
  // Each role gets its own interface: patients the portal, policy makers the population dashboard.
  if (user?.role === "patient") return <Routes><Route path="/portal/*" element={<PortalApp />} /><Route path="*" element={<Navigate to="/portal" replace />} /></Routes>;
  if (user?.role === "policy") return <Routes><Route path="/policy/*" element={<PolicyApp />} /><Route path="*" element={<Navigate to="/policy" replace />} /></Routes>;
  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login />} />
      <Route path="/policy/*" element={user?.role === "admin" ? <PolicyApp /> : <Navigate to="/" replace />} />
      <Route element={user ? <Layout /> : <Navigate to="/login" replace state={{ from: loc.pathname }} />}>
        <Route index element={<Dashboard />} />
        <Route path="patients" element={<Patients />} />
        <Route path="patients/:id" element={<PatientDetail />} />
        <Route path="assistant" element={<Assistant />} />
        <Route path="alerts" element={<Alerts />} />
        <Route path="knowledge" element={<Knowledge />} />
        <Route path="model" element={<Model />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
