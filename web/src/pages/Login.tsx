import { useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Activity, BrainCircuit, LogIn, ShieldCheck } from "lucide-react";
import { useSession } from "../lib/session";
import { Button, ErrorNote, Field, Input } from "../components/ui";
import Logo from "../components/Logo";
import { DISCLAIMER } from "../components/Layout";

export default function Login() {
  const { signIn } = useSession();
  const nav = useNavigate();
  const loc = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await signIn(email.trim(), password);
      const from = (loc.state as { from?: string } | null)?.from;
      nav(from && from !== "/login" ? from : "/", { replace: true });
    } catch (ex) {
      setErr((ex as Error).message || "Sign-in failed");
    } finally { setBusy(false); }
  }

  return (
    <div className="relative min-h-full flex items-center justify-center p-4">
      <div className="backdrop" />
      <div className="relative z-10 w-full max-w-5xl grid lg:grid-cols-[1.1fr_1fr] gap-8 items-center">
        <div className="hidden lg:block px-4">
          <div className="flex items-center gap-3 mb-8">
            <Logo size={48} />
            <div>
              <div className="text-3xl font-semibold tracking-tight">Sickle<span className="grad-text">Guard</span></div>
              <div className="text-xs uppercase tracking-[0.25em] text-faint mt-0.5">VOC early warning</div>
            </div>
          </div>
          <h1 className="text-4xl font-semibold tracking-tight leading-tight">
            See a pain crisis coming <span className="text-teal">days</span> before it arrives.
          </h1>
          <p className="text-muted mt-4 leading-relaxed max-w-md">
            Daily check-ins, a calibrated 7-day vaso-occlusive crisis risk model, and an AI care assistant grounded in
            sickle cell guidelines — for the whole care team.
          </p>
          <div className="mt-8 grid gap-3 max-w-md">
            {[
              { icon: Activity, t: "7-day VOC risk", d: "Score 0–100 with the reasons behind it" },
              { icon: BrainCircuit, t: "AI prevention plan", d: "Grounded in guideline passages you can read" },
              { icon: ShieldCheck, t: "Red flags first", d: "Emergency signs always override the model" },
            ].map(({ icon: I, t, d }) => (
              <div key={t} className="flex items-center gap-3 glass rounded-xl px-4 py-3">
                <I className="size-5 text-teal shrink-0" />
                <div><div className="text-sm font-medium">{t}</div><div className="text-xs text-faint">{d}</div></div>
              </div>
            ))}
          </div>
        </div>

        <form onSubmit={submit} className="glass glow rounded-2xl p-6 sm:p-8 w-full max-w-md mx-auto fade-in">
          <div className="lg:hidden flex items-center gap-3 mb-6">
            <Logo size={40} />
            <div>
              <div className="text-xl font-semibold tracking-tight">Sickle<span className="grad-text">Guard</span></div>
              <div className="text-[10px] uppercase tracking-[0.25em] text-faint">VOC early warning</div>
            </div>
          </div>
          <h2 className="text-xl font-semibold">Sign in</h2>
          <p className="text-sm text-muted mt-1 mb-6">Care team access</p>
          <div className="space-y-4">
            <Field label="Email">
              <Input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@clinic.org" autoFocus />
            </Field>
            <Field label="Password">
              <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
            </Field>
            <ErrorNote>{err}</ErrorNote>
            <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
              {!busy && <LogIn className="size-4" />}Sign in
            </Button>
          </div>
          <p className="text-[11px] text-faint mt-6 leading-relaxed border-t border-line pt-4">{DISCLAIMER}</p>
        </form>
      </div>
    </div>
  );
}
