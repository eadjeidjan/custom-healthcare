// Signed-in user, shared by every page. JWT lives in localStorage.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { User } from "../types";
import { api, getToken, setToken } from "./api";

interface SessionValue {
  user: User | null;
  ready: boolean;
  isAdmin: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => void;
}

const Ctx = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!getToken()) { setReady(true); return; }
    api.me()
      .then(setUser)
      .catch(() => setToken(null))
      .finally(() => setReady(true));
  }, []);

  const value: SessionValue = {
    user, ready, isAdmin: user?.role === "admin",
    signIn: async (email, password) => {
      const r = await api.login(email, password);
      setToken(r.token);
      setUser(r.user);
    },
    signOut: () => { setToken(null); setUser(null); location.assign("/login"); },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSession outside SessionProvider");
  return v;
}
