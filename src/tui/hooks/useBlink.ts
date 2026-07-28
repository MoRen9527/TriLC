// ── useBlink hook (CC-compatible, no CC compiler runtime) ──
// Toggles a boolean on an interval — used by ToolCallLine for ● animation.
import { useState, useEffect } from 'react';

export function useBlink(active: boolean, interval = 800): boolean {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (!active) {
      setVisible(true); // solid when not blinking
      return;
    }
    const id = setInterval(() => setVisible(v => !v), interval);
    return () => clearInterval(id);
  }, [active, interval]);

  return visible;
}
