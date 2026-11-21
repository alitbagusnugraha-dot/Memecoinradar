"use client";

/**
 * src/hooks/useAutoPilot.ts — Menghubungkan mesin Auto-Pilot (singleton) ke halaman.
 *
 * Dipanggil SEKALI di halaman terminal: mesin berjalan selama tab terbuka, terlepas
 * dari panel Auto-Pilot sedang terlihat atau tidak.
 */

import { useEffect, useSyncExternalStore } from "react";
import { autopilotEngine, type EngineContext, type EngineView } from "@/lib/autopilot/engine";
import { useAutoPilotStore } from "@/store/autopilot-store";

export function useAutoPilot(context: EngineContext): EngineView {
  useEffect(() => autopilotEngine.attach(), []);

  // Konteks terbaru (wallet, saldo, posisi on-chain) dibaca mesin di setiap detak.
  useEffect(() => {
    autopilotEngine.setContext(context);
  });

  const running = useAutoPilotStore((state) => state.running);
  const hasOpenPositions = useAutoPilotStore((state) => state.paperPositions.length + state.livePositions.length > 0);

  // Cegah layar mati selama Auto-Pilot berjalan / mengelola posisi.
  const keepAwake = running || hasOpenPositions;
  useEffect(() => {
    if (!keepAwake || typeof navigator === "undefined" || !("wakeLock" in navigator)) return undefined;
    let sentinel: WakeLockSentinel | null = null;
    let released = false;
    const request = () => {
      if (document.visibilityState !== "visible") return;
      navigator.wakeLock
        .request("screen")
        .then((lock) => {
          if (released) void lock.release().catch(() => undefined);
          else sentinel = lock;
        })
        .catch(() => undefined);
    };
    request();
    document.addEventListener("visibilitychange", request);
    return () => {
      released = true;
      document.removeEventListener("visibilitychange", request);
      if (sentinel) void sentinel.release().catch(() => undefined);
    };
  }, [keepAwake]);

  return useSyncExternalStore(autopilotEngine.subscribe, autopilotEngine.getView, autopilotEngine.getServerView);
}
