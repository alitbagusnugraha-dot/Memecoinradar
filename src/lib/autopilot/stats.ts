/**
 * src/lib/autopilot/stats.ts — Statistik hasil trading Auto-Pilot (fungsi murni).
 */

import type { ClosedTrade } from "./types";

/** Kunci hari lokal (zona waktu browser, mis. WIB): "2026-11-21". */
export function localDayKey(timestamp: number): string {
  const date = new Date(timestamp);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export interface TradeStats {
  count: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  netSol: number;
  grossWinSol: number;
  grossLossSol: number;
  /** Total untung ÷ total rugi. >1 = strategi menghasilkan. Null bila belum pernah rugi. */
  profitFactor: number | null;
  avgWinPct: number | null;
  avgLossPct: number | null;
  avgPnlPct: number | null;
  /** Rata-rata SOL per trade (ekspektasi). */
  expectancySol: number | null;
  /** Penurunan terbesar dari puncak kurva PnL kumulatif (SOL, angka positif). */
  maxDrawdownSol: number;
  avgHoldMinutes: number | null;
  bestPct: number | null;
  worstPct: number | null;
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

export function computeStats(trades: readonly ClosedTrade[]): TradeStats {
  const ordered = [...trades].sort((a, b) => a.closedAt - b.closedAt);
  const wins = ordered.filter((trade) => trade.pnlSol > 0);
  const losses = ordered.filter((trade) => trade.pnlSol < 0);
  const grossWinSol = wins.reduce((sum, trade) => sum + trade.pnlSol, 0);
  const grossLossSol = Math.abs(losses.reduce((sum, trade) => sum + trade.pnlSol, 0));
  const netSol = ordered.reduce((sum, trade) => sum + trade.pnlSol, 0);

  let cumulative = 0;
  let peak = 0;
  let maxDrawdownSol = 0;
  for (const trade of ordered) {
    cumulative += trade.pnlSol;
    peak = Math.max(peak, cumulative);
    maxDrawdownSol = Math.max(maxDrawdownSol, peak - cumulative);
  }

  const pcts = ordered.map((trade) => trade.pnlPct);
  return {
    count: ordered.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: ordered.length ? (wins.length / ordered.length) * 100 : null,
    netSol,
    grossWinSol,
    grossLossSol,
    profitFactor: grossLossSol > 0 ? grossWinSol / grossLossSol : null,
    avgWinPct: average(wins.map((trade) => trade.pnlPct)),
    avgLossPct: average(losses.map((trade) => trade.pnlPct)),
    avgPnlPct: average(pcts),
    expectancySol: ordered.length ? netSol / ordered.length : null,
    maxDrawdownSol,
    avgHoldMinutes: average(ordered.map((trade) => trade.holdMinutes)),
    bestPct: pcts.length ? Math.max(...pcts) : null,
    worstPct: pcts.length ? Math.min(...pcts) : null,
  };
}

export function tradesOnDay(trades: readonly ClosedTrade[], dayKey: string): ClosedTrade[] {
  return trades.filter((trade) => localDayKey(trade.closedAt) === dayKey);
}

/** Jumlah rugi beruntun TERAKHIR, hanya menghitung trade yang ditutup setelah `sinceTs`. */
export function consecutiveLosses(trades: readonly ClosedTrade[], sinceTs: number): number {
  const recent = trades.filter((trade) => trade.closedAt >= sinceTs).sort((a, b) => b.closedAt - a.closedAt);
  let streak = 0;
  for (const trade of recent) {
    if (trade.pnlSol < 0) streak += 1;
    else break;
  }
  return streak;
}

/** CSV hasil latihan/uang asli untuk dianalisis di Excel / Google Sheets. */
export function tradesToCsv(trades: readonly ClosedTrade[]): string {
  const header = [
    "mode",
    "symbol",
    "mint",
    "dibuka",
    "ditutup",
    "durasi_menit",
    "modal_sol",
    "hasil_sol",
    "pnl_sol",
    "pnl_pct",
    "alasan_tutup",
    "pnl_tertinggi_pct",
    "pnl_terendah_pct",
    "skor",
    "umur_jam",
    "likuiditas_usd",
    "mc_usd",
    "vol_1j_usd",
    "akselerasi_vol",
    "beli_jual_1j",
    "delta_1j_pct",
    "delta_5m_pct",
    "organik",
    "top10_pct",
    "whale_pct",
    "risiko",
    "sumber",
    "estimasi",
  ];
  const iso = (ts: number) => new Date(ts).toISOString();
  const fmt = (value: number | null, digits = 4) => (value === null || !Number.isFinite(value) ? "" : value.toFixed(digits));
  const escape = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  const rows = [...trades]
    .sort((a, b) => a.closedAt - b.closedAt)
    .map((trade) =>
      [
        trade.mode,
        trade.symbol,
        trade.mint,
        iso(trade.openedAt),
        iso(trade.closedAt),
        fmt(trade.holdMinutes, 1),
        fmt(trade.costSol, 6),
        fmt(trade.proceedsSol, 6),
        fmt(trade.pnlSol, 6),
        fmt(trade.pnlPct, 2),
        trade.closeReason,
        fmt(trade.maxPnlPct, 2),
        fmt(trade.minPnlPct, 2),
        fmt(trade.signal.score, 1),
        fmt(trade.signal.ageHours, 1),
        fmt(trade.signal.liquidityUsd, 0),
        fmt(trade.signal.marketCapUsd, 0),
        fmt(trade.signal.volume1hUsd, 0),
        fmt(trade.signal.volumeAccel, 2),
        fmt(trade.signal.buySellRatio1h, 2),
        fmt(trade.signal.priceChange1h, 2),
        fmt(trade.signal.priceChange5m, 2),
        fmt(trade.signal.organicScore, 0),
        fmt(trade.signal.top10Pct, 2),
        fmt(trade.signal.largestHolderPct, 2),
        trade.signal.riskLabel,
        trade.signal.sources.join("|"),
        trade.estimated ? "ya" : "tidak",
      ]
        .map((cell) => escape(String(cell)))
        .join(","),
    );
  return [header.join(","), ...rows].join("\n");
}
