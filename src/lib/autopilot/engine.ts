/**
 * src/lib/autopilot/engine.ts — Mesin Auto-Pilot.
 *
 * Satu instance (singleton) yang berjalan selama tab terminal terbuka:
 *
 *   SIKLUS PENEMUAN (default tiap 45 dtk, hanya saat Auto-Pilot "Berjalan"):
 *     1. Ambil kandidat dari Jupiter Trending/Top Traded + DexScreener Metas/Boosts.
 *     2. Data market DexScreener (sumber yang sama dengan price feed & PnL).
 *     3. Lengkapi data organik/audit Jupiter untuk kandidat dari DexScreener.
 *     4. Filter & skor (strategy.ts) → cek keamanan on-chain (scanToken) untuk yang lolos.
 *     5. Kandidat harus lolos N siklus berturut-turut (konfirmasi).
 *     6. Rem pengaman (guardrails.ts) → maksimal 1 entry per siklus.
 *        LATIHAN : beli simulasi (paper.ts).  UANG ASLI : performBuy() + aturan Auto TP/SL.
 *
 *   PENGELOLAAN POSISI (selalu aktif, juga saat Auto-Pilot dihentikan):
 *     - Latihan  : TP/SL/trailing dievaluasi tiap tick harga (2 dtk) dengan aturan yang
 *                  SAMA PERSIS dengan mesin uang asli (auto-sell-eval.ts), plus batas waktu.
 *     - Uang asli: TP/SL/trailing dijalankan mesin Auto TP/SL yang sudah ada (useAutoSell);
 *                  mesin ini menangani batas waktu tahan, stop darurat, dan pencatatan hasil.
 */

import { CONFIRM_TICKS, PRICE_STALE_MS, evaluateRule } from "../auto-sell-eval";
import { formatPct, formatSol } from "../format";
import { subscribeHeartbeat } from "../heartbeat";
import { getPriceSol, priceFeed, type PriceSnapshot } from "../price-feed";
import { NotATokenMintError, toError } from "../rpc";
import { scanToken, type MarketData } from "../scanner";
import { playAlert } from "../sound";
import { performBuy, performSell } from "../trade-actions";
import type { PositionRow } from "@/hooks/usePositions";
import { paperCashSol, useAutoPilotStore } from "@/store/autopilot-store";
import { useAutoSellStore, ruleKey } from "@/store/auto-sell-store";
import { useJournalStore, type TradeRecord } from "@/store/journal-store";
import { pushToast } from "@/store/toast-store";
import { useTradeStore, type TradeSource } from "@/store/trade-store";
import type { AutoPilotConfig } from "./config";
import { checkEntryCapacity, checkStopRules, type GuardrailInput } from "./guardrails";
import {
  applyPaperExit,
  buildRuleState,
  estimateTxCostSol,
  lpFeePctForDex,
  markToMarket,
  newId,
  poolSolReserve,
  simulateBuy,
  type CostModel,
} from "./paper";
import {
  EXCLUDED_MINTS,
  SourceError,
  fetchDexBoostMints,
  fetchDexTrendingMetaMints,
  fetchJupiterCategory,
  fetchJupiterTokensByMints,
  fetchMarketBatch,
  type JupiterTokenInfo,
  type SourceId,
} from "./sources";
import { consecutiveLosses, localDayKey, tradesOnDay } from "./stats";
import { evaluateCandidate, evaluateSecurity, rankCandidates, type CandidateEvaluation, type SecurityVerdict } from "./strategy";
import { EXIT_LABEL, type ClosedTrade, type ExitKind, type LivePosition, type PaperPosition, type SignalSnapshot } from "./types";

// ===========================================================================
// Konstanta
// ===========================================================================

const MAX_CANDIDATE_MINTS = 90;
const MAX_VIEW_CANDIDATES = 40;
const SCAN_CACHE_MS = 20 * 60_000;
const SCAN_ERROR_CACHE_MS = 3 * 60_000;
const RATE_LIMIT_BACKOFF_MS = 30_000;
const LIVE_CLOSE_CONFIRM_MS = 12_000;
const LIVE_BOOKKEEPING_INTERVAL_MS = 3_000;
const LIVE_EXIT_RETRY_MS = 30_000;
const MAX_LIVE_EXIT_ATTEMPTS = 3;
const MAX_CONSECUTIVE_BUY_FAILURES = 3;
const BUY_FAILURE_COOLDOWN_MS = 30 * 60_000;
const PAPER_PRICE_MAX_AGE_FOR_TIMESTOP_MS = 5 * 60_000;
const LOCKED_WARNING_INTERVAL_MS = 60_000;

// ===========================================================================
// Tipe publik
// ===========================================================================

export interface EngineContext {
  wallet: string | null;
  walletUnlocked: boolean;
  walletSol: number | null;
  positions: PositionRow[];
  positionsUpdatedAt: number | null;
  positionsLoading: boolean;
  positionsError: string | null;
  autoSellEngineEnabled: boolean;
}

export type CandidateStatus =
  | "fail"
  | "security-pending"
  | "security-fail"
  | "confirming"
  | "ready"
  | "bought"
  | "held"
  | "cooldown"
  | "blacklisted";

export interface CandidateView {
  mint: string;
  symbol: string;
  imageUrl: string | null;
  sources: SourceId[];
  evaluation: CandidateEvaluation;
  security: SecurityVerdict | null;
  status: CandidateStatus;
  statusText: string;
  confirmations: number;
}

export interface SourceStatus {
  id: SourceId;
  enabled: boolean;
  ok: boolean | null;
  count: number;
  error: string | null;
  at: number | null;
}

export interface PositionMark {
  priceSol: number | null;
  valueSol: number | null;
  pnlSol: number | null;
  pnlPct: number | null;
  stale: boolean;
  nextTakeProfitPct: number | null;
  stopLossPct: number | null;
  trailingArmed: boolean;
  updatedAt: number;
}

export type EnginePhase = "idle" | "discovering" | "scanning" | "buying";

export interface EngineView {
  phase: EnginePhase;
  phaseText: string;
  cycleCount: number;
  lastCycleAt: number | null;
  lastCycleMs: number | null;
  nextCycleAt: number | null;
  sources: SourceStatus[];
  candidates: CandidateView[];
  totalCandidates: number;
  passedCount: number;
  entryBlockedReason: string | null;
  lastError: string | null;
  paperMarks: Record<string, PositionMark>;
  liveMarks: Record<string, PositionMark>;
  todayRealizedSol: number;
  todayUnrealizedSol: number;
  busyMints: string[];
}

const SOURCE_IDS: SourceId[] = ["jup-trending", "jup-traded", "dex-metas", "dex-boosts"];

function initialSources(): SourceStatus[] {
  return SOURCE_IDS.map((id) => ({ id, enabled: false, ok: null, count: 0, error: null, at: null }));
}

const INITIAL_VIEW: EngineView = {
  phase: "idle",
  phaseText: "Menunggu",
  cycleCount: 0,
  lastCycleAt: null,
  lastCycleMs: null,
  nextCycleAt: null,
  sources: initialSources(),
  candidates: [],
  totalCandidates: 0,
  passedCount: 0,
  entryBlockedReason: null,
  lastError: null,
  paperMarks: {},
  liveMarks: {},
  todayRealizedSol: 0,
  todayUnrealizedSol: 0,
  busyMints: [],
};

// ===========================================================================
// Helper
// ===========================================================================

function signalFrom(candidate: CandidateEvaluation, security: SecurityVerdict | null): SignalSnapshot {
  const m = candidate.metrics;
  return {
    score: candidate.score.total,
    ageHours: m.ageHours,
    liquidityUsd: m.liquidityUsd,
    marketCapUsd: m.marketCapUsd,
    volume1hUsd: m.volume1hUsd,
    volumeAccel: m.volumeAccel,
    buySellRatio1h: m.buySellRatio1h,
    priceChange1h: m.priceChange1h,
    priceChange5m: m.priceChange5m,
    organicScore: m.organicScore,
    top10Pct: security?.top10Pct ?? null,
    largestHolderPct: security?.largestHolderPct ?? null,
    riskLabel: security?.label ?? "—",
    sources: candidate.sources,
  };
}

function exitKindFromSource(source: TradeSource | undefined, pending: ExitKind | undefined): ExitKind {
  if (pending) return pending;
  switch (source) {
    case "auto-tp":
      return "take-profit";
    case "auto-sl":
      return "stop-loss";
    case "auto-trailing":
      return "trailing";
    case "autopilot-exit":
      return "time-stop";
    case "panic":
    case "manual":
      return "manual";
    default:
      return "external";
  }
}

function notifySystem(title: string, body: string): void {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (document.visibilityState !== "hidden" || Notification.permission !== "granted") return;
  try {
    new Notification(title, { body, tag: "smt-autopilot" });
  } catch {
    // beberapa browser mobile hanya mengizinkan notifikasi lewat service worker
  }
}

// ===========================================================================
// Engine
// ===========================================================================

class AutoPilotEngine {
  private refCount = 0;
  private unsubscribeHeartbeat: (() => void) | null = null;
  private unsubscribePrice: (() => void) | null = null;
  private releaseTracking: (() => void) | null = null;
  private trackedKey = "";

  private context: EngineContext = {
    wallet: null,
    walletUnlocked: false,
    walletSol: null,
    positions: [],
    positionsUpdatedAt: null,
    positionsLoading: true,
    positionsError: null,
    autoSellEngineEnabled: true,
  };

  private view: EngineView = INITIAL_VIEW;
  private listeners = new Set<() => void>();

  private cycleInFlight = false;
  private nextCycleAt = 0;
  private lastPriceTick = -1;
  private lastLiveBookkeepingAt = 0;
  private lastLockedWarningAt = 0;
  private consecutiveBuyFailures = 0;

  private scanCache = new Map<string, { verdict: SecurityVerdict | null; error: string | null; at: number }>();
  private confirmations = new Map<string, { count: number; cycle: number }>();
  private paperConfirm = new Map<string, number>();
  private paperLastSeenFetch = new Map<string, number>();
  private liveMissingSince = new Map<string, number>();
  private liveExitInFlight = new Set<string>();
  private liveExitAttempts = new Map<string, { count: number; lastAt: number }>();
  private livePendingReason = new Map<string, ExitKind>();
  private busy = new Set<string>();

  // ---------------------------------------------------------------- lifecycle

  readonly attach = (): (() => void) => {
    this.refCount += 1;
    if (this.refCount === 1 && typeof window !== "undefined") {
      this.unsubscribeHeartbeat = subscribeHeartbeat((now) => this.onHeartbeat(now));
      this.unsubscribePrice = priceFeed.subscribe(() => this.onPriceSnapshot(priceFeed.getSnapshot()));
      this.nextCycleAt = Date.now() + 1_500;
    }
    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      this.refCount -= 1;
      if (this.refCount === 0) {
        this.unsubscribeHeartbeat?.();
        this.unsubscribePrice?.();
        this.releaseTracking?.();
        this.unsubscribeHeartbeat = null;
        this.unsubscribePrice = null;
        this.releaseTracking = null;
        this.trackedKey = "";
      }
    };
  };

  readonly setContext = (context: EngineContext): void => {
    this.context = context;
  };

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getView = (): EngineView => this.view;
  readonly getServerView = (): EngineView => INITIAL_VIEW;

  private publish(patch: Partial<EngineView>): void {
    this.view = { ...this.view, ...patch, busyMints: [...this.busy] };
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.error("[autopilot] listener error", error);
      }
    }
  }

  // ---------------------------------------------------------------- aksi user

  /** Satu siklus penemuan TANPA membeli — untuk mengkalibrasi filter. */
  readonly scanOnce = async (): Promise<void> => {
    if (this.cycleInFlight) return;
    await this.runCycle({ allowEntries: false });
  };

  /** Mulai siklus berikutnya secepatnya (dipanggil setelah tombol Mulai). */
  readonly kick = (): void => {
    this.nextCycleAt = Date.now();
  };

  /** Tutup satu posisi sekarang (latihan: harga pasar; uang asli: jual 100%). */
  readonly closePosition = async (mode: "paper" | "live", id: string, kind: ExitKind = "manual"): Promise<void> => {
    if (mode === "paper") {
      this.closePaperNow(id, kind);
      return;
    }
    const position = useAutoPilotStore.getState().livePositions.find((item) => item.id === id);
    if (position) await this.sellLive(position, kind);
  };

  /** STOP DARURAT: hentikan Auto-Pilot dan tutup SEMUA posisi Auto-Pilot. */
  readonly emergencyStop = async (): Promise<void> => {
    const store = useAutoPilotStore.getState();
    store.pause("STOP DARURAT ditekan: Auto-Pilot dimatikan dan semua posisinya ditutup.");
    playAlert("trigger");
    for (const position of store.paperPositions) this.closePaperNow(position.id, "kill");
    const wallet = this.context.wallet;
    const live = useAutoPilotStore.getState().livePositions.filter((position) => position.wallet === wallet);
    if (live.length > 0 && !this.context.walletUnlocked) {
      pushToast({
        kind: "error",
        title: "Stop darurat: wallet TERKUNCI",
        message: `${live.length} posisi uang asli belum terjual. Buka kunci wallet lalu tekan Stop darurat lagi, atau Panic Sell di tabel Posisi.`,
        durationMs: 15_000,
      });
      return;
    }
    // Berurutan agar tidak menabrak batas 1 request/detik Jupiter.
    for (const position of live) {
      await this.sellLive(position, "kill");
    }
  };

  // ---------------------------------------------------------------- heartbeat

  private onHeartbeat(now: number): void {
    this.syncPriceTracking();
    this.checkPaperTimeStops(now);

    if (now - this.lastLiveBookkeepingAt >= LIVE_BOOKKEEPING_INTERVAL_MS) {
      this.lastLiveBookkeepingAt = now;
      this.liveBookkeeping(now);
    }

    const state = useAutoPilotStore.getState();
    if (state.running && !this.cycleInFlight && now >= this.nextCycleAt) {
      void this.runCycle({ allowEntries: true });
    } else if (!state.running && this.view.nextCycleAt !== null && !this.cycleInFlight) {
      this.publish({ nextCycleAt: null, phase: "idle", phaseText: "Berhenti" });
    }
  }

  private syncPriceTracking(): void {
    const state = useAutoPilotStore.getState();
    const mints = new Set<string>();
    for (const position of state.paperPositions) mints.add(position.mint);
    for (const position of state.livePositions) mints.add(position.mint);
    const key = [...mints].sort().join(",");
    if (key === this.trackedKey) return;
    this.releaseTracking?.();
    this.releaseTracking = key ? priceFeed.track(key.split(",")) : null;
    this.trackedKey = key;
  }

  // ---------------------------------------------------------------- biaya simulasi

  private costModel(dexId: string, config: AutoPilotConfig): CostModel {
    return {
      lpFeePct: lpFeePctForDex(dexId),
      latencyPenaltyPct: config.paper.latencyPenaltyPct,
      txCostSol: estimateTxCostSol(config.fees),
    };
  }

  // ---------------------------------------------------------------- posisi latihan

  private onPriceSnapshot(snapshot: PriceSnapshot): void {
    if (snapshot.tick === this.lastPriceTick) return;
    this.lastPriceTick = snapshot.tick;
    const now = Date.now();
    const store = useAutoPilotStore.getState();
    const config = store.config;
    const paperMarks: Record<string, PositionMark> = {};

    for (const original of store.paperPositions) {
      let position = original;
      const market = snapshot.prices[position.mint];
      const priceSol = getPriceSol(market, snapshot.solUsd);
      if (!market || priceSol === null) {
        paperMarks[position.id] = this.view.paperMarks[position.id]
          ? { ...this.view.paperMarks[position.id]!, stale: true }
          : emptyMark(now);
        continue;
      }
      const stale = now - market.fetchedAt > PRICE_STALE_MS;
      const poolSol = poolSolReserve(market.liquidityUsd, snapshot.solUsd);
      const model = this.costModel(position.dexId, config);
      const evaluation = evaluateRule(position.rule, priceSol, position.entryPriceSol);
      const mark = markToMarket(position, priceSol, poolSol, model);

      let changed = false;
      if (evaluation.trailingUpdate && position.rule.trailing) {
        position = { ...position, rule: { ...position.rule, trailing: { ...position.rule.trailing, ...evaluation.trailingUpdate } } };
        changed = true;
      }
      if (mark.pnlPct !== null && (mark.pnlPct > position.maxPnlPct || mark.pnlPct < position.minPnlPct)) {
        position = { ...position, maxPnlPct: Math.max(position.maxPnlPct, mark.pnlPct), minPnlPct: Math.min(position.minPnlPct, mark.pnlPct) };
        changed = true;
      }
      if (position.lastPriceAt !== market.fetchedAt) {
        position = { ...position, lastPriceSol: priceSol, lastPriceAt: market.fetchedAt };
        changed = true;
      }

      paperMarks[position.id] = {
        priceSol,
        valueSol: mark.valueSol,
        pnlSol: mark.pnlSol,
        pnlPct: mark.pnlPct,
        stale,
        nextTakeProfitPct: evaluation.nextTakeProfit?.triggerPct ?? null,
        stopLossPct: position.rule.stopLoss && !position.rule.stopLoss.done ? position.rule.stopLoss.triggerPct : null,
        trailingArmed: evaluation.trailingArmed,
        updatedAt: now,
      };

      const action = stale ? null : evaluation.action;
      const isFresh = this.paperLastSeenFetch.get(position.id) !== market.fetchedAt;
      this.paperLastSeenFetch.set(position.id, market.fetchedAt);

      if (!action) {
        this.clearPaperConfirm(position.id);
        if (changed) store.replacePaper(position);
        continue;
      }
      const counterKey = `${position.id}|${action.kind}|${action.levelId ?? ""}`;
      const count = (this.paperConfirm.get(counterKey) ?? 0) + (isFresh ? 1 : 0);
      this.paperConfirm.set(counterKey, count);
      if (count < CONFIRM_TICKS[action.kind]) {
        if (changed) store.replacePaper(position);
        continue;
      }
      this.clearPaperConfirm(position.id);
      this.executePaperExit(position, {
        kind: action.kind,
        levelId: action.levelId,
        sellPct: action.sellPct,
        priceSol,
        poolSol,
        model,
        reason: action.reason,
      });
    }

    const liveMarks = this.computeLiveMarks(snapshot, now);
    this.publish({ paperMarks, liveMarks, ...this.todayPnl(paperMarks, liveMarks) });
  }

  private clearPaperConfirm(positionId: string): void {
    for (const key of [...this.paperConfirm.keys()]) {
      if (key.startsWith(`${positionId}|`)) this.paperConfirm.delete(key);
    }
  }

  private executePaperExit(
    position: PaperPosition,
    params: { kind: ExitKind; levelId: string | null; sellPct: number; priceSol: number; poolSol: number | null; model: CostModel; reason: string },
  ): void {
    const store = useAutoPilotStore.getState();
    const now = Date.now();
    const result = applyPaperExit(position, { ...params, at: now });
    const label = EXIT_LABEL[params.kind];

    if (result.closed) {
      store.closePaper(position.id, result.closed);
      store.setCooldown(position.mint, now + store.config.entry.reentryCooldownMinutes * 60_000);
      this.paperLastSeenFetch.delete(position.id);
      const trade = result.closed;
      store.addLog(
        "sell",
        `[Latihan] ${label} ${position.symbol}: ${params.reason}. Posisi ditutup, PnL ${formatSol(trade.pnlSol, 5)} SOL (${formatPct(trade.pnlPct, 1)}).`,
        position.mint,
      );
      pushToast({
        kind: trade.pnlSol >= 0 ? "take-profit" : "stop-loss",
        title: `Latihan · ${label} · ${position.symbol}`,
        message: `PnL ${formatSol(trade.pnlSol, 5)} SOL (${formatPct(trade.pnlPct, 1)})`,
        durationMs: 5_000,
      });
      this.afterTradeClosed();
    } else {
      store.replacePaper(result.position);
      store.addLog(
        "sell",
        `[Latihan] ${label} ${position.symbol}: ${params.reason}. Jual ${params.sellPct}% → ${formatSol(result.fill.proceedsSol, 5)} SOL.`,
        position.mint,
      );
      pushToast({
        kind: "take-profit",
        title: `Latihan · ${label} · ${position.symbol}`,
        message: `Jual ${params.sellPct}% → ${formatSol(result.fill.proceedsSol, 5)} SOL`,
        durationMs: 4_000,
      });
    }
  }

  private closePaperNow(id: string, kind: ExitKind): void {
    const store = useAutoPilotStore.getState();
    const position = store.paperPositions.find((item) => item.id === id);
    if (!position) return;
    const snapshot = priceFeed.getSnapshot();
    const market = snapshot.prices[position.mint];
    const livePrice = getPriceSol(market, snapshot.solUsd);
    const priceSol = livePrice ?? position.lastPriceSol ?? position.signalPriceSol;
    const poolSol = poolSolReserve(market?.liquidityUsd ?? position.signal.liquidityUsd, snapshot.solUsd);
    this.executePaperExit(position, {
      kind,
      levelId: null,
      sellPct: 100,
      priceSol,
      poolSol,
      model: this.costModel(position.dexId, store.config),
      reason: livePrice === null ? "harga live tidak tersedia, memakai harga terakhir" : EXIT_LABEL[kind],
    });
  }

  private checkPaperTimeStops(now: number): void {
    const store = useAutoPilotStore.getState();
    for (const position of store.paperPositions) {
      if (position.maxHoldMinutes <= 0) continue;
      if (now - position.openedAt < position.maxHoldMinutes * 60_000) continue;
      const snapshot = priceFeed.getSnapshot();
      const market = snapshot.prices[position.mint];
      const livePrice = market && now - market.fetchedAt <= PRICE_STALE_MS ? getPriceSol(market, snapshot.solUsd) : null;
      const recentPrice =
        position.lastPriceSol !== null && position.lastPriceAt !== null && now - position.lastPriceAt <= PAPER_PRICE_MAX_AGE_FOR_TIMESTOP_MS
          ? position.lastPriceSol
          : null;
      const priceSol = livePrice ?? recentPrice;
      const model = this.costModel(position.dexId, store.config);
      if (priceSol === null) {
        // Tidak ada harga lebih dari 5 menit (pair hilang dari DexScreener / rug):
        // asumsi konservatif — posisi dianggap tidak bernilai.
        this.executePaperExit(position, {
          kind: "time-stop",
          levelId: null,
          sellPct: 100,
          priceSol: Number.MIN_VALUE,
          poolSol: null,
          model,
          reason: "batas waktu tercapai dan harga tidak tersedia — dianggap 0 (konservatif)",
        });
        continue;
      }
      this.executePaperExit(position, {
        kind: "time-stop",
        levelId: null,
        sellPct: 100,
        priceSol,
        poolSol: poolSolReserve(market?.liquidityUsd ?? null, snapshot.solUsd),
        model,
        reason: `ditahan ${position.maxHoldMinutes} menit`,
      });
    }
  }

  // ---------------------------------------------------------------- posisi uang asli

  private computeLiveMarks(snapshot: PriceSnapshot, now: number): Record<string, PositionMark> {
    const marks: Record<string, PositionMark> = {};
    const state = useAutoPilotStore.getState();
    const rows = new Map(this.context.positions.map((row) => [row.mint, row]));
    const trades = useJournalStore.getState().trades;
    for (const position of state.livePositions) {
      const row = rows.get(position.mint);
      const market = snapshot.prices[position.mint];
      const priceSol = getPriceSol(market, snapshot.solUsd) ?? row?.priceSol ?? null;
      // Sisa token & SOL hasil jual dihitung dari jurnal (langsung ter-update setelah
      // transaksi confirmed), bukan dari saldo on-chain yang di-refresh tiap 10 detik —
      // agar tidak ada hitungan ganda sesaat setelah TP menjual sebagian.
      const ledger = positionLedger(trades, position);
      const valueSol =
        ledger.hasBuy && priceSol !== null ? ledger.remainingUi * priceSol : row?.valueSol ?? null;
      const soldSol = ledger.soldSol;
      const pnlSol = valueSol !== null ? soldSol + valueSol - position.costSol : null;
      const rule = useAutoSellStore.getState().rules[ruleKey(position.wallet, position.mint)];
      marks[position.id] = {
        priceSol,
        valueSol,
        pnlSol,
        pnlPct: pnlSol !== null && position.costSol > 0 ? (pnlSol / position.costSol) * 100 : null,
        stale: market ? now - market.fetchedAt > PRICE_STALE_MS : true,
        nextTakeProfitPct: rule?.takeProfits.find((level) => !level.done)?.triggerPct ?? null,
        stopLossPct: rule?.stopLoss && !rule.stopLoss.done ? rule.stopLoss.triggerPct : null,
        trailingArmed: rule?.trailing?.armed ?? false,
        updatedAt: now,
      };
      if (marks[position.id]!.pnlPct !== null) {
        const pnlPct = marks[position.id]!.pnlPct!;
        if (pnlPct > position.maxPnlPct || pnlPct < position.minPnlPct) {
          state.updateLive(position.id, { maxPnlPct: Math.max(position.maxPnlPct, pnlPct), minPnlPct: Math.min(position.minPnlPct, pnlPct) });
        }
      }
    }
    return marks;
  }

  private liveBookkeeping(now: number): void {
    const ctx = this.context;
    const state = useAutoPilotStore.getState();
    const mine = state.livePositions.filter((position) => position.wallet === ctx.wallet);
    if (mine.length === 0) return;

    const activeTrades = Object.values(useTradeStore.getState().active);
    const holdingsFresh = ctx.positionsUpdatedAt !== null && !ctx.positionsLoading && ctx.positionsError === null;
    const rows = new Map(ctx.positions.map((row) => [row.mint, row]));

    for (const position of mine) {
      const busy = activeTrades.some((trade) => trade.mint === position.mint) || this.liveExitInFlight.has(position.id);
      const row = rows.get(position.mint);

      // --- 1. Deteksi posisi sudah habis terjual (oleh TP/SL, panic, atau dari luar)
      if (holdingsFresh && !busy && (ctx.positionsUpdatedAt ?? 0) > position.openedAt + 5_000) {
        if (!row || row.balanceRaw <= 0n) {
          const since = this.liveMissingSince.get(position.id) ?? now;
          this.liveMissingSince.set(position.id, since);
          if (now - since >= LIVE_CLOSE_CONFIRM_MS) {
            this.finalizeLiveClose(position, now);
            continue;
          }
        } else {
          this.liveMissingSince.delete(position.id);
        }
      }

      // --- 2. Batas waktu tahan
      if (position.maxHoldMinutes > 0 && now - position.openedAt >= position.maxHoldMinutes * 60_000 && !busy && row && row.balanceRaw > 0n) {
        const attempts = this.liveExitAttempts.get(position.id);
        if (attempts && (attempts.count >= MAX_LIVE_EXIT_ATTEMPTS || now - attempts.lastAt < LIVE_EXIT_RETRY_MS)) continue;
        if (!ctx.walletUnlocked) {
          if (now - this.lastLockedWarningAt > LOCKED_WARNING_INTERVAL_MS) {
            this.lastLockedWarningAt = now;
            state.addLog("warn", `${position.symbol}: batas waktu tercapai tapi wallet TERKUNCI — tidak bisa menjual.`, position.mint);
            pushToast({ kind: "error", title: "Auto-Pilot: wallet terkunci", message: `${position.symbol} melewati batas waktu tahan. Buka kunci wallet.` });
          }
          continue;
        }
        void this.sellLive(position, "time-stop");
      }
    }
  }

  private finalizeLiveClose(position: LivePosition, now: number): void {
    const trades = useJournalStore
      .getState()
      .trades.filter((trade) => trade.wallet === position.wallet && trade.mint === position.mint && trade.timestamp >= position.openedAt - 120_000);
    const buyLamports = trades.filter((trade) => trade.side === "buy").reduce((sum, trade) => sum + BigInt(trade.solLamports), 0n);
    const sellLamports = trades.filter((trade) => trade.side === "sell").reduce((sum, trade) => sum + BigInt(trade.solLamports), 0n);
    const lastSell = [...trades].filter((trade) => trade.side === "sell").sort((a, b) => b.timestamp - a.timestamp)[0];
    const costSol = buyLamports > 0n ? Number(buyLamports) / 1e9 : position.costSol;
    const proceedsSol = Number(sellLamports) / 1e9;
    const pnlSol = proceedsSol - costSol;
    const reason = exitKindFromSource(lastSell?.source, this.livePendingReason.get(position.mint));

    const closed: ClosedTrade = {
      id: position.id,
      mode: "live",
      mint: position.mint,
      symbol: position.symbol,
      openedAt: position.openedAt,
      closedAt: lastSell?.timestamp ?? now,
      costSol,
      proceedsSol,
      pnlSol,
      pnlPct: costSol > 0 ? (pnlSol / costSol) * 100 : 0,
      holdMinutes: ((lastSell?.timestamp ?? now) - position.openedAt) / 60_000,
      closeReason: reason,
      exits: [],
      signal: position.signal,
      maxPnlPct: position.maxPnlPct,
      minPnlPct: position.minPnlPct,
      estimated: trades.some((trade) => trade.estimated) || !lastSell,
    };

    const store = useAutoPilotStore.getState();
    store.closeLive(position.id, closed);
    store.setCooldown(position.mint, now + store.config.entry.reentryCooldownMinutes * 60_000);
    const key = ruleKey(position.wallet, position.mint);
    if (useAutoSellStore.getState().rules[key]?.enabled) useAutoSellStore.getState().setEnabled(key, false);
    this.liveMissingSince.delete(position.id);
    this.liveExitAttempts.delete(position.id);
    this.livePendingReason.delete(position.mint);

    store.addLog(
      "sell",
      `${position.symbol} ditutup (${EXIT_LABEL[reason]}): PnL ${formatSol(pnlSol, 5)} SOL (${formatPct(closed.pnlPct, 1)})${closed.estimated ? " · sebagian estimasi" : ""}.`,
      position.mint,
    );
    notifySystem("Auto-Pilot: posisi ditutup", `${position.symbol}: ${formatSol(pnlSol, 5)} SOL (${formatPct(closed.pnlPct, 1)})`);
    this.afterTradeClosed();
  }

  private async sellLive(position: LivePosition, kind: ExitKind): Promise<void> {
    if (this.liveExitInFlight.has(position.id)) return;
    const store = useAutoPilotStore.getState();
    if (!this.context.walletUnlocked) {
      store.addLog("warn", `${position.symbol}: tidak bisa menjual (${EXIT_LABEL[kind]}) — wallet terkunci.`, position.mint);
      return;
    }
    this.liveExitInFlight.add(position.id);
    this.busy.add(position.mint);
    this.publish({});
    this.livePendingReason.set(position.mint, kind);
    const attempts = this.liveExitAttempts.get(position.id) ?? { count: 0, lastAt: 0 };
    this.liveExitAttempts.set(position.id, { count: attempts.count + 1, lastAt: Date.now() });

    store.addLog("info", `${position.symbol}: menjual 100% (${EXIT_LABEL[kind]})…`, position.mint);
    try {
      const outcome = await performSell({
        mint: position.mint,
        percent: 100,
        symbol: position.symbol,
        source: kind === "kill" ? "panic" : "autopilot-exit",
        settingsOverride: {
          slippageBps: store.config.exit.exitSlippageBps,
          priorityFeeSol: store.config.fees.priorityFeeSol,
          tipSol: store.config.fees.tipSol,
        },
      });
      if (!outcome.ok) {
        if (outcome.error.code === "NO_TOKEN_BALANCE") {
          // Saldo sudah 0 → biarkan deteksi penutupan yang mencatat hasilnya.
          return;
        }
        this.livePendingReason.delete(position.mint);
        const left = MAX_LIVE_EXIT_ATTEMPTS - (attempts.count + 1);
        store.addLog(
          "error",
          `${position.symbol}: jual gagal (${outcome.error.message}).${left > 0 && kind === "time-stop" ? ` Dicoba lagi dalam 30 dtk (${left}x lagi).` : ""}`,
          position.mint,
        );
        if (left <= 0 && kind === "time-stop") {
          pushToast({
            kind: "error",
            title: `Auto-Pilot: ${position.symbol} gagal dijual 3x`,
            message: "Batas waktu tidak bisa dieksekusi. Aturan Auto TP/SL tetap aktif — periksa slippage/saldo SOL atau jual manual.",
            durationMs: 15_000,
          });
        }
      }
    } finally {
      this.liveExitInFlight.delete(position.id);
      this.busy.delete(position.mint);
      this.publish({});
    }
  }

  // ---------------------------------------------------------------- setelah trade tutup

  private afterTradeClosed(): void {
    const state = useAutoPilotStore.getState();
    if (!state.running) return;
    const input = this.guardrailInput();
    const stop = checkStopRules(input);
    if (!stop.ok) {
      state.pause(stop.reason);
      playAlert("error");
      pushToast({ kind: "error", title: "Auto-Pilot berhenti otomatis", message: stop.reason, durationMs: 20_000 });
      notifySystem("Auto-Pilot berhenti otomatis", stop.reason);
    }
  }

  private todayPnl(paperMarks: Record<string, PositionMark>, liveMarks: Record<string, PositionMark>): { todayRealizedSol: number; todayUnrealizedSol: number } {
    const state = useAutoPilotStore.getState();
    const today = localDayKey(Date.now());
    const realized = tradesOnDay(state.closed.filter((trade) => trade.mode === state.mode), today).reduce((sum, trade) => sum + trade.pnlSol, 0);
    const marks = state.mode === "paper" ? paperMarks : liveMarks;
    const unrealized = Object.values(marks).reduce((sum, mark) => sum + (mark.pnlSol ?? 0), 0);
    return { todayRealizedSol: realized, todayUnrealizedSol: unrealized };
  }

  /** Data untuk rem pengaman, dihitung dari state terbaru. */
  guardrailInput(): GuardrailInput {
    const state = useAutoPilotStore.getState();
    const now = Date.now();
    const today = localDayKey(now);
    const mode = state.mode;
    const closedMode = state.closed.filter((trade) => trade.mode === mode);
    const openOpenedAt =
      mode === "paper"
        ? state.paperPositions.map((position) => position.openedAt)
        : state.livePositions.filter((position) => position.wallet === this.context.wallet).map((position) => position.openedAt);
    const allOpenedAt = [...openOpenedAt, ...closedMode.map((trade) => trade.openedAt)];
    const marks = mode === "paper" ? this.view.paperMarks : this.view.liveMarks;
    const { todayRealizedSol } = this.todayPnl(this.view.paperMarks, this.view.liveMarks);
    return {
      config: state.config,
      mode,
      openPositions: openOpenedAt.length,
      openedLastHour: allOpenedAt.filter((ts) => now - ts < 3_600_000).length,
      openedToday: allOpenedAt.filter((ts) => localDayKey(ts) === today).length,
      realizedTodaySol: todayRealizedSol,
      unrealizedOpenSol: Object.values(marks).reduce((sum, mark) => sum + (mark.pnlSol ?? 0), 0),
      consecutiveLosses: consecutiveLosses(closedMode, state.streakResetAt),
      paperCashSol: paperCashSol(state),
      hasWallet: this.context.wallet !== null,
      walletUnlocked: this.context.walletUnlocked,
      walletSol: this.context.walletSol,
      autoSellEngineEnabled: this.context.autoSellEngineEnabled,
      swapCost: state.config.fees,
    };
  }

  // ---------------------------------------------------------------- siklus penemuan

  private async runCycle(options: { allowEntries: boolean }): Promise<void> {
    if (this.cycleInFlight) return;
    this.cycleInFlight = true;
    const started = Date.now();
    const store = useAutoPilotStore.getState();
    const config = store.config;
    this.nextCycleAt = started + config.discoveryIntervalSec * 1_000;
    const cycle = this.view.cycleCount + 1;
    this.publish({ phase: "discovering", phaseText: "Mencari kandidat…", nextCycleAt: this.nextCycleAt, lastError: null });

    try {
      // ---- 1. Sumber kandidat
      const sourceMap = new Map<string, Set<SourceId>>();
      const jupInfo = new Map<string, JupiterTokenInfo>();
      const addMint = (mint: string, source: SourceId) => {
        if (EXCLUDED_MINTS.has(mint)) return;
        const set = sourceMap.get(mint) ?? new Set<SourceId>();
        set.add(source);
        sourceMap.set(mint, set);
      };

      const sources: SourceStatus[] = SOURCE_IDS.map((id) => ({
        id,
        enabled:
          (id === "jup-trending" && config.sources.jupiterTrending) ||
          (id === "jup-traded" && config.sources.jupiterTopTraded) ||
          (id === "dex-metas" && config.sources.dexTrendingMetas) ||
          (id === "dex-boosts" && config.sources.dexBoosts),
        ok: null,
        count: 0,
        error: null,
        at: null,
      }));

      let rateLimited = false;
      let jupiterAuthBroken = false;
      const runSource = async (id: SourceId, task: () => Promise<{ mints: string[]; infos?: JupiterTokenInfo[] }>) => {
        const status = sources.find((item) => item.id === id)!;
        if (!status.enabled) return;
        try {
          const { mints, infos } = await task();
          for (const info of infos ?? []) jupInfo.set(info.mint, info);
          for (const mint of mints) addMint(mint, id);
          Object.assign(status, { ok: true, count: mints.length, error: null, at: Date.now() });
        } catch (error) {
          const message = toError(error).message;
          if (error instanceof SourceError && error.rateLimited) rateLimited = true;
          if (/JUPITER_API_KEY|kunci akses/.test(message) && id.startsWith("jup")) jupiterAuthBroken = true;
          Object.assign(status, { ok: false, count: 0, error: message, at: Date.now() });
        }
      };

      await Promise.all([
        runSource("jup-trending", async () => {
          const infos = await fetchJupiterCategory("toptrending", config.sources.jupiterInterval, 60);
          return { mints: infos.map((info) => info.mint), infos };
        }),
        runSource("jup-traded", async () => {
          const infos = await fetchJupiterCategory("toptraded", config.sources.jupiterInterval, 60);
          return { mints: infos.map((info) => info.mint), infos };
        }),
        runSource("dex-metas", async () => ({ mints: await fetchDexTrendingMetaMints(config.sources.dexMetaCount) })),
        runSource("dex-boosts", async () => ({ mints: await fetchDexBoostMints() })),
      ]);

      if (rateLimited) this.nextCycleAt += RATE_LIMIT_BACKOFF_MS;
      this.reportSourceErrors(sources);

      // Mint dari Jupiter didahulukan (punya data organik), lalu sisanya.
      const allMints = [...sourceMap.keys()].sort((a, b) => Number(jupInfo.has(b)) - Number(jupInfo.has(a))).slice(0, MAX_CANDIDATE_MINTS);
      if (allMints.length === 0) {
        this.publish({
          sources,
          candidates: [],
          totalCandidates: 0,
          passedCount: 0,
          lastError: sources.some((item) => item.enabled && item.ok === false) ? "Semua sumber kandidat gagal di siklus ini." : null,
        });
        return;
      }

      // ---- 2. Data market DexScreener
      const markets = await fetchMarketBatch(allMints);

      // ---- 3. Lengkapi data Jupiter (1 request, ≤100 mint)
      const needJupiter = (config.filters.minOrganicScore > 0 || config.filters.requireJupiterData || config.sources.jupiterTrending || config.sources.jupiterTopTraded) && !jupiterAuthBroken;
      const missing = [...markets.keys()].filter((mint) => !jupInfo.has(mint));
      if (needJupiter && missing.length > 0) {
        try {
          for (const info of await fetchJupiterTokensByMints(missing)) jupInfo.set(info.mint, info);
        } catch (error) {
          if (error instanceof SourceError && error.rateLimited) this.nextCycleAt += RATE_LIMIT_BACKOFF_MS;
        }
      }

      // ---- 4. Filter & skor
      const now = Date.now();
      const evaluations = rankCandidates(
        [...markets.values()].map((market: MarketData) =>
          evaluateCandidate({
            market,
            jupiter: jupInfo.get(market.mint) ?? null,
            sources: [...(sourceMap.get(market.mint) ?? [])],
            filters: config.filters,
            now,
          }),
        ),
      );

      const latest = useAutoPilotStore.getState();
      const heldMints = new Set([
        ...latest.paperPositions.map((position) => position.mint),
        ...latest.livePositions.map((position) => position.mint),
        ...this.context.positions.filter((row) => row.balanceRaw > 0n).map((row) => row.mint),
      ]);
      const blacklist = new Set(latest.blacklist);

      // ---- 5. Cek keamanan on-chain untuk kandidat yang lolos
      this.publish({ phase: "scanning", phaseText: "Cek keamanan on-chain…" });
      let scansLeft = config.maxScansPerCycle;
      for (const candidate of evaluations) {
        if (!candidate.pass || scansLeft <= 0) continue;
        if (heldMints.has(candidate.mint) || blacklist.has(candidate.mint) || (latest.cooldowns[candidate.mint] ?? 0) > now) continue;
        const cached = this.scanCache.get(candidate.mint);
        const ttl = cached?.error ? SCAN_ERROR_CACHE_MS : SCAN_CACHE_MS;
        if (cached && now - cached.at < ttl) continue;
        scansLeft -= 1;
        try {
          const scan = await scanToken(candidate.mint);
          this.scanCache.set(candidate.mint, { verdict: evaluateSecurity(scan, config.security), error: null, at: Date.now() });
        } catch (error) {
          if (error instanceof NotATokenMintError) {
            latest.addBlacklist(candidate.mint);
            this.scanCache.set(candidate.mint, { verdict: null, error: "bukan mint token", at: Date.now() });
          } else {
            this.scanCache.set(candidate.mint, { verdict: null, error: toError(error).message, at: Date.now() });
          }
        }
      }

      // ---- 6. Status & konfirmasi
      const needed = config.entry.confirmCycles;
      const views: CandidateView[] = evaluations.map((evaluation) => {
        const mint = evaluation.mint;
        const cached = this.scanCache.get(mint);
        const security = cached?.verdict ?? null;
        const base = { mint, symbol: evaluation.symbol, imageUrl: evaluation.imageUrl, sources: evaluation.sources, evaluation, security };

        if (blacklist.has(mint)) return { ...base, status: "blacklisted" as const, statusText: "Daftar hitam", confirmations: 0 };
        if (heldMints.has(mint)) return { ...base, status: "held" as const, statusText: "Sudah dipegang", confirmations: 0 };
        const cooldownUntil = latest.cooldowns[mint] ?? 0;
        if (cooldownUntil > now) {
          return { ...base, status: "cooldown" as const, statusText: `Jeda ${Math.ceil((cooldownUntil - now) / 60_000)} mnt`, confirmations: 0 };
        }
        if (!evaluation.pass) {
          this.confirmations.delete(mint);
          return { ...base, status: "fail" as const, statusText: evaluation.failures[0] ?? "tidak lolos", confirmations: 0 };
        }
        if (!cached) return { ...base, status: "security-pending" as const, statusText: "Antre cek keamanan", confirmations: 0 };
        if (cached.error || !security) {
          return { ...base, status: "security-fail" as const, statusText: `Cek gagal: ${cached.error ?? "tidak diketahui"}`, confirmations: 0 };
        }
        if (!security.pass) {
          this.confirmations.delete(mint);
          return { ...base, status: "security-fail" as const, statusText: security.reasons[0] ?? security.label, confirmations: 0 };
        }
        const previous = this.confirmations.get(mint);
        const count = previous && previous.cycle === cycle - 1 ? previous.count + 1 : previous && previous.cycle === cycle ? previous.count : 1;
        this.confirmations.set(mint, { count, cycle });
        if (count < needed) return { ...base, status: "confirming" as const, statusText: `Konfirmasi ${count}/${needed}`, confirmations: count };
        return { ...base, status: "ready" as const, statusText: "Siap beli", confirmations: count };
      });

      // Buang counter konfirmasi untuk mint yang tidak muncul lagi.
      for (const [mint, value] of [...this.confirmations.entries()]) {
        if (value.cycle < cycle - 1) this.confirmations.delete(mint);
      }

      // ---- 7. Entry
      let entryBlockedReason: string | null = null;
      const ready = views.filter((item) => item.status === "ready");
      if (!options.allowEntries) {
        entryBlockedReason = "Scan uji: tidak membeli.";
      } else if (!useAutoPilotStore.getState().running) {
        entryBlockedReason = "Auto-Pilot berhenti.";
      } else {
        const input = this.guardrailInput();
        const stop = checkStopRules(input);
        if (!stop.ok) {
          useAutoPilotStore.getState().pause(stop.reason);
          playAlert("error");
          pushToast({ kind: "error", title: "Auto-Pilot berhenti otomatis", message: stop.reason, durationMs: 20_000 });
          entryBlockedReason = stop.reason;
        } else if (ready.length > 0) {
          const capacity = checkEntryCapacity(input);
          if (!capacity.ok) {
            entryBlockedReason = capacity.reason;
          } else {
            const pick = ready[0]!;
            const bought = await this.openEntry(pick, config);
            if (bought) {
              pick.status = "bought";
              pick.statusText = useAutoPilotStore.getState().mode === "paper" ? "Dibeli (latihan)" : "Dibeli";
              this.confirmations.delete(pick.mint);
            }
          }
        }
      }

      this.publish({
        sources,
        candidates: views.slice(0, MAX_VIEW_CANDIDATES),
        totalCandidates: views.length,
        passedCount: views.filter((item) => item.evaluation.pass).length,
        entryBlockedReason,
      });
    } catch (error) {
      const message = toError(error).message;
      this.publish({ lastError: message });
      useAutoPilotStore.getState().addLog("error", `Siklus gagal: ${message}`);
    } finally {
      this.cycleInFlight = false;
      const finished = Date.now();
      this.publish({
        phase: "idle",
        phaseText: useAutoPilotStore.getState().running ? "Menunggu siklus berikutnya" : "Berhenti",
        cycleCount: cycle,
        lastCycleAt: finished,
        lastCycleMs: finished - started,
        nextCycleAt: useAutoPilotStore.getState().running ? this.nextCycleAt : null,
      });
    }
  }

  private lastSourceErrors = new Map<SourceId, string>();

  private reportSourceErrors(sources: SourceStatus[]): void {
    const store = useAutoPilotStore.getState();
    for (const status of sources) {
      if (!status.enabled) continue;
      const previous = this.lastSourceErrors.get(status.id);
      if (status.ok === false && status.error && status.error !== previous) {
        store.addLog("warn", `Sumber ${status.id} gagal: ${status.error}`);
        this.lastSourceErrors.set(status.id, status.error);
      } else if (status.ok && previous) {
        store.addLog("info", `Sumber ${status.id} pulih.`);
        this.lastSourceErrors.delete(status.id);
      }
    }
  }

  private async openEntry(candidate: CandidateView, config: AutoPilotConfig): Promise<boolean> {
    const store = useAutoPilotStore.getState();
    const evaluation = candidate.evaluation;
    const market = evaluation.market;
    const signal = signalFrom(evaluation, candidate.security);
    const snapshot = priceFeed.getSnapshot();
    const solUsd = snapshot.solUsd;

    if (store.mode === "paper") {
      const priceSol = getPriceSol(market, solUsd);
      if (priceSol === null || !(priceSol > 0)) {
        store.addLog("warn", `[Latihan] ${candidate.symbol}: harga SOL belum tersedia, entry dilewati.`, candidate.mint);
        return false;
      }
      const model = this.costModel(market.dexId, config);
      const poolSol = poolSolReserve(market.liquidityUsd, solUsd);
      const fill = simulateBuy({ solIn: config.entry.solPerTrade, priceSol, poolSol, model });
      const now = Date.now();
      const initialPnlPct = (priceSol / fill.entryPriceSol - 1) * 100;
      const position: PaperPosition = {
        id: newId("paper"),
        mint: candidate.mint,
        symbol: candidate.symbol,
        imageUrl: candidate.imageUrl,
        dexId: market.dexId,
        openedAt: now,
        signalPriceSol: priceSol,
        entryPriceSol: fill.entryPriceSol,
        tokensInitial: fill.tokens,
        tokensRemaining: fill.tokens,
        costSol: fill.costSol,
        costRemainingSol: fill.costSol,
        proceedsSol: 0,
        rule: buildRuleState(config.exit),
        maxHoldMinutes: config.exit.maxHoldMinutes,
        exits: [],
        signal,
        lastPriceSol: priceSol,
        lastPriceAt: market.fetchedAt,
        maxPnlPct: initialPnlPct,
        minPnlPct: initialPnlPct,
      };
      store.openPaper(position);
      store.addLog(
        "buy",
        `[Latihan] BELI ${candidate.symbol} ${formatSol(config.entry.solPerTrade, 4)} SOL · skor ${Math.round(signal.score)} · impact ${fill.impactPct.toFixed(2)}% · biaya ${formatSol(fill.costSol - config.entry.solPerTrade, 5)} SOL.`,
        candidate.mint,
      );
      pushToast({
        kind: "info",
        title: `Latihan · BELI ${candidate.symbol}`,
        message: `${formatSol(config.entry.solPerTrade, 4)} SOL · skor ${Math.round(signal.score)} · vol ${signal.volumeAccel?.toFixed(1) ?? "—"}× naik`,
        durationMs: 5_000,
      });
      return true;
    }

    // ---- Uang asli
    const wallet = this.context.wallet;
    if (!wallet) return false;
    this.publish({ phase: "buying", phaseText: `Membeli ${candidate.symbol}…` });
    this.busy.add(candidate.mint);
    store.addLog("buy", `BELI ${candidate.symbol} ${formatSol(config.entry.solPerTrade, 4)} SOL (skor ${Math.round(signal.score)})…`, candidate.mint);
    try {
      const outcome = await performBuy({
        mint: candidate.mint,
        solAmount: config.entry.solPerTrade,
        symbol: candidate.symbol,
        source: "autopilot",
        settingsOverride: {
          slippageBps: config.entry.buySlippageBps,
          priorityFeeSol: config.fees.priorityFeeSol,
          tipSol: config.fees.tipSol,
        },
      });
      if (!outcome.ok) {
        const latest = useAutoPilotStore.getState();
        latest.setCooldown(candidate.mint, Date.now() + BUY_FAILURE_COOLDOWN_MS);
        if (outcome.error.code !== "WALLET_LOCKED") this.consecutiveBuyFailures += 1;
        latest.addLog("error", `Beli ${candidate.symbol} gagal: ${outcome.error.message}`, candidate.mint);
        if (outcome.error.signature) {
          // Transaksi sudah terkirim tapi hasilnya tidak pasti (mis. konfirmasi timeout).
          // Bila token ternyata masuk, jangan biarkan tanpa pengaman: pasang aturan TP/SL
          // dengan harga masuk perkiraan (harga saat sinyal).
          const approxEntry = getPriceSol(market, solUsd);
          useAutoSellStore.getState().upsertRule({
            wallet,
            mint: candidate.mint,
            symbol: candidate.symbol,
            enabled: true,
            takeProfits: config.exit.takeProfits,
            stopLoss: config.exit.stopLoss,
            trailing: config.exit.trailing,
            slippageBps: config.exit.exitSlippageBps,
            manualEntryPriceSol: approxEntry,
            priorityFeeSol: config.fees.priorityFeeSol,
            tipSol: config.fees.tipSol,
          });
          latest.addLog(
            "warn",
            `${candidate.symbol}: transaksi beli terkirim tapi hasilnya belum pasti. Aturan Auto TP/SL dipasang dengan harga masuk perkiraan sebagai pengaman — cek tabel Posisi.`,
            candidate.mint,
          );
          pushToast({
            kind: "warning",
            title: `Auto-Pilot: hasil beli ${candidate.symbol} belum pasti`,
            message: "Cek tabel Posisi. Bila token masuk, Auto TP/SL sudah terpasang dengan harga masuk perkiraan.",
            durationMs: 15_000,
          });
        }
        if (this.consecutiveBuyFailures >= MAX_CONSECUTIVE_BUY_FAILURES) {
          const reason = `${MAX_CONSECUTIVE_BUY_FAILURES} pembelian gagal berturut-turut (terakhir: ${outcome.error.message}). Periksa API key, saldo, dan slippage.`;
          this.consecutiveBuyFailures = 0;
          latest.pause(reason);
          pushToast({ kind: "error", title: "Auto-Pilot berhenti otomatis", message: reason, durationMs: 20_000 });
        }
        return false;
      }
      this.consecutiveBuyFailures = 0;
      const result = outcome.result;
      const executed = result.executed;
      const costSol = executed
        ? Number(-executed.swapSolLamports + executed.networkFeeLamports + executed.tipLamports) / 1e9
        : Number(result.quote.inAmountRaw + result.fees.priorityFeeLamports + result.fees.tipLamports + 5_000n) / 1e9;
      const tokens = executed ? Math.abs(executed.tokenDeltaUi) : Number(result.quote.outAmountRaw) / 10 ** result.tokenDecimals;

      useAutoSellStore.getState().upsertRule({
        wallet,
        mint: candidate.mint,
        symbol: candidate.symbol,
        enabled: true,
        takeProfits: config.exit.takeProfits,
        stopLoss: config.exit.stopLoss,
        trailing: config.exit.trailing,
        slippageBps: config.exit.exitSlippageBps,
        manualEntryPriceSol: null,
        priorityFeeSol: config.fees.priorityFeeSol,
        tipSol: config.fees.tipSol,
      });

      useAutoPilotStore.getState().addLive({
        id: newId("live"),
        wallet,
        mint: candidate.mint,
        symbol: candidate.symbol,
        imageUrl: candidate.imageUrl,
        openedAt: Date.now(),
        buySignature: result.signature,
        costSol,
        tokens,
        entryPriceSol: tokens > 0 ? costSol / tokens : null,
        maxHoldMinutes: config.exit.maxHoldMinutes,
        signal,
        maxPnlPct: 0,
        minPnlPct: 0,
      });
      useAutoPilotStore
        .getState()
        .addLog("buy", `${candidate.symbol} terbeli: ${formatSol(costSol, 5)} SOL. Auto TP/SL dipasang otomatis.`, candidate.mint);
      notifySystem("Auto-Pilot membeli", `${candidate.symbol}: ${formatSol(costSol, 4)} SOL`);
      return true;
    } finally {
      this.busy.delete(candidate.mint);
    }
  }
}

function emptyMark(now: number): PositionMark {
  return {
    priceSol: null,
    valueSol: null,
    pnlSol: null,
    pnlPct: null,
    stale: true,
    nextTakeProfitPct: null,
    stopLossPct: null,
    trailingArmed: false,
    updatedAt: now,
  };
}

/** Ringkasan jurnal untuk satu posisi uang asli (hanya transaksi sejak posisi dibuka). */
function positionLedger(trades: readonly TradeRecord[], position: LivePosition): { hasBuy: boolean; remainingUi: number; soldSol: number } {
  let tokensRaw = 0n;
  let soldLamports = 0n;
  let decimals = 0;
  let hasBuy = false;
  for (const trade of trades) {
    if (trade.wallet !== position.wallet || trade.mint !== position.mint) continue;
    if (trade.timestamp < position.openedAt - 120_000) continue;
    decimals = trade.decimals;
    if (trade.side === "buy") {
      hasBuy = true;
      tokensRaw += BigInt(trade.tokenRaw);
    } else {
      tokensRaw -= BigInt(trade.tokenRaw);
      soldLamports += BigInt(trade.solLamports);
    }
  }
  if (tokensRaw < 0n) tokensRaw = 0n;
  return { hasBuy, remainingUi: Number(tokensRaw) / 10 ** decimals, soldSol: Number(soldLamports) / 1e9 };
}

export const autopilotEngine = new AutoPilotEngine();
