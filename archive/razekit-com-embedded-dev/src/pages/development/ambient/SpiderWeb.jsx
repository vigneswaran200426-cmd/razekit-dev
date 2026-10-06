import { useEffect, useRef } from 'react';

// The RazeKit DEV mark: one small spider on one web. Ambient, not telemetry —
// it never claims to be doing the work. It moves a little faster while a
// build is running, flinches when something needs attention, and holds still
// for anyone who asked the system for less motion. Frames are applied to the
// SVG directly (no React re-render), and it pauses when the tab is hidden.

const RINGS = [10, 19, 28];
const SPOKES = 8;
const C = 32;
const node = (ring, spoke) => {
  const a = (Math.PI * 2 * spoke) / SPOKES - Math.PI / 2;
  return [C + RINGS[ring] * Math.cos(a), C + RINGS[ring] * Math.sin(a)];
};

export default function SpiderWeb({ activity = 'idle', size = 64 }) {
  const spider = useRef(null);
  const state = useRef({ ring: 1, spoke: 0, x: C, y: C - RINGS[1], tx: 0, ty: 0, wait: 0 });
  const activityRef = useRef(activity);
  activityRef.current = activity;

  useEffect(() => {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const s = state.current;
    const place = () => spider.current?.setAttribute('transform', `translate(${s.x.toFixed(2)} ${s.y.toFixed(2)})`);
    place();
    if (reduced) return undefined;
    let raf = 0;
    let last = performance.now();
    const pick = () => {
      // Step to a neighbouring node: along the ring or along the spoke.
      if (Math.random() < 0.5) s.spoke = (s.spoke + (Math.random() < 0.5 ? 1 : SPOKES - 1)) % SPOKES;
      else s.ring = Math.max(0, Math.min(RINGS.length - 1, s.ring + (Math.random() < 0.5 ? 1 : -1)));
      [s.tx, s.ty] = node(s.ring, s.spoke);
    };
    [s.tx, s.ty] = node(s.ring, s.spoke);
    const frame = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const mode = activityRef.current;
      const speed = mode === 'active' ? 14 : mode === 'alert' ? 22 : 6;
      if (s.wait > 0) s.wait -= dt;
      else {
        const dx = s.tx - s.x;
        const dy = s.ty - s.y;
        const d = Math.hypot(dx, dy);
        if (d < 0.3) {
          s.wait = mode === 'active' ? 0.4 + Math.random() : 1.2 + Math.random() * 2.5; // pause, inspect
          pick();
        } else {
          const step = Math.min(d, speed * dt);
          s.x += (dx / d) * step;
          s.y += (dy / d) * step;
        }
      }
      place();
      raf = requestAnimationFrame(frame);
    };
    const onVisibility = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    };
    raf = requestAnimationFrame(frame);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false" className="shrink-0">
      <g stroke="rgb(236 239 244)" strokeOpacity="0.22" strokeWidth="0.6" fill="none">
        {Array.from({ length: SPOKES }, (_, i) => {
          const [x, y] = node(RINGS.length - 1, i);
          return <line key={i} x1={C} y1={C} x2={x} y2={y} />;
        })}
        {RINGS.map((r, ri) => (
          <polygon key={r} points={Array.from({ length: SPOKES }, (_, i) => node(ri, i).join(',')).join(' ')} />
        ))}
      </g>
      <circle cx={C} cy={C} r="1" fill="rgb(56 214 255)" fillOpacity="0.8" />
      <g ref={spider}>
        <g stroke="rgb(236 239 244)" strokeWidth="0.7" strokeLinecap="round">
          {[-1, 1].flatMap((side) => [
            <path key={`a${side}`} d={`M0 0 L${side * 3.2} -2.2 L${side * 4.6} -0.6`} fill="none" />,
            <path key={`b${side}`} d={`M0 0 L${side * 3.6} -0.4 L${side * 5} 1.4`} fill="none" />,
            <path key={`c${side}`} d={`M0 0 L${side * 3.4} 1.2 L${side * 4.4} 3.2`} fill="none" />,
            <path key={`d${side}`} d={`M0 0 L${side * 2.8} 2.2 L${side * 3.2} 4.4`} fill="none" />,
          ])}
        </g>
        <ellipse cx="0" cy="1.4" rx="1.9" ry="2.4" fill="rgb(5 6 8)" stroke="rgb(236 239 244)" strokeWidth="0.6" />
        <circle cx="0" cy="-1.3" r="1.2" fill="rgb(5 6 8)" stroke="rgb(236 239 244)" strokeWidth="0.6" />
        <circle cx="0" cy="1.2" r="0.45" fill={activity === 'alert' ? 'rgb(255 90 90)' : 'rgb(56 214 255)'} />
      </g>
    </svg>
  );
}
