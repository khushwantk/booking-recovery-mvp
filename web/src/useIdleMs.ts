import { useEffect, useRef, useState } from "react";

/**
 * Tracks milliseconds since last user activity (pointer/key/touch/scroll).
 */
export function useIdleMs(): number {
  const last = useRef(Date.now());
  const [idle, setIdle] = useState(0);

  useEffect(() => {
    const bump = () => {
      last.current = Date.now();
    };
    const events = ["mousemove", "keydown", "touchstart", "scroll", "click"] as const;
    events.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    const id = window.setInterval(() => {
      setIdle(Date.now() - last.current);
    }, 1000);
    return () => {
      events.forEach((e) => window.removeEventListener(e, bump));
      window.clearInterval(id);
    };
  }, []);

  return idle;
}
