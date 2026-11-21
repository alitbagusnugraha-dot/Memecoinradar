/**
 * src/lib/autopilot/config.ts — Pengaturan Auto-Pilot + nilai default.
 *
 * Default disetel untuk gaya (b): token yang sudah berjalan beberapa jam, likuid,
 * dengan volume yang sedang naik (momentum), BUKAN sniping token baru lahir.
 * Semua angka bisa diubah di panel Pengaturan Auto-Pilot.
 */

export type AutoPilotMode = "paper" | "live";
export type JupiterInterval = "5m" | "1h" | "6h" | "24h";

export interface SourceConfig {
  /** Jupiter Tokens API: daftar token trending (data organik, audit, holder). */
  jupiterTrending: boolean;
  /** Jupiter Tokens API: token dengan volume perdagangan tertinggi. */
  jupiterTopTraded: boolean;
  jupiterInterval: JupiterInterval;
  /** DexScreener "metas" yang sedang trending → pair-pair di dalamnya (Solana saja). */
  dexTrendingMetas: boolean;
  /** Berapa meta teratas yang diambil pair-nya (tiap meta = 1 request). */
  dexMetaCount: number;
  /** DexScreener token yang sedang di-boost (promosi BERBAYAR — sinyal campuran). */
  dexBoosts: boolean;
}

export interface FilterConfig {
  minPairAgeHours: number;
  maxPairAgeHours: number;
  minLiquidityUsd: number;
  minMarketCapUsd: number;
  maxMarketCapUsd: number;
  minVolume1hUsd: number;
  /** Volume 1 jam terakhir ≥ angka ini × rata-rata volume per jam selama 6 jam. */
  minVolumeAccel: number;
  minPriceChange1hPct: number;
  maxPriceChange1hPct: number;
  minPriceChange5mPct: number;
  maxPriceChange5mPct: number;
  /** Jumlah transaksi beli ÷ jual dalam 1 jam. */
  minBuySellRatio1h: number;
  minTxns1h: number;
  /** Skor organik Jupiter 0–100 (menyaring volume bot/wash trading). 0 = tidak dicek. */
  minOrganicScore: number;
  /** Tolak kandidat yang tidak punya data Jupiter sama sekali. */
  requireJupiterData: boolean;
  /** Persentase supply di wallet developer (data Jupiter). 100 = tidak dicek. */
  maxDevBalancePct: number;
  minScore: number;
}

export interface SecurityConfig {
  /** Level "WASPADA" (temuan medium) boleh dibeli. "RISIKO TINGGI"/"BAHAYA" selalu ditolak. */
  allowCaution: boolean;
  /** Top 10 holder (tanpa pool & burn) maksimal (%). */
  maxTop10Pct: number;
  /** Satu holder non-pool maksimal (%). */
  maxSingleHolderPct: number;
}

export interface EntryConfig {
  solPerTrade: number;
  maxOpenPositions: number;
  /** Kandidat harus lolos semua filter di N siklus berturut-turut sebelum dibeli. */
  confirmCycles: number;
  maxEntriesPerHour: number;
  maxTradesPerDay: number;
  /** Jeda sebelum mint yang sama boleh dibeli lagi (menit). */
  reentryCooldownMinutes: number;
  buySlippageBps: number;
}

export interface ExitConfig {
  takeProfits: { triggerPct: number; sellPct: number }[];
  stopLoss: { triggerPct: number; sellPct: number } | null;
  trailing: { activatePct: number; distancePct: number; sellPct: number } | null;
  /** Posisi ditutup paksa setelah ditahan selama ini (menit). 0 = tanpa batas. */
  maxHoldMinutes: number;
  exitSlippageBps: number;
}

export interface GuardrailConfig {
  /** Rugi hari ini (realized + unrealized) mencapai angka ini → Auto-Pilot berhenti sampai besok. */
  dailyLossLimitSol: number;
  /** Rugi beruntun sebanyak ini → Auto-Pilot berhenti. 0 = tidak dicek. */
  maxConsecutiveLosses: number;
  /** Mode uang asli: sisakan SOL ini di wallet untuk fee jual & rent. */
  minWalletReserveSol: number;
}

export interface FeeConfig {
  /** Priority fee per transaksi Auto-Pilot (SOL). Token yang sudah likuid tidak butuh kecepatan sniper. */
  priorityFeeSol: number;
  /** Tip Jito / Helius Sender per transaksi Auto-Pilot (SOL). Minimal 0,000005. */
  tipSol: number;
}

export interface PaperConfig {
  startBalanceSol: number;
  /** Penalti harga per sisi (%): keterlambatan data DexScreener + slippage nyata. */
  latencyPenaltyPct: number;
}

export interface AutoPilotConfig {
  discoveryIntervalSec: number;
  maxScansPerCycle: number;
  sources: SourceConfig;
  filters: FilterConfig;
  security: SecurityConfig;
  entry: EntryConfig;
  exit: ExitConfig;
  guardrails: GuardrailConfig;
  fees: FeeConfig;
  paper: PaperConfig;
}

export const DEFAULT_AUTOPILOT_CONFIG: AutoPilotConfig = {
  discoveryIntervalSec: 45,
  maxScansPerCycle: 3,
  sources: {
    jupiterTrending: true,
    jupiterTopTraded: false,
    jupiterInterval: "1h",
    dexTrendingMetas: true,
    dexMetaCount: 2,
    dexBoosts: false,
  },
  filters: {
    minPairAgeHours: 2,
    maxPairAgeHours: 72,
    minLiquidityUsd: 40_000,
    minMarketCapUsd: 150_000,
    maxMarketCapUsd: 25_000_000,
    minVolume1hUsd: 40_000,
    minVolumeAccel: 1.3,
    minPriceChange1hPct: 2,
    maxPriceChange1hPct: 60,
    minPriceChange5mPct: -4,
    maxPriceChange5mPct: 12,
    minBuySellRatio1h: 1.1,
    minTxns1h: 200,
    minOrganicScore: 35,
    requireJupiterData: false,
    maxDevBalancePct: 10,
    minScore: 50,
  },
  security: {
    allowCaution: true,
    maxTop10Pct: 40,
    maxSingleHolderPct: 8,
  },
  entry: {
    solPerTrade: 0.05,
    maxOpenPositions: 3,
    confirmCycles: 2,
    maxEntriesPerHour: 4,
    maxTradesPerDay: 15,
    reentryCooldownMinutes: 240,
    buySlippageBps: 1_200,
  },
  exit: {
    takeProfits: [
      { triggerPct: 30, sellPct: 50 },
      { triggerPct: 70, sellPct: 100 },
    ],
    stopLoss: { triggerPct: 15, sellPct: 100 },
    trailing: { activatePct: 15, distancePct: 10, sellPct: 100 },
    maxHoldMinutes: 90,
    exitSlippageBps: 2_000,
  },
  guardrails: {
    dailyLossLimitSol: 0.2,
    maxConsecutiveLosses: 4,
    minWalletReserveSol: 0.05,
  },
  fees: {
    priorityFeeSol: 0.0002,
    tipSol: 0.0002,
  },
  paper: {
    startBalanceSol: 1,
    latencyPenaltyPct: 1,
  },
};

// ---------------------------------------------------------------------------
// Sanitasi: input dari form / localStorage lama selalu dikembalikan ke rentang aman
// ---------------------------------------------------------------------------

function num(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function int(value: unknown, fallback: number, min: number, max: number): number {
  return Math.round(num(value, fallback, min, max));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

const INTERVAL_SET = new Set<JupiterInterval>(["5m", "1h", "6h", "24h"]);

export function sanitizeConfig(input: unknown): AutoPilotConfig {
  const d = DEFAULT_AUTOPILOT_CONFIG;
  const raw = (input && typeof input === "object" ? input : {}) as Partial<Record<keyof AutoPilotConfig, unknown>>;
  const src = (raw.sources ?? {}) as Partial<SourceConfig>;
  const f = (raw.filters ?? {}) as Partial<FilterConfig>;
  const sec = (raw.security ?? {}) as Partial<SecurityConfig>;
  const en = (raw.entry ?? {}) as Partial<EntryConfig>;
  const ex = (raw.exit ?? {}) as Partial<ExitConfig>;
  const g = (raw.guardrails ?? {}) as Partial<GuardrailConfig>;
  const p = (raw.paper ?? {}) as Partial<PaperConfig>;
  const fee = (raw.fees ?? {}) as Partial<FeeConfig>;

  const takeProfits = Array.isArray(ex.takeProfits) ? ex.takeProfits : d.exit.takeProfits;
  const cleanTakeProfits = takeProfits
    .map((level) => ({
      triggerPct: num(level?.triggerPct, NaN, 1, 10_000),
      sellPct: num(level?.sellPct, NaN, 1, 100),
    }))
    .filter((level) => Number.isFinite(level.triggerPct) && Number.isFinite(level.sellPct))
    .sort((a, b) => a.triggerPct - b.triggerPct)
    .slice(0, 5);

  const stopLossInput = ex.stopLoss === undefined ? d.exit.stopLoss : ex.stopLoss;
  const trailingInput = ex.trailing === undefined ? d.exit.trailing : ex.trailing;

  const minAge = num(f.minPairAgeHours, d.filters.minPairAgeHours, 0, 24 * 90);
  const minMc = num(f.minMarketCapUsd, d.filters.minMarketCapUsd, 0, 1e12);

  const config: AutoPilotConfig = {
    discoveryIntervalSec: int(raw.discoveryIntervalSec, d.discoveryIntervalSec, 30, 600),
    maxScansPerCycle: int(raw.maxScansPerCycle, d.maxScansPerCycle, 1, 6),
    sources: {
      jupiterTrending: bool(src.jupiterTrending, d.sources.jupiterTrending),
      jupiterTopTraded: bool(src.jupiterTopTraded, d.sources.jupiterTopTraded),
      jupiterInterval: INTERVAL_SET.has(src.jupiterInterval as JupiterInterval)
        ? (src.jupiterInterval as JupiterInterval)
        : d.sources.jupiterInterval,
      dexTrendingMetas: bool(src.dexTrendingMetas, d.sources.dexTrendingMetas),
      dexMetaCount: int(src.dexMetaCount, d.sources.dexMetaCount, 1, 5),
      dexBoosts: bool(src.dexBoosts, d.sources.dexBoosts),
    },
    filters: {
      minPairAgeHours: minAge,
      maxPairAgeHours: Math.max(minAge, num(f.maxPairAgeHours, d.filters.maxPairAgeHours, 0, 24 * 365)),
      minLiquidityUsd: num(f.minLiquidityUsd, d.filters.minLiquidityUsd, 0, 1e12),
      minMarketCapUsd: minMc,
      maxMarketCapUsd: Math.max(minMc, num(f.maxMarketCapUsd, d.filters.maxMarketCapUsd, 0, 1e12)),
      minVolume1hUsd: num(f.minVolume1hUsd, d.filters.minVolume1hUsd, 0, 1e12),
      minVolumeAccel: num(f.minVolumeAccel, d.filters.minVolumeAccel, 0, 50),
      minPriceChange1hPct: num(f.minPriceChange1hPct, d.filters.minPriceChange1hPct, -100, 10_000),
      maxPriceChange1hPct: num(f.maxPriceChange1hPct, d.filters.maxPriceChange1hPct, -100, 10_000),
      minPriceChange5mPct: num(f.minPriceChange5mPct, d.filters.minPriceChange5mPct, -100, 10_000),
      maxPriceChange5mPct: num(f.maxPriceChange5mPct, d.filters.maxPriceChange5mPct, -100, 10_000),
      minBuySellRatio1h: num(f.minBuySellRatio1h, d.filters.minBuySellRatio1h, 0, 100),
      minTxns1h: int(f.minTxns1h, d.filters.minTxns1h, 0, 1_000_000),
      minOrganicScore: num(f.minOrganicScore, d.filters.minOrganicScore, 0, 100),
      requireJupiterData: bool(f.requireJupiterData, d.filters.requireJupiterData),
      maxDevBalancePct: num(f.maxDevBalancePct, d.filters.maxDevBalancePct, 0, 100),
      minScore: num(f.minScore, d.filters.minScore, 0, 100),
    },
    security: {
      allowCaution: bool(sec.allowCaution, d.security.allowCaution),
      maxTop10Pct: num(sec.maxTop10Pct, d.security.maxTop10Pct, 1, 100),
      maxSingleHolderPct: num(sec.maxSingleHolderPct, d.security.maxSingleHolderPct, 0.5, 100),
    },
    entry: {
      solPerTrade: num(en.solPerTrade, d.entry.solPerTrade, 0.001, 5),
      maxOpenPositions: int(en.maxOpenPositions, d.entry.maxOpenPositions, 1, 10),
      confirmCycles: int(en.confirmCycles, d.entry.confirmCycles, 1, 5),
      maxEntriesPerHour: int(en.maxEntriesPerHour, d.entry.maxEntriesPerHour, 1, 30),
      maxTradesPerDay: int(en.maxTradesPerDay, d.entry.maxTradesPerDay, 1, 200),
      reentryCooldownMinutes: int(en.reentryCooldownMinutes, d.entry.reentryCooldownMinutes, 0, 60 * 24 * 7),
      buySlippageBps: int(en.buySlippageBps, d.entry.buySlippageBps, 50, 5_000),
    },
    exit: {
      takeProfits: cleanTakeProfits,
      stopLoss:
        stopLossInput && typeof stopLossInput === "object"
          ? {
              triggerPct: num(stopLossInput.triggerPct, 15, 1, 99),
              sellPct: num(stopLossInput.sellPct, 100, 1, 100),
            }
          : null,
      trailing:
        trailingInput && typeof trailingInput === "object"
          ? {
              activatePct: num(trailingInput.activatePct, 15, 0, 10_000),
              distancePct: num(trailingInput.distancePct, 10, 1, 99),
              sellPct: num(trailingInput.sellPct, 100, 1, 100),
            }
          : null,
      maxHoldMinutes: int(ex.maxHoldMinutes, d.exit.maxHoldMinutes, 0, 60 * 24 * 7),
      exitSlippageBps: int(ex.exitSlippageBps, d.exit.exitSlippageBps, 50, 5_000),
    },
    guardrails: {
      dailyLossLimitSol: num(g.dailyLossLimitSol, d.guardrails.dailyLossLimitSol, 0.001, 1_000),
      maxConsecutiveLosses: int(g.maxConsecutiveLosses, d.guardrails.maxConsecutiveLosses, 0, 50),
      minWalletReserveSol: num(g.minWalletReserveSol, d.guardrails.minWalletReserveSol, 0.01, 100),
    },
    fees: {
      priorityFeeSol: num(fee.priorityFeeSol, d.fees.priorityFeeSol, 0, 0.05),
      tipSol: num(fee.tipSol, d.fees.tipSol, 0.000005, 0.05),
    },
    paper: {
      startBalanceSol: num(p.startBalanceSol, d.paper.startBalanceSol, 0.01, 10_000),
      latencyPenaltyPct: num(p.latencyPenaltyPct, d.paper.latencyPenaltyPct, 0, 20),
    },
  };

  // Harus ada minimal satu jalan keluar, kalau tidak posisi bisa tertahan selamanya.
  if (
    config.exit.takeProfits.length === 0 &&
    !config.exit.stopLoss &&
    !config.exit.trailing &&
    config.exit.maxHoldMinutes === 0
  ) {
    config.exit.stopLoss = { ...(d.exit.stopLoss ?? { triggerPct: 15, sellPct: 100 }) };
  }
  // Minimal satu sumber kandidat.
  if (!config.sources.jupiterTrending && !config.sources.jupiterTopTraded && !config.sources.dexTrendingMetas && !config.sources.dexBoosts) {
    config.sources.jupiterTrending = true;
  }
  return config;
}

/** Validasi tambahan yang ditampilkan ke user (bukan error fatal). */
export function configWarnings(config: AutoPilotConfig): string[] {
  const warnings: string[] = [];
  if (!config.exit.stopLoss) warnings.push("Tanpa stop-loss: satu token yang anjlok bisa menghabiskan modal posisi itu.");
  if (config.exit.stopLoss && config.exit.stopLoss.triggerPct > 40) warnings.push("Stop-loss di atas 40% jarang menyelamatkan modal pada meme coin.");
  if (config.filters.minLiquidityUsd < 15_000) warnings.push("Likuiditas minimal di bawah $15k: slippage besar dan mudah dimanipulasi.");
  if (config.filters.minPairAgeHours < 1) warnings.push("Umur pair < 1 jam bukan lagi gaya (b) — risikonya seperti sniping token baru.");
  if (config.filters.minOrganicScore === 0) warnings.push("Skor organik tidak dicek: volume palsu (bot) bisa lolos filter volume.");
  if (config.entry.confirmCycles < 2) warnings.push("Konfirmasi 1 siklus: lebih cepat masuk, tapi lebih sering tertipu lonjakan sesaat.");
  const roundTripFeeSol = (config.fees.priorityFeeSol + config.fees.tipSol + 0.000005) * 2;
  const feePct = (roundTripFeeSol / config.entry.solPerTrade) * 100;
  if (feePct > 3) {
    warnings.push(
      `Fee jaringan + tip pulang-pergi ≈ ${feePct.toFixed(1)}% dari modal per trade — naikkan ukuran trade atau turunkan tip/priority fee.`,
    );
  }
  if (config.entry.maxOpenPositions * config.entry.solPerTrade > 1) {
    warnings.push(`Modal maksimal yang bisa terpakai bersamaan: ${(config.entry.maxOpenPositions * config.entry.solPerTrade).toFixed(2)} SOL.`);
  }
  return warnings;
}
