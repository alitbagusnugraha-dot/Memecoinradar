/**
 * src/lib/auto-sell-eval.ts — Evaluasi murni aturan TP / SL / Trailing Stop.
 *
 * Dipakai bersama oleh:
 *  - mesin Auto TP/SL untuk uang asli (src/hooks/useAutoSell.ts)
 *  - simulasi posisi mode latihan Auto-Pilot (src/lib/autopilot/engine.ts)
 * sehingga aturan jual di mode latihan PERSIS sama dengan mode uang asli.
 *
 * Tidak ada efek samping, tidak ada React — aman diuji di Node.
 */

import { formatPct, formatPrice } from "./format";
import type { AutoSellRule, TriggerKind } from "@/store/auto-sell-store";

/** Data harga dianggap basi bila lebih lama dari ini → mesin tidak mengeksekusi. */
export const PRICE_STALE_MS = 12_000;

/** Berapa tick harga BARU berturut-turut yang dibutuhkan sebelum aturan dieksekusi. */
export const CONFIRM_TICKS: Readonly<Record<TriggerKind, number>> = {
  "take-profit": 2,
  "stop-loss": 1,
  trailing: 1,
};

export interface TriggerAction {
  kind: TriggerKind;
  levelId: string | null;
  sellPct: number;
  reason: string;
}

export interface RuleEvaluation {
  pnlPct: number;
  action: TriggerAction | null;
  trailingUpdate: { armed: boolean; peakPriceSol: number | null } | null;
  nextTakeProfit: { triggerPct: number; sellPct: number; priceSol: number } | null;
  stopLossPriceSol: number | null;
  trailingStopPriceSol: number | null;
  trailingArmed: boolean;
}

export type EvaluableRule = Pick<AutoSellRule, "takeProfits" | "stopLoss" | "trailing">;

export function evaluateRule(rule: EvaluableRule, priceSol: number, entryPriceSol: number): RuleEvaluation {
  const pnlPct = (priceSol / entryPriceSol - 1) * 100;

  // --- Trailing: update status armed & harga puncak ---
  let trailingUpdate: RuleEvaluation["trailingUpdate"] = null;
  let trailingArmed = false;
  let peak: number | null = null;
  const trailing = rule.trailing;
  if (trailing && !trailing.done) {
    trailingArmed = trailing.armed || pnlPct >= trailing.activatePct;
    peak = trailingArmed ? Math.max(trailing.peakPriceSol ?? priceSol, priceSol) : trailing.peakPriceSol;
    if (trailingArmed !== trailing.armed || peak !== trailing.peakPriceSol) {
      trailingUpdate = { armed: trailingArmed, peakPriceSol: peak };
    }
  }
  const trailingStopPriceSol =
    trailing && !trailing.done && trailingArmed && peak !== null ? peak * (1 - trailing.distancePct / 100) : null;

  const stopLoss = rule.stopLoss && !rule.stopLoss.done ? rule.stopLoss : null;
  const stopLossPriceSol = stopLoss ? entryPriceSol * (1 - stopLoss.triggerPct / 100) : null;

  const pendingTakeProfits = rule.takeProfits
    .filter((level) => !level.done)
    .sort((a, b) => a.triggerPct - b.triggerPct);
  const nextLevel = pendingTakeProfits[0];
  const nextTakeProfit = nextLevel
    ? { triggerPct: nextLevel.triggerPct, sellPct: nextLevel.sellPct, priceSol: entryPriceSol * (1 + nextLevel.triggerPct / 100) }
    : null;

  // --- Prioritas: SL → Trailing → TP ---
  let action: TriggerAction | null = null;
  if (stopLoss && pnlPct <= -stopLoss.triggerPct) {
    action = {
      kind: "stop-loss",
      levelId: null,
      sellPct: stopLoss.sellPct,
      reason: `PnL ${formatPct(pnlPct)} ≤ −${stopLoss.triggerPct}%`,
    };
  } else if (trailing && trailingStopPriceSol !== null && peak !== null && priceSol <= trailingStopPriceSol) {
    action = {
      kind: "trailing",
      levelId: null,
      sellPct: trailing.sellPct,
      reason: `Harga turun ${trailing.distancePct}% dari puncak ${formatPrice(peak)} SOL`,
    };
  } else {
    // Bila harga melompati beberapa level sekaligus, level TERENDAH dijual dulu;
    // level berikutnya dievaluasi lagi di tick selanjutnya.
    const reached = pendingTakeProfits.find((level) => pnlPct >= level.triggerPct);
    if (reached) {
      action = {
        kind: "take-profit",
        levelId: reached.id,
        sellPct: reached.sellPct,
        reason: `PnL ${formatPct(pnlPct)} ≥ +${reached.triggerPct}%`,
      };
    }
  }

  return { pnlPct, action, trailingUpdate, nextTakeProfit, stopLossPriceSol, trailingStopPriceSol, trailingArmed };
}
