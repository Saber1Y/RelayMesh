"use client";

import { useEffect, useState } from "react";

/**
 * Unix seconds, ticking once per second, corrected by the server/client clock offset measured at load.
 * The first render returns the server's time exactly, so server and client HTML match during hydration.
 */
export function useClock(serverTimeAtLoad: number): number {
  const [now, setNow] = useState(serverTimeAtLoad);
  useEffect(() => {
    const offset = serverTimeAtLoad - Math.floor(Date.now() / 1000);
    const tick = () => setNow(Math.floor(Date.now() / 1000) + offset);
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [serverTimeAtLoad]);
  return now;
}
