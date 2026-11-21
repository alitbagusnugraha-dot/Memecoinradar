/**
 * src/lib/autopilot/paper.ts — Simulasi eksekusi mode latihan (paper trading).
 *
 * Tujuannya JUJUR, bukan optimis. Setiap beli/jual simulasi dikenai:
 *  1. Price impact model pool constant-product (x·y=k) berdasarkan likuiditas DexScreener.
 *     Untuk pool CLMM/DLMM ini perkiraan kasar — likuiditas terkonsentrasi bisa lebih
 *     dangkal atau lebih dalam dari angka total.
 *  2. Fee LP DEX (perkiraan per dexId).
 *  3. Penalti keterlambatan per sisi (default 1%): data DexScreener tertinggal beberapa
 *     detik dan transaksi asli butuh 1–3 detik untuk masuk blok.
 *  4. Fee jaringan + priority fee + tip Jito sesuai pengaturan swap Anda, per transaksi.
 * Rent token account (±0,002 SOL) tidak dihitung karena kembali saat akun ditutup.
 */

import type { ExitConfig } from "./config";
import type { ClosedTrade, ExitFill, ExitKind, PaperPosition, PositionRuleState } from "./types";

export const BASE_FEE_SOL = 0.000005;

export interface CostModel {
  lpFeePct: number;
  latencyPenaltyPct: number;
  txCostSol: number;
}

const LP_FEE_BY_DEX: Readonly<Record<string, number>> = {
  pumpswap: 0.3,
  raydium: 0.25,
  "raydium-cpmm": 0.25,
  "raydium-clmm": 0.25,
  orca: 0.3,
  meteora: 0.5,
  "meteora-damm": 0.5,
  "meteora-dlmm": 0.5,
};

export function lpFeePctForDex(dexId: string): number {
  return LP_FEE_BY_DEX[dexId.toLowerCase()] ?? 0.3;
}

export function estimateTxCostSol(swap: { priorityFeeSol: number; tipSol: number }): number {
  return Math.max(0, swap.priorityFeeSol) + Math.max(0, swap.tipSol) + BASE_FEE_SOL;
}

/** Perkiraan cadangan SOL di pool: separuh total likuiditas USD, dikonversi ke SOL. */
export function poolSolReserve(liquidityUsd: number | null, solUsd: number | null): number | null {
  if (liquidityUsd === null || solUsd === null || liquidityUsd <= 0 || solUsd <= 0) return null;
  return liquidityUsd / 2 / solUsd;
}

export interface SimulatedBuy {
  tokens: number;
  costSol: number;
  entryPriceSol: number;
  impactPct: number;
}

export function simulateBuy(params: { solIn: number; priceSol: number; poolSol: number | null; model: CostModel }): SimulatedBuy {
  const { solIn, priceSol, poolSol, model } = params;
  if (!(solIn > 0) || !(priceSol > 0)) throw new Error("solIn dan priceSol harus > 0");
  const fee = model.lpFeePct / 100;
  const penalty = model.latencyPenaltyPct / 100;
  const effectiveIn = solIn * (1 - fee);
  const spotTokens = solIn / priceSol;
  let tokens: number;
  if (poolSol !== null && poolSol > 0) {
    const tokenReserve = poolSol / priceSol;
    tokens = (tokenReserve * effectiveIn) / (poolSol + effectiveIn);
  } else {
    tokens = effectiveIn / priceSol;
  }
  tokens *= 1 - penalty;
  const costSol = solIn + model.txCostSol;
  return {
    tokens,
    costSol,
    entryPriceSol: costSol / tokens,
    impactPct: (1 - tokens / spotTokens) * 100,
  };
}

export interface SimulatedSell {
  proceedsSol: number;
  impactPct: number;
}

export function simulateSell(params: { tokens: number; priceSol: number; poolSol: number | null; model: CostModel }): SimulatedSell {
  const { tokens, priceSol, poolSol, model } = params;
  if (!(tokens > 0) || !(priceSol > 0)) return { proceedsSol: 0, impactPct: 100 };
  const fee = model.lpFeePct / 100;
  const penalty = model.latencyPenaltyPct / 100;
  const spotValue = tokens * priceSol;
  const effectiveValue = spotValue * (1 - fee);
  let out: number;
  if (poolSol !== null && poolSol > 0) {
    out = (poolSol * effectiveValue) / (poolSol + effectiveValue);
  } else {
    out = effectiveValue;
  }
  out *= 1 - penalty;
  const proceedsSol = Math.max(0, out - model.txCostSol);
  return { proceedsSol, impactPct: (1 - out / spotValue) * 100 };
}

// ---------------------------------------------------------------------------
// Aturan jual per posisi
// ---------------------------------------------------------------------------

let idCounter = 0;
export function newId(prefix: string): string {
  idCounter += 1;
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

export function buildRuleState(exit: ExitConfig): PositionRuleState {
  return {
    takeProfits: [...exit.takeProfits]
      .sort((a, b) => a.triggerPct - b.triggerPct)
      .map((level) => ({ id: newId("tp"), ...level, done: false, doneAt: null, signature: null })),
    stopLoss: exit.stopLoss ? { ...exit.stopLoss, done: false, doneAt: null, signature: null } : null,
    trailing: exit.trailing
      ? {
          ...exit.trailing,
          armed: exit.trailing.activatePct <= 0,
          peakPriceSol: null,
          done: false,
          doneAt: null,
          signature: null,
        }
      : null,
  };
}

/** Nilai likuidasi posisi sekarang (bersih setelah biaya jual simulasi). */
export function markToMarket(position: PaperPosition, priceSol: number | null, poolSol: number | null, model: CostModel): {
  valueSol: number | null;
  pnlSol: number | null;
  pnlPct: number | null;
} {
  if (priceSol === null || !(priceSol > 0)) return { valueSol: null, pnlSol: null, pnlPct: null };
  const { proceedsSol } = simulateSell({ tokens: position.tokensRemaining, priceSol, poolSol, model });
  const pnlSol = position.proceedsSol + proceedsSol - position.costSol;
  return { valueSol: proceedsSol, pnlSol, pnlPct: (pnlSol / position.costSol) * 100 };
}

export interface PaperExitResult {
  position: PaperPosition;
  fill: ExitFill;
  closed: ClosedTrade | null;
}

/** Terapkan satu penjualan simulasi. Fungsi murni: mengembalikan objek baru. */
export function applyPaperExit(
  position: PaperPosition,
  params: { kind: ExitKind; levelId: string | null; sellPct: number; priceSol: number; poolSol: number | null; model: CostModel; at: number },
): PaperExitResult {
  const sellPct = Math.min(100, Math.max(0, params.sellPct));
  let tokensToSell = sellPct >= 100 ? position.tokensRemaining : (position.tokensRemaining * sellPct) / 100;
  const leftover = position.tokensRemaining - tokensToSell;
  const fullyClosed = sellPct >= 100 || leftover <= position.tokensInitial * 1e-6;
  if (fullyClosed) tokensToSell = position.tokensRemaining;

  const { proceedsSol } = simulateSell({ tokens: tokensToSell, priceSol: params.priceSol, poolSol: params.poolSol, model: params.model });
  const costPortion = position.tokensRemaining > 0 ? (position.costRemainingSol * tokensToSell) / position.tokensRemaining : 0;

  const fill: ExitFill = {
    at: params.at,
    kind: params.kind,
    soldPct: fullyClosed ? 100 : sellPct,
    tokens: tokensToSell,
    priceSol: params.priceSol,
    proceedsSol,
  };

  const rule: PositionRuleState = {
    takeProfits: position.rule.takeProfits.map((level) =>
      params.kind === "take-profit" && level.id === params.levelId ? { ...level, done: true, doneAt: params.at } : level,
    ),
    stopLoss:
      position.rule.stopLoss && params.kind === "stop-loss"
        ? { ...position.rule.stopLoss, done: true, doneAt: params.at }
        : position.rule.stopLoss,
    trailing:
      position.rule.trailing && params.kind === "trailing"
        ? { ...position.rule.trailing, done: true, doneAt: params.at }
        : position.rule.trailing,
  };

  const updated: PaperPosition = {
    ...position,
    tokensRemaining: fullyClosed ? 0 : position.tokensRemaining - tokensToSell,
    costRemainingSol: fullyClosed ? 0 : position.costRemainingSol - costPortion,
    proceedsSol: position.proceedsSol + proceedsSol,
    rule,
    exits: [...position.exits, fill],
    lastPriceSol: params.priceSol,
    lastPriceAt: params.at,
  };

  if (!fullyClosed) return { position: updated, fill, closed: null };

  const pnlSol = updated.proceedsSol - position.costSol;
  const closed: ClosedTrade = {
    id: position.id,
    mode: "paper",
    mint: position.mint,
    symbol: position.symbol,
    openedAt: position.openedAt,
    closedAt: params.at,
    costSol: position.costSol,
    proceedsSol: updated.proceedsSol,
    pnlSol,
    pnlPct: (pnlSol / position.costSol) * 100,
    holdMinutes: (params.at - position.openedAt) / 60_000,
    closeReason: params.kind,
    exits: updated.exits,
    signal: position.signal,
    maxPnlPct: position.maxPnlPct,
    minPnlPct: position.minPnlPct,
    estimated: false,
  };
  return { position: updated, fill, closed };
}
