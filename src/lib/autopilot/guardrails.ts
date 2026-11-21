/**
 * src/lib/autopilot/guardrails.ts — Rem pengaman Auto-Pilot (fungsi murni).
 *
 * Dua jenis rem:
 *  - REM BERHENTI (pause): rugi harian atau rugi beruntun tercapai → Auto-Pilot dimatikan
 *    dan harus Anda nyalakan lagi secara manual. Posisi terbuka tetap dikelola TP/SL.
 *  - REM KAPASITAS: posisi penuh, batas per jam/hari, saldo kurang, wallet terkunci →
 *    hanya tidak membuka posisi baru di siklus ini; Auto-Pilot tetap berjalan.
 */

import type { AutoPilotConfig, AutoPilotMode } from "./config";
import { estimateTxCostSol } from "./paper";

export interface GuardrailInput {
  config: AutoPilotConfig;
  mode: AutoPilotMode;
  openPositions: number;
  openedLastHour: number;
  openedToday: number;
  realizedTodaySol: number;
  unrealizedOpenSol: number;
  consecutiveLosses: number;
  paperCashSol: number;
  hasWallet: boolean;
  walletUnlocked: boolean;
  walletSol: number | null;
  autoSellEngineEnabled: boolean;
  swapCost: { priorityFeeSol: number; tipSol: number };
}

export type GuardrailResult = { ok: true } | { ok: false; reason: string; pause: boolean };

export function checkStopRules(input: GuardrailInput): GuardrailResult {
  const { guardrails } = input.config;
  const todayPnl = input.realizedTodaySol + input.unrealizedOpenSol;
  if (todayPnl <= -guardrails.dailyLossLimitSol) {
    return {
      ok: false,
      pause: true,
      reason: `Rugi hari ini ${todayPnl.toFixed(4)} SOL mencapai batas −${guardrails.dailyLossLimitSol} SOL. Auto-Pilot berhenti sampai besok.`,
    };
  }
  if (guardrails.maxConsecutiveLosses > 0 && input.consecutiveLosses >= guardrails.maxConsecutiveLosses) {
    return {
      ok: false,
      pause: true,
      reason: `${input.consecutiveLosses} kali rugi beruntun (batas ${guardrails.maxConsecutiveLosses}). Auto-Pilot berhenti — tinjau filter sebelum melanjutkan.`,
    };
  }
  return { ok: true };
}

export function checkEntryCapacity(input: GuardrailInput): GuardrailResult {
  const { entry, guardrails } = input.config;
  if (input.openPositions >= entry.maxOpenPositions) {
    return { ok: false, pause: false, reason: `Posisi penuh (${input.openPositions}/${entry.maxOpenPositions}).` };
  }
  if (input.openedLastHour >= entry.maxEntriesPerHour) {
    return { ok: false, pause: false, reason: `Batas ${entry.maxEntriesPerHour} entry per jam tercapai.` };
  }
  if (input.openedToday >= entry.maxTradesPerDay) {
    return { ok: false, pause: false, reason: `Batas ${entry.maxTradesPerDay} entry per hari tercapai.` };
  }

  const txCost = estimateTxCostSol(input.swapCost);
  if (input.mode === "paper") {
    if (input.paperCashSol < entry.solPerTrade + txCost) {
      return { ok: false, pause: false, reason: `Saldo latihan ${input.paperCashSol.toFixed(4)} SOL tidak cukup.` };
    }
    return { ok: true };
  }

  if (!input.hasWallet) return { ok: false, pause: false, reason: "Belum ada burner wallet." };
  if (!input.walletUnlocked) return { ok: false, pause: false, reason: "Wallet terkunci — Auto-Pilot tidak bisa menandatangani." };
  if (!input.autoSellEngineEnabled) {
    return { ok: false, pause: false, reason: "Mesin Auto TP/SL dimatikan — posisi baru tidak akan punya pengaman jual." };
  }
  const needed = entry.solPerTrade + txCost * 2 + guardrails.minWalletReserveSol;
  if (input.walletSol === null) return { ok: false, pause: false, reason: "Saldo SOL belum terbaca." };
  if (input.walletSol < needed) {
    return {
      ok: false,
      pause: false,
      reason: `Saldo ${input.walletSol.toFixed(4)} SOL < ${needed.toFixed(4)} SOL (beli + fee + cadangan ${guardrails.minWalletReserveSol}).`,
    };
  }
  return { ok: true };
}

export function checkGuardrails(input: GuardrailInput): GuardrailResult {
  const stop = checkStopRules(input);
  if (!stop.ok) return stop;
  return checkEntryCapacity(input);
}
