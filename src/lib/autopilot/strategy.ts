/**
 * src/lib/autopilot/strategy.ts — Filter & skor kandidat (fungsi murni, mudah diuji).
 *
 * Gaya (b) "momentum token yang sudah berjalan":
 *   - pair sudah berumur beberapa jam (bukan token baru lahir),
 *   - likuiditas & market cap dalam rentang wajar,
 *   - volume 1 jam terakhir NAIK dibanding rata-rata per jam selama 6 jam,
 *   - harga naik tapi belum parabolik, 5 menit terakhir tidak sedang dibuang,
 *   - lebih banyak transaksi beli daripada jual,
 *   - (opsional) volume terbukti organik menurut Jupiter, bukan bot.
 *
 * Skor 0–100 hanya dipakai untuk MENGURUTKAN kandidat yang sudah lolos semua filter.
 */

import { formatPct, formatUsdCompact } from "../format";
import type { MarketData, RiskLevel, TokenScanResult } from "../scanner";
import type { FilterConfig, SecurityConfig } from "./config";
import type { JupiterTokenInfo, SourceId } from "./sources";

export interface CandidateMetrics {
  ageHours: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  volume5mUsd: number | null;
  volume1hUsd: number | null;
  volume6hUsd: number | null;
  /** volume 1 jam ÷ rata-rata volume per jam selama (≤6) jam terakhir. */
  volumeAccel: number | null;
  /** (volume 5 menit × 12) ÷ volume 1 jam — apakah aktivitas masih berlanjut SEKARANG. */
  freshness: number | null;
  priceChange5m: number | null;
  priceChange1h: number | null;
  priceChange6h: number | null;
  buys1h: number;
  sells1h: number;
  buySellRatio1h: number | null;
  txns1h: number;
  organicScore: number | null;
  organicScoreLabel: string | null;
  holderCount: number | null;
  holderChange1h: number | null;
  volumeChange1h: number | null;
  devBalancePct: number | null;
  isSus: boolean;
}

export interface ScoreBreakdown {
  accel: number;
  buyPressure: number;
  momentum: number;
  freshness: number;
  organic: number;
  holders: number;
  total: number;
}

export interface CandidateEvaluation {
  mint: string;
  symbol: string;
  name: string | null;
  imageUrl: string | null;
  sources: SourceId[];
  market: MarketData;
  jupiter: JupiterTokenInfo | null;
  metrics: CandidateMetrics;
  failures: string[];
  pass: boolean;
  score: ScoreBreakdown;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function computeMetrics(market: MarketData, jupiter: JupiterTokenInfo | null, now = Date.now()): CandidateMetrics {
  const ageHours =
    market.pairCreatedAt !== null ? Math.max(0, (now - market.pairCreatedAt) / 3_600_000) : jupiter?.firstPoolCreatedAt ? Math.max(0, (now - jupiter.firstPoolCreatedAt) / 3_600_000) : null;
  const vol1h = market.volumeUsd.h1;
  const vol6h = market.volumeUsd.h6;
  const vol5m = market.volumeUsd.m5;

  // Pair yang umurnya < 6 jam: volume "6 jam" sebenarnya hanya mencakup umur pair.
  const hoursCovered = ageHours !== null ? Math.min(6, Math.max(1, ageHours)) : 6;
  const avgHourly = vol6h !== null && vol6h > 0 ? vol6h / hoursCovered : null;
  const volumeAccel = vol1h !== null && avgHourly !== null && avgHourly > 0 ? vol1h / avgHourly : null;
  const freshness = vol5m !== null && vol1h !== null && vol1h > 0 ? (vol5m * 12) / vol1h : null;

  const buys1h = market.txns.h1.buys;
  const sells1h = market.txns.h1.sells;
  const buySellRatio1h = buys1h + sells1h > 0 ? buys1h / Math.max(1, sells1h) : null;

  return {
    ageHours,
    liquidityUsd: market.liquidityUsd,
    marketCapUsd: market.marketCapUsd ?? market.fdvUsd,
    volume5mUsd: vol5m,
    volume1hUsd: vol1h,
    volume6hUsd: vol6h,
    volumeAccel,
    freshness,
    priceChange5m: market.priceChangePct.m5,
    priceChange1h: market.priceChangePct.h1,
    priceChange6h: market.priceChangePct.h6,
    buys1h,
    sells1h,
    buySellRatio1h,
    txns1h: buys1h + sells1h,
    organicScore: jupiter?.organicScore ?? null,
    organicScoreLabel: jupiter?.organicScoreLabel ?? null,
    holderCount: jupiter?.holderCount ?? null,
    holderChange1h: jupiter?.stats1h?.holderChange ?? null,
    volumeChange1h: jupiter?.stats1h?.volumeChange ?? null,
    devBalancePct: jupiter?.devBalancePct ?? null,
    isSus: jupiter?.isSus ?? false,
  };
}

export function computeScore(metrics: CandidateMetrics): ScoreBreakdown {
  const accel = metrics.volumeAccel !== null ? clamp01((metrics.volumeAccel - 1) / 2) * 30 : 0;
  const buyPressure = metrics.buySellRatio1h !== null ? clamp01(metrics.buySellRatio1h - 1) * 20 : 0;
  const momentum = metrics.priceChange1h !== null ? clamp01(metrics.priceChange1h / 40) * 15 : 0;
  const freshness = metrics.freshness !== null ? clamp01(metrics.freshness / 1.5) * 10 : 0;
  const organic = metrics.organicScore !== null ? clamp01(metrics.organicScore / 100) * 15 : 0;
  const holders = metrics.holderChange1h !== null ? clamp01(metrics.holderChange1h / 10) * 10 : 0;
  const total = accel + buyPressure + momentum + freshness + organic + holders;
  return {
    accel: round(accel),
    buyPressure: round(buyPressure),
    momentum: round(momentum),
    freshness: round(freshness),
    organic: round(organic),
    holders: round(holders),
    total: round(total),
  };
}

/** Evaluasi satu kandidat terhadap filter market. Tidak termasuk cek keamanan on-chain. */
export function evaluateCandidate(params: {
  market: MarketData;
  jupiter: JupiterTokenInfo | null;
  sources: SourceId[];
  filters: FilterConfig;
  now?: number;
}): CandidateEvaluation {
  const { market, jupiter, filters } = params;
  const metrics = computeMetrics(market, jupiter, params.now);
  const failures: string[] = [];
  const fail = (message: string) => failures.push(message);

  if (market.isBondingCurve) fail(`masih bonding curve (${market.dexId})`);

  if (metrics.ageHours === null) fail("umur pair tidak diketahui");
  else if (metrics.ageHours < filters.minPairAgeHours) fail(`umur ${round(metrics.ageHours)}j < ${filters.minPairAgeHours}j`);
  else if (metrics.ageHours > filters.maxPairAgeHours) fail(`umur ${round(metrics.ageHours)}j > ${filters.maxPairAgeHours}j`);

  if (metrics.liquidityUsd === null) fail("likuiditas tidak diketahui");
  else if (metrics.liquidityUsd < filters.minLiquidityUsd) fail(`lik. ${formatUsdCompact(metrics.liquidityUsd)} < ${formatUsdCompact(filters.minLiquidityUsd)}`);

  if (metrics.marketCapUsd === null) fail("market cap tidak diketahui");
  else if (metrics.marketCapUsd < filters.minMarketCapUsd) fail(`MC ${formatUsdCompact(metrics.marketCapUsd)} < ${formatUsdCompact(filters.minMarketCapUsd)}`);
  else if (metrics.marketCapUsd > filters.maxMarketCapUsd) fail(`MC ${formatUsdCompact(metrics.marketCapUsd)} > ${formatUsdCompact(filters.maxMarketCapUsd)}`);

  if (metrics.volume1hUsd === null) fail("volume 1j tidak diketahui");
  else if (metrics.volume1hUsd < filters.minVolume1hUsd) fail(`vol 1j ${formatUsdCompact(metrics.volume1hUsd)} < ${formatUsdCompact(filters.minVolume1hUsd)}`);

  if (filters.minVolumeAccel > 0) {
    if (metrics.volumeAccel === null) fail("akselerasi volume tidak diketahui");
    else if (metrics.volumeAccel < filters.minVolumeAccel) fail(`volume tidak naik (${round(metrics.volumeAccel, 2)}× < ${filters.minVolumeAccel}×)`);
  }

  if (metrics.priceChange1h === null) fail("Δ1j tidak diketahui");
  else if (metrics.priceChange1h < filters.minPriceChange1hPct) fail(`Δ1j ${formatPct(metrics.priceChange1h, 1)} < ${formatPct(filters.minPriceChange1hPct, 0)}`);
  else if (metrics.priceChange1h > filters.maxPriceChange1hPct) fail(`Δ1j ${formatPct(metrics.priceChange1h, 1)} terlalu parabolik`);

  if (metrics.priceChange5m === null) fail("Δ5m tidak diketahui");
  else if (metrics.priceChange5m < filters.minPriceChange5mPct) fail(`Δ5m ${formatPct(metrics.priceChange5m, 1)} sedang turun`);
  else if (metrics.priceChange5m > filters.maxPriceChange5mPct) fail(`Δ5m ${formatPct(metrics.priceChange5m, 1)} lilin vertikal`);

  if (metrics.buySellRatio1h === null) fail("tidak ada transaksi 1j");
  else if (metrics.buySellRatio1h < filters.minBuySellRatio1h) fail(`beli/jual ${round(metrics.buySellRatio1h, 2)} < ${filters.minBuySellRatio1h}`);

  if (metrics.txns1h < filters.minTxns1h) fail(`${metrics.txns1h} tx/1j < ${filters.minTxns1h}`);

  if (!jupiter) {
    if (filters.requireJupiterData) fail("tidak ada data Jupiter");
  } else {
    if (jupiter.isSus) fail("ditandai mencurigakan oleh Jupiter");
    if (jupiter.mintAuthorityDisabled === false) fail("mint authority aktif (Jupiter)");
    if (jupiter.freezeAuthorityDisabled === false) fail("freeze authority aktif (Jupiter)");
    if (filters.minOrganicScore > 0) {
      if (metrics.organicScore === null) fail("skor organik tidak tersedia");
      else if (metrics.organicScore < filters.minOrganicScore) fail(`organik ${Math.round(metrics.organicScore)} < ${filters.minOrganicScore}`);
    }
    if (filters.maxDevBalancePct < 100 && metrics.devBalancePct !== null && metrics.devBalancePct > filters.maxDevBalancePct) {
      fail(`dev pegang ${round(metrics.devBalancePct)}% > ${filters.maxDevBalancePct}%`);
    }
  }

  const score = computeScore(metrics);
  if (failures.length === 0 && score.total < filters.minScore) fail(`skor ${Math.round(score.total)} < ${filters.minScore}`);

  return {
    mint: market.mint,
    symbol: market.symbol || jupiter?.symbol || `${market.mint.slice(0, 4)}…`,
    name: market.name || jupiter?.name || null,
    imageUrl: market.imageUrl ?? jupiter?.icon ?? null,
    sources: params.sources,
    market,
    jupiter,
    metrics,
    failures,
    pass: failures.length === 0,
    score,
  };
}

/** Urutkan: lolos dulu, lalu skor tertinggi, lalu volume 1 jam terbesar. */
export function rankCandidates(list: CandidateEvaluation[]): CandidateEvaluation[] {
  return [...list].sort((a, b) => {
    if (a.pass !== b.pass) return a.pass ? -1 : 1;
    if (b.score.total !== a.score.total) return b.score.total - a.score.total;
    return (b.metrics.volume1hUsd ?? 0) - (a.metrics.volume1hUsd ?? 0);
  });
}

// ===========================================================================
// Keamanan on-chain (hasil scanToken)
// ===========================================================================

export interface SecurityVerdict {
  pass: boolean;
  level: RiskLevel;
  label: string;
  reasons: string[];
  top10Pct: number | null;
  largestHolderPct: number | null;
  checkedAt: number;
}

export function evaluateSecurity(scan: TokenScanResult, config: SecurityConfig): SecurityVerdict {
  const reasons: string[] = [];
  const level = scan.risk.level;
  const top10Pct = scan.holders?.top10PercentExcludingPools ?? null;
  const largestHolderPct = scan.holders?.largestNonPoolPercent ?? null;

  if (!scan.security) reasons.push("cek mint on-chain gagal");
  if (!scan.holders) reasons.push("analisis holder gagal");
  if (level === "danger" || level === "warning" || level === "unknown") {
    const worst = scan.risk.flags.find((flag) => flag.severity === "critical" || flag.severity === "high");
    reasons.push(`${scan.risk.label}${worst ? `: ${worst.title}` : ""}`);
  } else if (level === "caution" && !config.allowCaution) {
    const medium = scan.risk.flags.find((flag) => flag.severity === "medium");
    reasons.push(`WASPADA${medium ? `: ${medium.title}` : ""}`);
  }
  if (top10Pct !== null && top10Pct > config.maxTop10Pct) reasons.push(`top10 ${round(top10Pct)}% > ${config.maxTop10Pct}%`);
  if (largestHolderPct !== null && largestHolderPct > config.maxSingleHolderPct) {
    reasons.push(`whale ${round(largestHolderPct)}% > ${config.maxSingleHolderPct}%`);
  }

  return {
    pass: reasons.length === 0,
    level,
    label: scan.risk.label,
    reasons: [...new Set(reasons)],
    top10Pct,
    largestHolderPct,
    checkedAt: scan.scannedAt,
  };
}
