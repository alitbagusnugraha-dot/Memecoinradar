"use client";

/**
 * Panel Auto-Pilot: kontrol (mode, mulai/berhenti, stop darurat), statistik,
 * kandidat per siklus beserta alasan lolos/gagal, posisi terbuka, riwayat, dan log.
 */

import { useState, type ReactNode } from "react";
import { autopilotEngine, type CandidateStatus, type CandidateView, type EngineView, type PositionMark } from "@/lib/autopilot/engine";
import { checkStopRules } from "@/lib/autopilot/guardrails";
import { SOURCE_LABEL } from "@/lib/autopilot/sources";
import { computeStats, tradesToCsv } from "@/lib/autopilot/stats";
import { EXIT_LABEL, type ClosedTrade, type LogLevel } from "@/lib/autopilot/types";
import { formatCompactNumber, formatPct, formatSol, formatUsdCompact, pnlTone, shortAddress, timeAgo } from "@/lib/format";
import { useNow } from "@/hooks/useNow";
import { paperCashSol, useAutoPilotStore } from "@/store/autopilot-store";
import { pushToast } from "@/store/toast-store";
import { AutoPilotLiveDialog } from "./AutoPilotLiveDialog";
import { AutoPilotSettings } from "./AutoPilotSettings";
import { Badge, Button, Panel, Spinner, Stat, cn } from "./ui";

type Tab = "candidates" | "positions" | "history" | "log";

const STATUS_TONE: Record<CandidateStatus, "up" | "down" | "warn" | "neutral" | "accent"> = {
  fail: "neutral",
  "security-pending": "warn",
  "security-fail": "down",
  confirming: "accent",
  ready: "up",
  bought: "up",
  held: "accent",
  cooldown: "neutral",
  blacklisted: "down",
};

const LOG_TONE: Record<LogLevel, string> = {
  info: "text-muted",
  buy: "text-up",
  sell: "text-accent",
  warn: "text-warn",
  error: "text-down",
  guard: "text-down font-semibold",
};

function Pnl({ value, children }: { value: number | null; children: ReactNode }) {
  const tone = pnlTone(value);
  return <span className={cn("font-mono tabular-nums", tone === "up" && "text-up", tone === "down" && "text-down", tone === "flat" && "text-muted")}>{children}</span>;
}

function fmtNum(value: number | null, digits = 1, suffix = ""): string {
  return value === null || !Number.isFinite(value) ? "—" : `${value.toFixed(digits)}${suffix}`;
}

function minutesLeft(openedAt: number, maxHoldMinutes: number, now: number): string {
  if (maxHoldMinutes <= 0) return "∞";
  const left = Math.max(0, openedAt + maxHoldMinutes * 60_000 - now);
  const minutes = Math.floor(left / 60_000);
  const seconds = Math.floor((left % 60_000) / 1000);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function TokenCell({ symbol, mint, imageUrl, onSelect, selected }: { symbol: string; mint: string; imageUrl: string | null; onSelect: (mint: string) => void; selected: boolean }) {
  return (
    <button type="button" className="flex items-center gap-2 text-left" onClick={() => onSelect(mint)} title="Tampilkan di scanner & grafik">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {imageUrl ? <img src={imageUrl} alt="" className="h-5 w-5 rounded-full" referrerPolicy="no-referrer" /> : <span className="h-5 w-5 rounded-full bg-panel-2" />}
      <span className="flex flex-col leading-tight">
        <span className={cn("font-semibold hover:text-accent", selected ? "text-accent" : "text-fg")}>{symbol}</span>
        <span className="font-mono text-[10px] text-dim">{shortAddress(mint, 4)}</span>
      </span>
    </button>
  );
}

function downloadCsv(trades: ClosedTrade[], label: string): void {
  const blob = new Blob([tradesToCsv(trades)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `autopilot-${label}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2_000);
}

export function AutoPilotPanel({
  view,
  hasWallet,
  walletUnlocked,
  walletSol,
  autoSellEngineEnabled,
  selectedMint,
  onSelectMint,
}: {
  view: EngineView;
  hasWallet: boolean;
  walletUnlocked: boolean;
  walletSol: number | null;
  autoSellEngineEnabled: boolean;
  selectedMint: string | null;
  onSelectMint: (mint: string) => void;
}) {
  const now = useNow();
  const state = useAutoPilotStore();
  const [tab, setTab] = useState<Tab>("candidates");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [liveDialogOpen, setLiveDialogOpen] = useState(false);
  const [killArmedUntil, setKillArmedUntil] = useState(0);
  const [resetArmedUntil, setResetArmedUntil] = useState(0);
  const [scanning, setScanning] = useState(false);

  const { mode, running, config } = state;
  const isLive = mode === "live";
  const modeTrades = state.closed.filter((trade) => trade.mode === mode);
  const stats = computeStats(modeTrades);
  const openPaper = state.paperPositions;
  const openLive = state.livePositions;
  const openCount = isLive ? openLive.length : openPaper.length;
  const todayPnl = view.todayRealizedSol + view.todayUnrealizedSol;
  const cash = paperCashSol(state);
  const busy = view.phase !== "idle";

  const start = () => {
    const stop = checkStopRules(autopilotEngine.guardrailInput());
    if (!stop.ok) {
      pushToast({ kind: "error", title: "Tidak bisa mulai", message: stop.reason, durationMs: 12_000 });
      return;
    }
    if (isLive) {
      if (!hasWallet) return void pushToast({ kind: "error", title: "Belum ada wallet", message: "Generate atau import burner wallet dulu." });
      if (!walletUnlocked) return void pushToast({ kind: "error", title: "Wallet terkunci", message: "Buka kunci wallet agar Auto-Pilot bisa menandatangani transaksi." });
      if (!autoSellEngineEnabled) {
        return void pushToast({ kind: "error", title: "Mesin Auto TP/SL mati", message: "Nyalakan mesin Auto TP/SL di panel Trade — tanpa itu posisi tidak punya pengaman jual." });
      }
    }
    state.start();
    autopilotEngine.kick();
    if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "default") {
      void Notification.requestPermission().catch(() => undefined);
    }
  };

  const kill = () => {
    if (killArmedUntil < Date.now()) {
      setKillArmedUntil(Date.now() + 4_000);
      return;
    }
    setKillArmedUntil(0);
    void autopilotEngine.emergencyStop();
  };

  const scanOnce = async () => {
    setScanning(true);
    try {
      await autopilotEngine.scanOnce();
      setTab("candidates");
    } finally {
      setScanning(false);
    }
  };

  const switchMode = () => {
    if (isLive) state.setMode("paper");
    else setLiveDialogOpen(true);
  };

  const headerRight = (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      <Badge tone={isLive ? "down" : "accent"}>{isLive ? "UANG ASLI" : "LATIHAN"}</Badge>
      {running ? (
        <Badge tone="up">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-up" /> Berjalan
        </Badge>
      ) : (
        <Badge tone="neutral">Berhenti</Badge>
      )}
      <Button size="xs" variant="ghost" onClick={() => setSettingsOpen(true)} title="Pengaturan Auto-Pilot">
        ⚙<span className="hidden sm:inline"> Pengaturan</span>
      </Button>
      <Button size="xs" variant="ghost" onClick={switchMode} title={isLive ? "Kembali ke mode latihan" : "Pakai uang asli (butuh konfirmasi)"}>
        {isLive ? "→ Latihan" : "→ Uang asli"}
      </Button>
    </div>
  );

  return (
    <Panel
      title={
        <>
          Auto-Pilot<span className="hidden md:inline"> · momentum token berjalan</span>
        </>
      }
      right={headerRight}
      bodyClassName="p-0"
    >
      <div className="flex flex-col gap-3 p-3">
        {state.pausedReason ? (
          <div className="rounded-md border border-down/40 bg-down/10 px-3 py-2 text-xs text-down">⛔ {state.pausedReason}</div>
        ) : null}
        {isLive && (!walletUnlocked || !autoSellEngineEnabled) ? (
          <div className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
            {!walletUnlocked ? "Wallet terkunci — Auto-Pilot uang asli tidak bisa membeli maupun menjual. " : ""}
            {!autoSellEngineEnabled ? "Mesin Auto TP/SL mati — posisi baru tidak akan dibuka." : ""}
          </div>
        ) : null}

        {/* Kontrol */}
        <div className="flex flex-wrap items-center gap-2">
          {running ? (
            <Button variant="outline" onClick={() => state.stop()}>
              ■ Berhenti
            </Button>
          ) : (
            <Button variant={isLive ? "sell" : "buy"} onClick={start}>
              ▶ Mulai {isLive ? "(uang asli)" : "latihan"}
            </Button>
          )}
          <Button variant="subtle" onClick={() => void scanOnce()} loading={scanning} disabled={busy && !scanning} title="Jalankan satu siklus tanpa membeli — untuk menguji filter">
            Scan sekali (tanpa beli)
          </Button>
          <Button variant="danger" onClick={kill} title="Hentikan Auto-Pilot dan tutup SEMUA posisinya sekarang">
            {killArmedUntil > now ? "Yakin? Klik lagi" : "⛔ Stop darurat"}
          </Button>
          <span className="ml-auto flex items-center gap-2 text-[11px] text-dim">
            {busy ? <Spinner className="text-accent" /> : null}
            <span>{view.phaseText}</span>
            {view.lastCycleAt ? <span>· siklus #{view.cycleCount} {timeAgo(view.lastCycleAt, now)}</span> : null}
            {running && view.nextCycleAt ? <span>· berikutnya {Math.max(0, Math.ceil((view.nextCycleAt - now) / 1000))} dtk</span> : null}
          </span>
        </div>

        {/* Statistik */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
          <Stat label={isLive ? "Saldo wallet" : "Saldo latihan"} value={`${formatSol(isLive ? walletSol : cash, 4)}`} sub="SOL" />
          <Stat label="PnL hari ini" value={formatSol(todayPnl, 4)} tone={pnlTone(todayPnl)} sub={`batas −${config.guardrails.dailyLossLimitSol} SOL`} />
          <Stat label="Net total" value={formatSol(stats.netSol, 4)} tone={pnlTone(stats.netSol)} sub={`${stats.count} trade`} />
          <Stat label="Win rate" value={stats.winRatePct === null ? "—" : `${stats.winRatePct.toFixed(0)}%`} sub={`${stats.wins}M / ${stats.losses}K`} />
          <Stat label="Profit factor" value={stats.profitFactor === null ? "—" : stats.profitFactor.toFixed(2)} sub=">1 = untung" />
          <Stat label="Rata-rata" value={formatPct(stats.avgPnlPct, 1)} tone={pnlTone(stats.avgPnlPct)} sub="per trade" />
          <Stat label="Drawdown maks" value={formatSol(stats.maxDrawdownSol, 4)} sub="SOL" />
          <Stat label="Posisi" value={`${openCount}/${config.entry.maxOpenPositions}`} sub={`${formatSol(config.entry.solPerTrade, 3)} SOL/trade`} />
        </div>

        {/* Sumber */}
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="text-dim">Sumber:</span>
          {view.sources
            .filter((source) => source.enabled || source.ok !== null)
            .map((source) => (
              <Badge key={source.id} tone={source.ok === null ? "neutral" : source.ok ? "up" : "down"} className="font-normal">
                <span title={source.error ?? undefined}>
                  {SOURCE_LABEL[source.id]} {source.ok === null ? "…" : source.ok ? `✓ ${source.count}` : `✗ ${source.error ?? ""}`.slice(0, 80)}
                </span>
              </Badge>
            ))}
          {view.cycleCount === 0 ? <span className="text-dim">belum ada siklus — tekan Mulai atau Scan sekali.</span> : null}
          {view.entryBlockedReason && running ? <span className="text-warn">· Entry ditahan: {view.entryBlockedReason}</span> : null}
          {view.lastError ? <span className="text-down">· {view.lastError}</span> : null}
        </div>

        {/* Tab */}
        <div className="flex gap-1 border-b border-line">
          {(
            [
              ["candidates", `Kandidat (${view.passedCount}/${view.totalCandidates})`],
              ["positions", `Posisi (${openPaper.length + openLive.length})`],
              ["history", `Riwayat (${modeTrades.length})`],
              ["log", "Log"],
            ] as [Tab, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={cn(
                "-mb-px border-b-2 px-3 py-1.5 text-xs font-medium",
                tab === id ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {tab === "candidates" ? (
        <CandidatesTable
          candidates={view.candidates}
          selectedMint={selectedMint}
          onSelect={onSelectMint}
          onBlacklist={(mint) => state.addBlacklist(mint)}
          blacklistCount={state.blacklist.length}
          onClearBlacklist={() => state.blacklist.forEach((mint) => state.removeBlacklist(mint))}
        />
      ) : null}

      {tab === "positions" ? (
        <PositionsList
          now={now}
          paper={openPaper}
          live={openLive}
          paperMarks={view.paperMarks}
          liveMarks={view.liveMarks}
          busyMints={view.busyMints}
          walletUnlocked={walletUnlocked}
          selectedMint={selectedMint}
          onSelect={onSelectMint}
        />
      ) : null}

      {tab === "history" ? (
        <div className="flex flex-col gap-2 px-3 pb-3">
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
            <span>Rata-rata menang {formatPct(stats.avgWinPct, 1)}</span>
            <span>· rata-rata kalah {formatPct(stats.avgLossPct, 1)}</span>
            <span>· ekspektasi {formatSol(stats.expectancySol, 5)} SOL/trade</span>
            <span>· durasi rata-rata {fmtNum(stats.avgHoldMinutes, 0, " mnt")}</span>
            <span className="ml-auto flex gap-1.5">
              <Button size="xs" variant="subtle" disabled={state.closed.length === 0} onClick={() => downloadCsv(state.closed, "semua")}>
                ⬇ Export CSV
              </Button>
              {!isLive ? (
                <Button
                  size="xs"
                  variant="danger"
                  onClick={() => {
                    if (resetArmedUntil < Date.now()) {
                      setResetArmedUntil(Date.now() + 4_000);
                      return;
                    }
                    setResetArmedUntil(0);
                    state.resetPaper();
                  }}
                >
                  {resetArmedUntil > now ? "Yakin? Klik lagi" : "Reset latihan"}
                </Button>
              ) : null}
            </span>
          </div>
          <HistoryTable trades={modeTrades} onSelect={onSelectMint} />
        </div>
      ) : null}

      {tab === "log" ? (
        <div className="max-h-[360px] overflow-y-auto px-3 pb-3">
          {state.log.length === 0 ? <p className="py-6 text-center text-xs text-dim">Belum ada aktivitas.</p> : null}
          <ul className="flex flex-col gap-1 font-mono text-[11px]">
            {state.log.map((entry) => (
              <li key={entry.id} className="flex gap-2">
                <span className="shrink-0 text-dim">{new Date(entry.at).toLocaleTimeString("id-ID", { hour12: false })}</span>
                <span className={cn("break-words", LOG_TONE[entry.level])}>{entry.message}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <footer className="border-t border-line px-3 py-2 text-[10px] text-dim">
        Auto-Pilot hanya berjalan selama tab ini terbuka & komputer menyala. Filter tidak menjamin token aman atau untung. Mode latihan
        memperhitungkan price impact, fee LP, penalti {config.paper.latencyPenaltyPct}%/sisi, serta fee + tip {formatSol(config.fees.priorityFeeSol + config.fees.tipSol, 4)} SOL/transaksi.
      </footer>

      {settingsOpen ? <AutoPilotSettings open onClose={() => setSettingsOpen(false)} /> : null}
      {liveDialogOpen ? <AutoPilotLiveDialog open onClose={() => setLiveDialogOpen(false)} /> : null}
    </Panel>
  );
}

// ===========================================================================
// Kandidat
// ===========================================================================

function CandidatesTable({
  candidates,
  selectedMint,
  onSelect,
  onBlacklist,
  blacklistCount,
  onClearBlacklist,
}: {
  candidates: CandidateView[];
  selectedMint: string | null;
  onSelect: (mint: string) => void;
  onBlacklist: (mint: string) => void;
  blacklistCount: number;
  onClearBlacklist: () => void;
}) {
  if (candidates.length === 0) {
    return <p className="px-3 pb-4 text-center text-xs text-dim">Belum ada kandidat. Jalankan Auto-Pilot atau tekan “Scan sekali”.</p>;
  }
  return (
    <div className="pb-2">
      <div className="max-h-[440px] overflow-auto">
        <table className="w-full min-w-[1080px] text-xs">
          <thead className="sticky top-0 bg-panel">
            <tr className="border-b border-line text-left text-[10px] uppercase tracking-wider text-dim">
              <th className="px-3 py-2 font-medium">Token</th>
              <th className="px-2 py-2 font-medium">Status</th>
              <th className="px-2 py-2 text-right font-medium" title="0–100, hanya untuk mengurutkan kandidat yang lolos">Skor</th>
              <th className="px-2 py-2 text-right font-medium">Umur</th>
              <th className="px-2 py-2 text-right font-medium">Lik.</th>
              <th className="px-2 py-2 text-right font-medium">MC</th>
              <th className="px-2 py-2 text-right font-medium">Vol 1j</th>
              <th className="px-2 py-2 text-right font-medium" title="Volume 1 jam ÷ rata-rata per jam selama 6 jam">Vol naik</th>
              <th className="px-2 py-2 text-right font-medium" title="Transaksi beli ÷ jual (1 jam)">B/J</th>
              <th className="px-2 py-2 text-right font-medium">Δ1j</th>
              <th className="px-2 py-2 text-right font-medium">Δ5m</th>
              <th className="px-2 py-2 text-right font-medium" title="Skor organik Jupiter (0–100)">Organik</th>
              <th className="px-2 py-2 text-right font-medium" title="Top 10 holder tanpa pool">Top10</th>
              <th className="px-2 py-2 font-medium">Sumber</th>
              <th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {candidates.map((candidate) => {
              const m = candidate.evaluation.metrics;
              return (
                <tr key={candidate.mint} className={cn("border-b border-line/50 hover:bg-panel-2/60", candidate.status === "ready" && "bg-up/5")}>
                  <td className="px-3 py-1.5">
                    <TokenCell
                      symbol={candidate.symbol}
                      mint={candidate.mint}
                      imageUrl={candidate.imageUrl}
                      onSelect={onSelect}
                      selected={selectedMint === candidate.mint}
                    />
                  </td>
                  <td className="max-w-[220px] px-2 py-1.5">
                    <Badge tone={STATUS_TONE[candidate.status]} className="max-w-full font-normal">
                      <span className="truncate" title={[...candidate.evaluation.failures, ...(candidate.security?.reasons ?? [])].join(" · ") || candidate.statusText}>
                        {candidate.statusText}
                      </span>
                    </Badge>
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums text-fg">{Math.round(candidate.evaluation.score.total)}</td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted">{fmtNum(m.ageHours, m.ageHours !== null && m.ageHours < 10 ? 1 : 0, "j")}</td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted">{formatUsdCompact(m.liquidityUsd)}</td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted">{formatUsdCompact(m.marketCapUsd)}</td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted">{formatUsdCompact(m.volume1hUsd)}</td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                    <span className={cn(m.volumeAccel !== null && m.volumeAccel >= 1.3 ? "text-up" : "text-muted")}>{fmtNum(m.volumeAccel, 2, "×")}</span>
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                    <span className={cn(m.buySellRatio1h !== null && m.buySellRatio1h >= 1 ? "text-up" : "text-down")}>{fmtNum(m.buySellRatio1h, 2)}</span>
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <Pnl value={m.priceChange1h}>{formatPct(m.priceChange1h, 1)}</Pnl>
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <Pnl value={m.priceChange5m}>{formatPct(m.priceChange5m, 1)}</Pnl>
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted">{m.organicScore === null ? "—" : Math.round(m.organicScore)}</td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted">{fmtNum(candidate.security?.top10Pct ?? null, 0, "%")}</td>
                  <td className="px-2 py-1.5 text-[10px] text-dim">{candidate.sources.map((source) => SOURCE_LABEL[source].replace("DexScreener ", "DS ").replace("Jupiter ", "Jup ")).join(", ")}</td>
                  <td className="px-2 py-1.5 text-right">
                    <Button size="xs" variant="ghost" title="Jangan pernah beli token ini" onClick={() => onBlacklist(candidate.mint)}>
                      ⛔
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2 px-3 pt-2 text-[10px] text-dim">
        <span>Klik token untuk melihat grafik & scan lengkap. Arahkan kursor ke status untuk semua alasan.</span>
        {blacklistCount > 0 ? (
          <Button size="xs" variant="ghost" className="ml-auto" onClick={onClearBlacklist}>
            Kosongkan daftar hitam ({blacklistCount})
          </Button>
        ) : null}
      </div>
    </div>
  );
}

// ===========================================================================
// Posisi
// ===========================================================================

function TargetText({ mark }: { mark: PositionMark | undefined }) {
  if (!mark) return <span className="text-dim">—</span>;
  const parts: string[] = [];
  if (mark.nextTakeProfitPct !== null) parts.push(`TP +${mark.nextTakeProfitPct}%`);
  if (mark.stopLossPct !== null) parts.push(`SL −${mark.stopLossPct}%`);
  if (mark.trailingArmed) parts.push("trailing ✓");
  return <span className="text-[11px] text-muted">{parts.join(" · ") || "—"}</span>;
}

function PositionsList({
  now,
  paper,
  live,
  paperMarks,
  liveMarks,
  busyMints,
  walletUnlocked,
  selectedMint,
  onSelect,
}: {
  now: number;
  paper: ReturnType<typeof useAutoPilotStore.getState>["paperPositions"];
  live: ReturnType<typeof useAutoPilotStore.getState>["livePositions"];
  paperMarks: Record<string, PositionMark>;
  liveMarks: Record<string, PositionMark>;
  busyMints: string[];
  walletUnlocked: boolean;
  selectedMint: string | null;
  onSelect: (mint: string) => void;
}) {
  const rows = [
    ...live.map((position) => ({ mode: "live" as const, id: position.id, mint: position.mint, symbol: position.symbol, imageUrl: position.imageUrl, openedAt: position.openedAt, costSol: position.costSol, maxHold: position.maxHoldMinutes, mark: liveMarks[position.id] })),
    ...paper.map((position) => ({ mode: "paper" as const, id: position.id, mint: position.mint, symbol: position.symbol, imageUrl: position.imageUrl, openedAt: position.openedAt, costSol: position.costSol, maxHold: position.maxHoldMinutes, mark: paperMarks[position.id] })),
  ];
  if (rows.length === 0) return <p className="px-3 pb-4 text-center text-xs text-dim">Tidak ada posisi Auto-Pilot yang terbuka.</p>;
  return (
    <div className="overflow-x-auto pb-2">
      <table className="w-full min-w-[860px] text-xs">
        <thead>
          <tr className="border-b border-line text-left text-[10px] uppercase tracking-wider text-dim">
            <th className="px-3 py-2 font-medium">Token</th>
            <th className="px-2 py-2 font-medium">Mode</th>
            <th className="px-2 py-2 text-right font-medium">Dibuka</th>
            <th className="px-2 py-2 text-right font-medium">Modal</th>
            <th className="px-2 py-2 text-right font-medium">Nilai kini</th>
            <th className="px-2 py-2 text-right font-medium">PnL</th>
            <th className="px-2 py-2 font-medium">Target</th>
            <th className="px-2 py-2 text-right font-medium">Sisa waktu</th>
            <th className="px-2 py-2 text-right font-medium">Aksi</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const busy = busyMints.includes(row.mint);
            return (
              <tr key={row.id} className="border-b border-line/50 hover:bg-panel-2/60">
                <td className="px-3 py-1.5">
                  <TokenCell symbol={row.symbol} mint={row.mint} imageUrl={row.imageUrl} onSelect={onSelect} selected={selectedMint === row.mint} />
                </td>
                <td className="px-2 py-1.5">
                  <Badge tone={row.mode === "live" ? "down" : "accent"}>{row.mode === "live" ? "Asli" : "Latihan"}</Badge>
                </td>
                <td className="px-2 py-1.5 text-right text-muted">{timeAgo(row.openedAt, now)}</td>
                <td className="px-2 py-1.5 text-right font-mono tabular-nums text-fg">{formatSol(row.costSol, 4)}</td>
                <td className="px-2 py-1.5 text-right font-mono tabular-nums text-fg">
                  {formatSol(row.mark?.valueSol ?? null, 4)}
                  {row.mark?.stale ? <span className="ml-1 text-warn" title="Harga basi / belum ada">~</span> : null}
                </td>
                <td className="px-2 py-1.5 text-right">
                  <div className="text-sm font-semibold">
                    <Pnl value={row.mark?.pnlPct ?? null}>{formatPct(row.mark?.pnlPct ?? null, 1)}</Pnl>
                  </div>
                  <div className="text-[10px]">
                    <Pnl value={row.mark?.pnlSol ?? null}>{formatSol(row.mark?.pnlSol ?? null, 5)}</Pnl>
                  </div>
                </td>
                <td className="px-2 py-1.5">
                  <TargetText mark={row.mark} />
                </td>
                <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted">{minutesLeft(row.openedAt, row.maxHold, now)}</td>
                <td className="px-2 py-1.5 text-right">
                  <Button
                    size="xs"
                    variant="sell"
                    loading={busy}
                    disabled={busy || (row.mode === "live" && !walletUnlocked)}
                    onClick={() => void autopilotEngine.closePosition(row.mode, row.id, "manual")}
                    title={row.mode === "live" ? "Jual 100% sekarang" : "Tutup posisi latihan di harga pasar"}
                  >
                    Tutup
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ===========================================================================
// Riwayat
// ===========================================================================

function HistoryTable({ trades, onSelect }: { trades: ClosedTrade[]; onSelect: (mint: string) => void }) {
  const ordered = [...trades].sort((a, b) => b.closedAt - a.closedAt).slice(0, 100);
  if (ordered.length === 0) return <p className="py-4 text-center text-xs text-dim">Belum ada trade yang selesai.</p>;
  return (
    <div className="max-h-[400px] overflow-auto">
      <table className="w-full min-w-[860px] text-xs">
        <thead className="sticky top-0 bg-panel">
          <tr className="border-b border-line text-left text-[10px] uppercase tracking-wider text-dim">
            <th className="px-2 py-2 font-medium">Token</th>
            <th className="px-2 py-2 font-medium">Ditutup</th>
            <th className="px-2 py-2 text-right font-medium">Durasi</th>
            <th className="px-2 py-2 text-right font-medium">Modal</th>
            <th className="px-2 py-2 text-right font-medium">Hasil</th>
            <th className="px-2 py-2 text-right font-medium">PnL</th>
            <th className="px-2 py-2 text-right font-medium" title="PnL tertinggi / terendah selama posisi terbuka">Puncak / dasar</th>
            <th className="px-2 py-2 font-medium">Alasan</th>
            <th className="px-2 py-2 text-right font-medium">Skor masuk</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((trade) => (
            <tr key={trade.id} className="border-b border-line/50">
              <td className="px-2 py-1.5">
                <button type="button" className="font-semibold text-fg hover:text-accent" onClick={() => onSelect(trade.mint)}>
                  {trade.symbol}
                </button>
              </td>
              <td className="px-2 py-1.5 text-muted">{new Date(trade.closedAt).toLocaleString("id-ID", { hour12: false, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</td>
              <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted">{fmtNum(trade.holdMinutes, 0, " mnt")}</td>
              <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted">{formatSol(trade.costSol, 4)}</td>
              <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted">{formatSol(trade.proceedsSol, 4)}</td>
              <td className="px-2 py-1.5 text-right">
                <Pnl value={trade.pnlSol}>
                  {formatSol(trade.pnlSol, 5)} ({formatPct(trade.pnlPct, 1)})
                </Pnl>
                {trade.estimated ? <span className="ml-1 text-warn" title="Sebagian angka dari quote (estimasi)">~</span> : null}
              </td>
              <td className="px-2 py-1.5 text-right font-mono text-[11px] text-muted">
                {formatPct(trade.maxPnlPct, 0)} / {formatPct(trade.minPnlPct, 0)}
              </td>
              <td className="px-2 py-1.5 text-muted">{EXIT_LABEL[trade.closeReason]}</td>
              <td className="px-2 py-1.5 text-right font-mono text-muted" title={`Vol naik ${fmtNum(trade.signal.volumeAccel, 2, "×")} · B/J ${fmtNum(trade.signal.buySellRatio1h, 2)} · organik ${trade.signal.organicScore ?? "—"} · MC ${formatUsdCompact(trade.signal.marketCapUsd)} · vol ${formatCompactNumber(trade.signal.volume1hUsd)}`}>
                {Math.round(trade.signal.score)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
