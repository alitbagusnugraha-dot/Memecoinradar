/**
 * GET /api/jupiter/tokens — proxy ke Jupiter Tokens API V2 (dipakai Auto-Pilot).
 *
 * Dua bentuk query yang diizinkan:
 *   ?category=toptrending|toptraded|toporganicscore&interval=5m|1h|6h|24h&limit=1..100
 *   ?mints=<mint1>,<mint2>,…   (maks. 100 mint, untuk melengkapi data kandidat)
 *
 * JUPITER_API_KEY hanya ada di server. Kuota Jupiter (tier gratis 60 request/menit,
 * jendela geser 60 detik) DIPAKAI BERSAMA dengan /build untuk Buy/Sell, jadi
 * Auto-Pilot hanya memanggil route ini 1–2 kali per siklus (default tiap 45 detik).
 */

import "server-only";
import { checkTerminalAccess, isBase58Address, jsonError, jupiterAuthMessage } from "@/lib/server/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CATEGORIES = new Set(["toptrending", "toptraded", "toporganicscore"]);
const INTERVALS = new Set(["5m", "1h", "6h", "24h"]);
const MAX_MINTS = 100;

export async function GET(request: Request): Promise<Response> {
  const denied = checkTerminalAccess(request);
  if (denied) return denied;

  const apiKey = process.env.JUPITER_API_KEY?.trim();
  if (!apiKey) return jsonError("JUPITER_API_KEY belum diisi di environment server.", 500);

  const baseUrl = (process.env.JUPITER_TOKENS_API_BASE_URL || "https://api.jup.ag/tokens/v2").replace(/\/+$/, "");
  const params = new URL(request.url).searchParams;

  let upstreamUrl: string;
  const mintsParam = params.get("mints");
  if (mintsParam !== null) {
    const mints = [...new Set(mintsParam.split(",").map((value) => value.trim()).filter(Boolean))];
    if (mints.length === 0 || mints.length > MAX_MINTS) {
      return jsonError(`mints harus berisi 1–${MAX_MINTS} alamat.`, 400);
    }
    if (!mints.every((mint) => isBase58Address(mint))) {
      return jsonError("Semua mints harus alamat Base58 yang valid.", 400);
    }
    upstreamUrl = `${baseUrl}/search?query=${mints.join(",")}`;
  } else {
    const category = params.get("category") ?? "";
    const interval = params.get("interval") ?? "";
    const limit = Number(params.get("limit") ?? "50");
    if (!CATEGORIES.has(category)) return jsonError("category harus toptrending, toptraded, atau toporganicscore.", 400);
    if (!INTERVALS.has(interval)) return jsonError("interval harus 5m, 1h, 6h, atau 24h.", 400);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return jsonError("limit harus 1–100.", 400);
    upstreamUrl = `${baseUrl}/${category}/${interval}?limit=${limit}`;
  }

  try {
    const upstream = await fetch(upstreamUrl, {
      method: "GET",
      headers: { "x-api-key": apiKey, accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (upstream.status === 401 || upstream.status === 403) {
      return jsonError(jupiterAuthMessage(upstream.status), 502);
    }
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "application/json",
        "Cache-Control": "no-store, max-age=0",
      },
    });
  } catch (error) {
    const isTimeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return jsonError(
      isTimeout ? "Jupiter Tokens API timeout (8 detik)." : `Gagal menghubungi Jupiter Tokens API: ${String(error)}`,
      isTimeout ? 504 : 502,
    );
  }
}
