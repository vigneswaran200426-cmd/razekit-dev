import './dev.css';
import ParticleField from './ParticleField';
import SpiderWeb from './SpiderWeb';

// The RazeKit DEV surface: its own dark register, the spider on its web in the
// corner, the particle field behind. Wraps every DEV page; the marketplace
// chrome around it is untouched.
export default function DevShell({ activity = 'idle', children }) {
  return (
    <div className="dev-os">
      <ParticleField />
      <div className="dev-content">
        <div className="mb-3 flex items-center gap-2">
          <SpiderWeb activity={activity} size={52} />
          <span className="font-display text-[13px] font-semibold tracking-[0.2em] text-muted">RAZEKIT DEV</span>
        </div>
        {children}
      </div>
    </div>
  );
}
