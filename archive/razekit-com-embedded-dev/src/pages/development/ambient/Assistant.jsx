import { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui';

// The RazeKit DEV assistant: a small figure in a black coat who appears only
// when a build needs its owner — a decision, a stop, a finished result — and
// says exactly what the build's recorded state says. She has no lines of her
// own: every word comes from the moment passed in, which comes from the API.
// She gathers out of particles, and scatters when she is done.

const ENTER_MS = 560;
const LEAVE_MS = 500;
// Long enough to read: about 70 ms a character, never under nine seconds.
const readingMs = (text) => Math.max(9_000, text.length * 70);

function Figure() {
  return (
    <svg viewBox="0 0 96 96" width="72" height="72" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="dev-coat" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#15171c" />
          <stop offset="1" stopColor="#050608" />
        </linearGradient>
      </defs>
      {/* coat, high collar, platinum trim */}
      <path d="M18 96 C20 72 30 62 48 60 C66 62 76 72 78 96 Z" fill="url(#dev-coat)" stroke="#c9ced8" strokeOpacity="0.35" strokeWidth="1" />
      <path d="M38 62 L48 80 L58 62" fill="none" stroke="#e6e9ef" strokeOpacity="0.55" strokeWidth="1.2" />
      <path d="M34 63 C38 58 42 57 48 57 C54 57 58 58 62 63" fill="#0a0b0e" stroke="#c9ced8" strokeOpacity="0.4" strokeWidth="1" />
      <circle cx="48" cy="84" r="1.3" fill="#e6e9ef" fillOpacity="0.8" />
      <circle cx="48" cy="90" r="1.3" fill="#e6e9ef" fillOpacity="0.8" />
      <path d="M30 76 L36 71" stroke="rgb(56 214 255)" strokeOpacity="0.7" strokeWidth="1" />
      {/* face */}
      <ellipse cx="48" cy="40" rx="13" ry="15" fill="#f1e4da" />
      {/* hair: dark, with one platinum highlight */}
      <path d="M33 42 C31 22 42 16 50 17 C60 18 66 26 64 42 C62 34 58 28 50 27 C44 30 40 34 33 42 Z" fill="#0b0c10" />
      <path d="M33 42 C32 50 33 56 36 58 C35 50 35 46 37 40 Z M64 42 C66 50 64 56 60 58 C61 50 61 46 60 40 Z" fill="#0b0c10" />
      <path d="M44 20 C48 18 54 19 57 22" fill="none" stroke="#dfe3ea" strokeOpacity="0.5" strokeWidth="1" />
      {/* eyes */}
      <ellipse cx="42.5" cy="42" rx="2.1" ry="2.6" fill="#1b1d24" />
      <ellipse cx="53.5" cy="42" rx="2.1" ry="2.6" fill="#1b1d24" />
      <circle cx="43.2" cy="41.1" r="0.7" fill="rgb(150 232 255)" />
      <circle cx="54.2" cy="41.1" r="0.7" fill="rgb(150 232 255)" />
      <path d="M45.5 50 C47 51 49 51 50.5 50" fill="none" stroke="#9b6f64" strokeWidth="0.9" strokeLinecap="round" />
    </svg>
  );
}

/**
 * moment: null, or { key, kind: 'decision'|'error'|'completion', title, message, actions: [{ label, onClick }] }.
 * A new key brings her back; the same key, once dismissed, does not.
 */
export default function Assistant({ moment }) {
  const [shown, setShown] = useState(null);
  const [phase, setPhase] = useState('hidden');
  const dismissed = useRef(new Set());
  const timers = useRef([]);
  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  const particles = useMemo(
    () => Array.from({ length: 28 }, (_, i) => {
      const a = (i / 28) * Math.PI * 2 + Math.random() * 0.4;
      const d = 70 + Math.random() * 70;
      return { dx: `${Math.round(Math.cos(a) * d)}px`, dy: `${Math.round(Math.sin(a) * d)}px`, delay: `${Math.round(Math.random() * 140)}ms` };
    }),
    []
  );

  const clear = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };
  const leave = () => {
    clear();
    setPhase('leaving');
    timers.current.push(setTimeout(() => { setPhase('hidden'); setShown(null); }, reduced ? 200 : LEAVE_MS));
  };

  useEffect(() => {
    if (!moment || dismissed.current.has(moment.key)) {
      if (shown && !moment) leave();
      return;
    }
    if (shown?.key === moment.key) return;
    clear();
    setShown(moment);
    setPhase('entering');
    timers.current.push(setTimeout(() => setPhase('present'), reduced ? 50 : ENTER_MS));
    // A finished build is told, then she goes; a decision or a stop waits
    // for its owner.
    if (moment.kind === 'completion') {
      timers.current.push(setTimeout(() => { dismissed.current.add(moment.key); leave(); }, readingMs(`${moment.title} ${moment.message}`)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moment?.key]);

  useEffect(() => clear, []);

  if (!shown || phase === 'hidden') return null;
  const close = () => {
    dismissed.current.add(shown.key);
    leave();
  };

  return (
    <div className="dev-assistant" data-phase={phase}>
      <div className="relative">
        {particles.map((p, i) => (
          <span key={i} className="dev-particle" style={{ '--dx': p.dx, '--dy': p.dy, '--delay': p.delay }} />
        ))}
        <div className="dev-figure flex items-end gap-3">
          <Figure />
          <div className="dev-glass relative flex-1 rounded-2xl border border-line p-3 shadow-lg" role="status" aria-live="polite">
            <button type="button" onClick={close} className="absolute right-2 top-2 rounded p-1 text-muted hover:text-ink" aria-label="Dismiss">
              <X className="h-3.5 w-3.5" />
            </button>
            <p className="pr-5 text-[13px] font-semibold text-ink">{shown.title}</p>
            <p className="mt-1 text-[13px] leading-snug text-muted">{shown.message}</p>
            {shown.actions?.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {shown.actions.map((a) => (
                  <Button key={a.label} size="sm" variant={a.primary ? 'primary' : 'secondary'} onClick={() => { a.onClick(); if (a.dismiss !== false) close(); }}>
                    {a.label}
                  </Button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
