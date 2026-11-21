/**
 * src/lib/autopilot/sources.ts — Sumber kandidat token untuk Auto-Pilot.
 *
 * 1. Jupiter Tokens API V2 (lewat /api/jupiter/tokens agar API key tetap di server):
 *    - toptrending / toptraded per interval → daftar mint + data organik & audit
 *    - search?query=mint1,mint2,… → melengkapi data kandidat dari sumber lain
 * 2. DexScreener (langsung dari browser, CORS terbuka, sudah ada di CSP):
 *    - /metas/trending/v1 → meta/narasi yang sedang naik → /metas/meta/v1/{slug} → pair
 *    - /token-boosts/top/v1 → token yang sedang di-boost (promosi berbayar)
 *    - /tokens/v1/solana/{≤30 mint} → data market yang SAMA dengan price feed
 *
 * Semua respons dibaca secara defensif: format yang tidak dikenal = dilewati, bukan crash.
 */

import { DEXSCREENER_API_URL, HttpError, WSOL_MINT, fetchJson } from "../rpc";
import { normalizeDexScreenerPairs, type MarketData } from "../scanner";
import { getTerminalAccessKey } from "../swap";
import type { JupiterInterval } from "./config";

export type SourceId = "jup-trending" | "jup-traded" | "dex-metas" | "dex-boosts";

export const SOURCE_LABEL: Readonly<Record<SourceId, string>> = {
  "jup-trending": "Jupiter Trending",
  "jup-traded": "Jupiter Top Traded",
  "dex-metas": "DexScreener Metas",
  "dex-boosts": "DexScreener Boosts",
};

/** Mint yang tidak pernah dijadikan kandidat (SOL, stablecoin, LST besar). */
export const EXCLUDED_MINTS: ReadonlySet<string> = new Set([
  WSOL_MINT.toBase58(),
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB", // USD1
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", // PYUSD
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", // mSOL
  "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", // JitoSOL
  "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v", // JupSOL
  "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1", // bSOL
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", // JUP
]);

// ===========================================================================
// Jupiter Tokens API V2
// ===========================================================================

export interface JupiterWindowStats {
  priceChange: number | null;
  holderChange: number | null;
  liquidityChange: number | null;
  volumeChange: number | null;
  buyVolume: number | null;
  sellVolume: number | null;
  buyOrganicVolume: number | null;
  sellOrganicVolume: number | null;
  numBuys: number | null;
  numSells: number | null;
  numTraders: number | null;
  numOrganicBuyers: number | null;
  numNetBuyers: number | null;
}

export interface JupiterTokenInfo {
  mint: string;
  symbol: string | null;
  name: string | null;
  icon: string | null;
  organicScore: number | null;
  organicScoreLabel: string | null;
  isVerified: boolean;
  holderCount: number | null;
  mcap: number | null;
  liquidity: number | null;
  usdPrice: number | null;
  devBalancePct: number | null;
  topHoldersPct: number | null;
  /** Jupiter menandai token ini mencurigakan (field ada = ditandai). */
  isSus: boolean;
  mintAuthorityDisabled: boolean | null;
  freezeAuthorityDisabled: boolean | null;
  launchpad: string | null;
  firstPoolCreatedAt: number | null;
  tags: string[];
  stats5m: JupiterWindowStats | null;
  stats1h: JupiterWindowStats | null;
  stats6h: JupiterWindowStats | null;
}

function n(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function s(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readStats(value: unknown): JupiterWindowStats | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  return {
    priceChange: n(v.priceChange),
    holderChange: n(v.holderChange),
    liquidityChange: n(v.liquidityChange),
    volumeChange: n(v.volumeChange),
    buyVolume: n(v.buyVolume),
    sellVolume: n(v.sellVolume),
    buyOrganicVolume: n(v.buyOrganicVolume),
    sellOrganicVolume: n(v.sellOrganicVolume),
    numBuys: n(v.numBuys),
    numSells: n(v.numSells),
    numTraders: n(v.numTraders),
    numOrganicBuyers: n(v.numOrganicBuyers),
    numNetBuyers: n(v.numNetBuyers),
  };
}

/** Normalisasi satu objek token Jupiter. Null bila tidak ada `id` mint. */
export function normalizeJupiterToken(value: unknown): JupiterTokenInfo | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const mint = s(v.id);
  if (!mint) return null;
  const audit = (v.audit && typeof v.audit === "object" ? v.audit : {}) as Record<string, unknown>;
  const firstPool = (v.firstPool && typeof v.firstPool === "object" ? v.firstPool : {}) as Record<string, unknown>;
  const firstPoolCreated = s(firstPool.createdAt);
  const firstPoolMs = firstPoolCreated ? Date.parse(firstPoolCreated) : NaN;
  return {
    mint,
    symbol: s(v.symbol),
    name: s(v.name),
    icon: s(v.icon),
    organicScore: n(v.organicScore),
    organicScoreLabel: s(v.organicScoreLabel),
    isVerified: v.isVerified === true,
    holderCount: n(v.holderCount),
    mcap: n(v.mcap),
    liquidity: n(v.liquidity),
    usdPrice: n(v.usdPrice),
    devBalancePct: n(audit.devBalancePercentage),
    topHoldersPct: n(audit.topHoldersPercentage),
    isSus: "isSus" in audit && audit.isSus !== false && audit.isSus !== null,
    mintAuthorityDisabled: typeof audit.mintAuthorityDisabled === "boolean" ? audit.mintAuthorityDisabled : null,
    freezeAuthorityDisabled: typeof audit.freezeAuthorityDisabled === "boolean" ? audit.freezeAuthorityDisabled : null,
    launchpad: s(v.launchpad),
    firstPoolCreatedAt: Number.isFinite(firstPoolMs) ? firstPoolMs : null,
    tags: Array.isArray(v.tags) ? v.tags.filter((tag): tag is string => typeof tag === "string") : [],
    stats5m: readStats(v.stats5m),
    stats1h: readStats(v.stats1h),
    stats6h: readStats(v.stats6h),
  };
}

export function normalizeJupiterTokenList(payload: unknown): JupiterTokenInfo[] {
  const list = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : [];
  return list.map(normalizeJupiterToken).filter((token): token is JupiterTokenInfo => token !== null);
}

function apiHeaders(): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  const accessKey = getTerminalAccessKey();
  if (accessKey) headers["x-terminal-key"] = accessKey;
  return headers;
}

function describeError(error: unknown): string {
  if (error instanceof HttpError) {
    if (error.status === 401) return "kunci akses terminal salah/kosong (ikon 🔑)";
    if (error.status === 429) return "dibatasi (HTTP 429)";
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export class SourceError extends Error {
  readonly rateLimited: boolean;
  constructor(message: string, rateLimited: boolean) {
    super(message);
    this.name = "SourceError";
    this.rateLimited = rateLimited;
  }
}

function wrap(error: unknown): SourceError {
  return new SourceError(describeError(error), error instanceof HttpError && error.status === 429);
}

export async function fetchJupiterCategory(
  category: "toptrending" | "toptraded",
  interval: JupiterInterval,
  limit = 50,
): Promise<JupiterTokenInfo[]> {
  try {
    const payload = await fetchJson<unknown>(
      `/api/jupiter/tokens?category=${category}&interval=${interval}&limit=${limit}`,
      { headers: apiHeaders(), timeoutMs: 9_000 },
    );
    return normalizeJupiterTokenList(payload);
  } catch (error) {
    throw wrap(error);
  }
}

export async function fetchJupiterTokensByMints(mints: readonly string[]): Promise<JupiterTokenInfo[]> {
  const unique = [...new Set(mints)].slice(0, 100);
  if (unique.length === 0) return [];
  try {
    const payload = await fetchJson<unknown>(`/api/jupiter/tokens?mints=${unique.join(",")}`, {
      headers: apiHeaders(),
      timeoutMs: 9_000,
    });
    return normalizeJupiterTokenList(payload);
  } catch (error) {
    throw wrap(error);
  }
}

// ===========================================================================
// DexScreener
// ===========================================================================

/** Ambil mint Solana dari daftar pair (dipakai untuk respons meta). */
export function solanaBaseMintsFromPairs(pairs: unknown): string[] {
  if (!Array.isArray(pairs)) return [];
  const mints: string[] = [];
  for (const pair of pairs) {
    if (!pair || typeof pair !== "object") continue;
    const p = pair as { chainId?: unknown; baseToken?: { address?: unknown } };
    if (p.chainId !== "solana") continue;
    const address = p.baseToken?.address;
    if (typeof address === "string" && address.length >= 32) mints.push(address);
  }
  return [...new Set(mints)];
}

export function trendingMetaSlugs(payload: unknown, count: number): string[] {
  const list = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { metas?: unknown }).metas)
      ? (payload as { metas: unknown[] }).metas
      : [];
  const slugs: string[] = [];
  for (const item of list) {
    const slug = item && typeof item === "object" ? (item as { slug?: unknown }).slug : null;
    if (typeof slug === "string" && /^[a-z0-9-]{1,80}$/i.test(slug)) slugs.push(slug);
    if (slugs.length >= count) break;
  }
  return slugs;
}

export async function fetchDexTrendingMetaMints(metaCount: number): Promise<string[]> {
  try {
    const metas = await fetchJson<unknown>(`${DEXSCREENER_API_URL}/metas/trending/v1`, {
      timeoutMs: 6_000,
      headers: { accept: "application/json" },
    });
    const slugs = trendingMetaSlugs(metas, metaCount);
    const results = await Promise.allSettled(
      slugs.map((slug) =>
        fetchJson<unknown>(`${DEXSCREENER_API_URL}/metas/meta/v1/${encodeURIComponent(slug)}`, {
          timeoutMs: 6_000,
          headers: { accept: "application/json" },
        }),
      ),
    );
    const mints = new Set<string>();
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      const pairs = result.value && typeof result.value === "object" ? (result.value as { pairs?: unknown }).pairs : null;
      for (const mint of solanaBaseMintsFromPairs(pairs)) mints.add(mint);
    }
    return [...mints];
  } catch (error) {
    throw wrap(error);
  }
}

export function boostedSolanaMints(payload: unknown): string[] {
  if (!Array.isArray(payload)) return [];
  const mints: string[] = [];
  for (const item of payload) {
    if (!item || typeof item !== "object") continue;
    const entry = item as { chainId?: unknown; tokenAddress?: unknown };
    if (entry.chainId === "solana" && typeof entry.tokenAddress === "string") mints.push(entry.tokenAddress);
  }
  return [...new Set(mints)];
}

export async function fetchDexBoostMints(): Promise<string[]> {
  try {
    const payload = await fetchJson<unknown>(`${DEXSCREENER_API_URL}/token-boosts/top/v1`, {
      timeoutMs: 6_000,
      headers: { accept: "application/json" },
    });
    return boostedSolanaMints(payload);
  } catch (error) {
    throw wrap(error);
  }
}

/** Data market DexScreener untuk banyak mint sekaligus (≤30 per request). */
export async function fetchMarketBatch(mints: readonly string[], now = Date.now()): Promise<Map<string, MarketData>> {
  const unique = [...new Set(mints)];
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += 30) chunks.push(unique.slice(i, i + 30));
  const out = new Map<string, MarketData>();
  const results = await Promise.allSettled(
    chunks.map((chunk) =>
      fetchJson<unknown>(`${DEXSCREENER_API_URL}/tokens/v1/solana/${chunk.join(",")}`, {
        timeoutMs: 7_000,
        headers: { accept: "application/json" },
      }).then((payload) => ({ chunk, payload })),
    ),
  );
  let firstError: unknown = null;
  for (const result of results) {
    if (result.status === "rejected") {
      firstError ??= result.reason;
      continue;
    }
    for (const mint of result.value.chunk) {
      const market = normalizeDexScreenerPairs(mint, result.value.payload, now);
      if (market) out.set(mint, market);
    }
  }
  if (out.size === 0 && firstError && unique.length > 0) throw wrap(firstError);
  return out;
}
