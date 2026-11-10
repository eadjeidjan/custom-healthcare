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
  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login />} />
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
