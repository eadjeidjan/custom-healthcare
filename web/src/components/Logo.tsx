// SickleGuard mark: a blood droplet with a pulse line.
import { useId } from "react";

export default function Logo({ size = 32 }: { size?: number }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="shrink-0 drop-shadow-[0_4px_14px_rgba(244,63,94,0.45)]">
      <defs>
        <linearGradient id={`lg${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fb7185" />
          <stop offset="1" stopColor="#be123c" />
        </linearGradient>
      </defs>
      <path d="M16 2.5c5.5 7 10 12.2 10 17.3A10 10 0 0 1 6 19.8C6 14.7 10.5 9.5 16 2.5Z" fill={`url(#lg${id})`} />
      <path d="M11 11.5c1.2-1.7 2.4-3.2 3.4-4.5" stroke="rgba(255,255,255,.45)" strokeWidth="1.4" strokeLinecap="round" fill="none" />
      <path d="M8.5 20h4l1.8-3.6 2.6 6.4 2-4.3h4.6" fill="none" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Wordmark({ size = 30 }: { size?: number }) {
  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <Logo size={size} />
      <div className="min-w-0 leading-tight">
        <div className="font-semibold tracking-tight truncate">Sickle<span className="grad-text">Guard</span></div>
        <div className="text-[9.5px] uppercase tracking-[0.22em] text-faint">VOC early warning</div>
      </div>
    </div>
  );
}
