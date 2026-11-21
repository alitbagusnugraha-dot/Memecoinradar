/**
 * State Auto-Pilot yang disimpan di localStorage: pengaturan, mode, posisi latihan &
 * uang asli, riwayat trade, cooldown per mint, daftar hitam, dan log aktivitas.
 *
 * Keamanan: bila halaman dimuat ulang saat mode UANG ASLI sedang berjalan, Auto-Pilot
 * TIDAK dilanjutkan otomatis — Anda harus menekan Mulai lagi. Mode latihan dilanjutkan.
 */

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { DEFAULT_AUTOPILOT_CONFIG, sanitizeConfig, type AutoPilotConfig, type AutoPilotMode } from "@/lib/autopilot/config";
import { newId } from "@/lib/autopilot/paper";
import type { AutoPilotLogEntry, ClosedTrade, LivePosition, LogLevel, PaperPosition } from "@/lib/autopilot/types";

const MAX_LOG = 200;
const MAX_CLOSED = 1_000;

export interface AutoPilotState {
  config: AutoPilotConfig;
  mode: AutoPilotMode;
  running: boolean;
  startedAt: number | null;
  /** Rugi beruntun hanya dihitung sejak waktu ini (di-reset tiap kali Mulai ditekan). */
  streakResetAt: number;
  pausedReason: string | null;
  paperPositions: PaperPosition[];
  livePositions: LivePosition[];
  closed: ClosedTrade[];
  /** mint → timestamp sampai kapan mint ini tidak boleh dibeli lagi. */
  cooldowns: Record<string, number>;
  blacklist: string[];
  log: AutoPilotLogEntry[];
  liveConfirmedAt: number | null;

  setConfig: (config: AutoPilotConfig) => void;
  resetConfig: () => void;
  setMode: (mode: AutoPilotMode) => void;
  start: () => void;
  stop: (reason?: string) => void;
  pause: (reason: string) => void;
  addLog: (level: LogLevel, message: string, mint?: string) => void;
  clearLog: () => void;
  openPaper: (position: PaperPosition) => void;
  replacePaper: (position: PaperPosition) => void;
  closePaper: (id: string, trade: ClosedTrade) => void;
  addLive: (position: LivePosition) => void;
  updateLive: (id: string, patch: Partial<LivePosition>) => void;
  closeLive: (id: string, trade: ClosedTrade) => void;
  removeLive: (id: string) => void;
  setCooldown: (mint: string, until: number) => void;
  addBlacklist: (mint: string) => void;
  removeBlacklist: (mint: string) => void;
  resetPaper: () => void;
}

/** Saldo kas latihan = modal awal + PnL trade latihan tertutup − modal yang masih terpakai. */
export function paperCashSol(state: Pick<AutoPilotState, "config" | "closed" | "paperPositions">): number {
  const realized = state.closed.filter((trade) => trade.mode === "paper").reduce((sum, trade) => sum + trade.pnlSol, 0);
  const deployed = state.paperPositions.reduce((sum, position) => sum + (position.costSol - position.proceedsSol), 0);
  return state.config.paper.startBalanceSol + realized - deployed;
}

export const useAutoPilotStore = create<AutoPilotState>()(
  persist(
    (set, get) => ({
      config: DEFAULT_AUTOPILOT_CONFIG,
      mode: "paper",
      running: false,
      startedAt: null,
      streakResetAt: 0,
      pausedReason: null,
      paperPositions: [],
      livePositions: [],
      closed: [],
      cooldowns: {},
      blacklist: [],
      log: [],
      liveConfirmedAt: null,

      setConfig: (config) => set({ config: sanitizeConfig(config) }),
      resetConfig: () => set({ config: sanitizeConfig(DEFAULT_AUTOPILOT_CONFIG) }),

      setMode: (mode) => {
        const state = get();
        if (state.mode === mode) return;
        set({
          mode,
          running: false,
          startedAt: null,
          pausedReason: null,
          liveConfirmedAt: mode === "live" ? Date.now() : state.liveConfirmedAt,
        });
        get().addLog(
          "info",
          mode === "live"
            ? "Mode diganti ke UANG ASLI. Auto-Pilot dihentikan — tekan Mulai bila sudah siap."
            : "Mode diganti ke LATIHAN. Posisi uang asli yang masih terbuka tetap dijaga TP/SL.",
        );
      },

      start: () => {
        const now = Date.now();
        set({ running: true, startedAt: now, streakResetAt: now, pausedReason: null });
        get().addLog("info", `Auto-Pilot dimulai (${get().mode === "live" ? "UANG ASLI" : "latihan"}).`);
      },

      stop: (reason) => {
        if (!get().running) return;
        set({ running: false, startedAt: null });
        get().addLog("info", reason ?? "Auto-Pilot dihentikan. Posisi terbuka tetap dijaga TP/SL.");
      },

      pause: (reason) => {
        set({ running: false, startedAt: null, pausedReason: reason });
        get().addLog("guard", reason);
      },

      addLog: (level, message, mint) =>
        set((state) => ({
          log: [{ id: newId("log"), at: Date.now(), level, mode: state.mode, message, ...(mint ? { mint } : {}) }, ...state.log].slice(
            0,
            MAX_LOG,
          ),
        })),

      clearLog: () => set({ log: [] }),

      openPaper: (position) => set((state) => ({ paperPositions: [...state.paperPositions, position] })),

      replacePaper: (position) =>
        set((state) => ({
          paperPositions: state.paperPositions.map((existing) => (existing.id === position.id ? position : existing)),
        })),

      closePaper: (id, trade) =>
        set((state) => ({
          paperPositions: state.paperPositions.filter((position) => position.id !== id),
          closed: [...state.closed, trade].slice(-MAX_CLOSED),
        })),

      addLive: (position) => set((state) => ({ livePositions: [...state.livePositions, position] })),

      updateLive: (id, patch) =>
        set((state) => ({
          livePositions: state.livePositions.map((position) => (position.id === id ? { ...position, ...patch } : position)),
        })),

      closeLive: (id, trade) =>
        set((state) => ({
          livePositions: state.livePositions.filter((position) => position.id !== id),
          closed: [...state.closed, trade].slice(-MAX_CLOSED),
        })),

      removeLive: (id) => set((state) => ({ livePositions: state.livePositions.filter((position) => position.id !== id) })),

      setCooldown: (mint, until) =>
        set((state) => {
          const now = Date.now();
          const cooldowns: Record<string, number> = {};
          for (const [key, value] of Object.entries(state.cooldowns)) if (value > now) cooldowns[key] = value;
          cooldowns[mint] = Math.max(cooldowns[mint] ?? 0, until);
          return { cooldowns };
        }),

      addBlacklist: (mint) =>
        set((state) => (state.blacklist.includes(mint) ? state : { blacklist: [...state.blacklist, mint].slice(-500) })),

      removeBlacklist: (mint) => set((state) => ({ blacklist: state.blacklist.filter((item) => item !== mint) })),

      resetPaper: () => {
        set((state) => ({
          paperPositions: [],
          closed: state.closed.filter((trade) => trade.mode !== "paper"),
          running: state.mode === "paper" ? false : state.running,
          pausedReason: state.mode === "paper" ? null : state.pausedReason,
        }));
        get().addLog("info", "Data latihan direset: posisi & riwayat latihan dihapus, saldo latihan kembali ke modal awal.");
      },
    }),
    {
      name: "smt:autopilot:v1",
      version: 1,
      storage: createJSONStorage(() => window.localStorage),
      partialize: (state) => ({
        config: state.config,
        mode: state.mode,
        running: state.running,
        startedAt: state.startedAt,
        streakResetAt: state.streakResetAt,
        pausedReason: state.pausedReason,
        paperPositions: state.paperPositions,
        livePositions: state.livePositions,
        closed: state.closed,
        cooldowns: state.cooldowns,
        blacklist: state.blacklist,
        log: state.log,
        liveConfirmedAt: state.liveConfirmedAt,
      }),
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<AutoPilotState>;
        const merged: AutoPilotState = {
          ...current,
          ...saved,
          config: sanitizeConfig(saved.config ?? current.config),
        };
        if (merged.mode === "live" && merged.running) {
          merged.running = false;
          merged.startedAt = null;
          merged.pausedReason = "Halaman dimuat ulang: Auto-Pilot UANG ASLI tidak dilanjutkan otomatis. Tekan Mulai bila ingin lanjut.";
        }
        return merged;
      },
    },
  ),
);
