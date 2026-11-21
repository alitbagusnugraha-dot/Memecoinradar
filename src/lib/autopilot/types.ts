/**
 * src/lib/autopilot/types.ts — Tipe data posisi & riwayat Auto-Pilot (latihan dan uang asli).
 */

import type { StopLossConfig, TakeProfitLevel, TrailingStopConfig } from "@/store/auto-sell-store";
import type { AutoPilotMode } from "./config";
import type { SourceId } from "./sources";

/** Kondisi kandidat saat sinyal beli — disimpan agar hasil latihan bisa dianalisis. */
export interface SignalSnapshot {
  score: number;
  ageHours: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  volume1hUsd: number | null;
  volumeAccel: number | null;
  buySellRatio1h: number | null;
  priceChange1h: number | null;
  priceChange5m: number | null;
  organicScore: number | null;
  top10Pct: number | null;
  largestHolderPct: number | null;
  riskLabel: string;
  sources: SourceId[];
}

export type ExitKind = "take-profit" | "stop-loss" | "trailing" | "time-stop" | "manual" | "kill" | "external";

export const EXIT_LABEL: Readonly<Record<ExitKind, string>> = {
  "take-profit": "Take-profit",
  "stop-loss": "Stop-loss",
  trailing: "Trailing stop",
  "time-stop": "Batas waktu",
  manual: "Ditutup manual",
  kill: "Stop darurat",
  external: "Dijual di luar Auto-Pilot",
};

export interface ExitFill {
  at: number;
  kind: ExitKind;
  /** Persentase sisa token yang dijual pada eksekusi ini. */
  soldPct: number;
  tokens: number;
  priceSol: number;
  proceedsSol: number;
}

export interface PositionRuleState {
  takeProfits: TakeProfitLevel[];
  stopLoss: StopLossConfig | null;
  trailing: TrailingStopConfig | null;
}

export interface PaperPosition {
  id: string;
  mint: string;
  symbol: string;
  imageUrl: string | null;
  dexId: string;
  openedAt: number;
  /** Harga spot DexScreener saat sinyal (SOL per token). */
  signalPriceSol: number;
  /** Harga masuk efektif = total biaya ÷ token (termasuk LP fee, penalti, fee jaringan, tip). */
  entryPriceSol: number;
  tokensInitial: number;
  tokensRemaining: number;
  /** Total SOL keluar saat beli (termasuk biaya). */
  costSol: number;
  /** Bagian biaya yang masih melekat pada token yang belum dijual. */
  costRemainingSol: number;
  /** Total SOL bersih yang sudah diterima dari penjualan sebagian. */
  proceedsSol: number;
  rule: PositionRuleState;
  maxHoldMinutes: number;
  exits: ExitFill[];
  signal: SignalSnapshot;
  lastPriceSol: number | null;
  lastPriceAt: number | null;
  maxPnlPct: number;
  minPnlPct: number;
}

export interface LivePosition {
  id: string;
  wallet: string;
  mint: string;
  symbol: string;
  imageUrl: string | null;
  openedAt: number;
  buySignature: string;
  /** SOL keluar saat beli (swap + fee + tip), dari meta transaksi on-chain bila tersedia. */
  costSol: number;
  tokens: number;
  entryPriceSol: number | null;
  maxHoldMinutes: number;
  signal: SignalSnapshot;
  maxPnlPct: number;
  minPnlPct: number;
}

export interface ClosedTrade {
  id: string;
  mode: AutoPilotMode;
  mint: string;
  symbol: string;
  openedAt: number;
  closedAt: number;
  costSol: number;
  proceedsSol: number;
  pnlSol: number;
  pnlPct: number;
  holdMinutes: number;
  closeReason: ExitKind;
  exits: ExitFill[];
  signal: SignalSnapshot;
  maxPnlPct: number;
  minPnlPct: number;
  /** Mode uang asli: sebagian angka dari quote (detail transaksi belum terbaca). */
  estimated: boolean;
}

export type LogLevel = "info" | "buy" | "sell" | "warn" | "error" | "guard";

export interface AutoPilotLogEntry {
  id: string;
  at: number;
  level: LogLevel;
  mode: AutoPilotMode;
  message: string;
  mint?: string;
}
