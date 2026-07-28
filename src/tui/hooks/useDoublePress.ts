// ── useDoublePress (P1-8): double-press detection ──
// Returns a callback; first call fires onFirst, if called again within `ms` fires onSecond.
// Typical usage: first Ctrl+C clears input + shows hint, second Ctrl+C exits.
import { useRef } from 'react';

export function useDoublePress(onFirst: () => void, onSecond: () => void, ms = 800) {
  const ref = useRef(0);
  return () => {
    const now = Date.now();
    if (now - ref.current < ms) {
      onSecond();
      ref.current = 0;
    } else {
      onFirst();
      ref.current = now;
    }
  };
}
