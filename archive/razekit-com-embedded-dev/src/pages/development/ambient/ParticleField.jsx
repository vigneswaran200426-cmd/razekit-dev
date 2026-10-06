import { useEffect, useRef } from 'react';

// Slow floating points behind the DEV area: a digital water surface, not a
// starfield. One canvas, a capped number of points scaled to the screen,
// faint links between near neighbours. Off entirely for reduced motion, and
// paused while the tab is hidden, so it never costs the page anything.
export default function ParticleField() {
  const canvas = useRef(null);
  useEffect(() => {
    const el = canvas.current;
    if (!el || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return undefined;
    const ctx = el.getContext('2d');
    if (!ctx) return undefined;
    let raf = 0;
    let pts = [];
    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const { width, height } = el.getBoundingClientRect();
      el.width = Math.round(width * dpr);
      el.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.min(70, Math.round((width * height) / 18000));
      pts = Array.from({ length: count }, () => ({ x: Math.random() * width, y: Math.random() * height, vx: (Math.random() - 0.5) * 6, vy: (Math.random() - 0.5) * 6, r: 0.6 + Math.random() * 1.2 }));
    };
    let last = performance.now();
    const frame = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const { width, height } = el.getBoundingClientRect();
      ctx.clearRect(0, 0, width, height);
      for (const p of pts) {
        p.x = (p.x + p.vx * dt + width) % width;
        p.y = (p.y + p.vy * dt + height) % height;
      }
      ctx.lineWidth = 0.5;
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
          if (d < 90) {
            ctx.strokeStyle = `rgba(56, 214, 255, ${0.08 * (1 - d / 90)})`;
            ctx.beginPath();
            ctx.moveTo(pts[i].x, pts[i].y);
            ctx.lineTo(pts[j].x, pts[j].y);
            ctx.stroke();
          }
        }
      }
      ctx.fillStyle = 'rgba(236, 239, 244, 0.35)';
      for (const p of pts) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      raf = requestAnimationFrame(frame);
    };
    const onVisibility = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    };
    resize();
    raf = requestAnimationFrame(frame);
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
  return <canvas ref={canvas} aria-hidden="true" className="pointer-events-none absolute inset-0 z-0 h-full w-full rounded-[20px]" />;
}
