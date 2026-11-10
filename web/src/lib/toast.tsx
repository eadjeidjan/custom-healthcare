// Tiny toast system: toast.error("…"), toast.ok("…").
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, X } from "lucide-react";

type Kind = "ok" | "error";
interface T { id: number; kind: Kind; text: string }
interface ToastApi { ok: (t: string) => void; error: (t: string) => void }

const Ctx = createContext<ToastApi>({ ok: () => {}, error: () => {} });
let seq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<T[]>([]);
  const remove = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const push = useCallback((kind: Kind, text: string) => {
    const id = ++seq;
    setItems((xs) => [...xs.slice(-3), { id, kind, text }]);
    setTimeout(() => remove(id), kind === "error" ? 6000 : 3500);
  }, [remove]);
  const api: ToastApi = { ok: (t) => push("ok", t), error: (t) => push("error", t) };
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="fixed z-[60] bottom-4 right-4 left-4 sm:left-auto sm:w-96 flex flex-col gap-2 pointer-events-none">
        {items.map((t) => (
          <div key={t.id} role="status"
            className="pointer-events-auto fade-in flex items-start gap-3 rounded-xl border border-line bg-solid/95 backdrop-blur px-4 py-3 shadow-2xl text-sm">
            {t.kind === "ok"
              ? <CheckCircle2 className="size-4 mt-0.5 text-ok shrink-0" />
              : <AlertTriangle className="size-4 mt-0.5 text-bad shrink-0" />}
            <div className="flex-1 min-w-0 break-words">{t.text}</div>
            <button onClick={() => remove(t.id)} className="text-faint hover:text-fg cursor-pointer" aria-label="Dismiss"><X className="size-4" /></button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
