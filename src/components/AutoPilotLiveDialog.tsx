"use client";

/**
 * Dialog konfirmasi sebelum Auto-Pilot memakai UANG ASLI.
 * Menampilkan hasil latihan apa adanya, lalu meminta user mengetik "UANG ASLI".
 */

import { useState } from "react";
import { computeStats } from "@/lib/autopilot/stats";
import { formatPct, formatSol } from "@/lib/format";
import { useAutoPilotStore } from "@/store/autopilot-store";
import { Button, Input, Modal, Stat, cn } from "./ui";

const CONFIRM_TEXT = "UANG ASLI";
const MIN_RECOMMENDED_TRADES = 30;

export function AutoPilotLiveDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const closed = useAutoPilotStore((state) => state.closed);
  const config = useAutoPilotStore((state) => state.config);
  const setMode = useAutoPilotStore((state) => state.setMode);
  const [typed, setTyped] = useState("");
  const [understood, setUnderstood] = useState(false);

  const paper = computeStats(closed.filter((trade) => trade.mode === "paper"));
  const tooFew = paper.count < MIN_RECOMMENDED_TRADES;
  const negative = paper.count > 0 && paper.netSol <= 0;
  const maxExposure = config.entry.solPerTrade * config.entry.maxOpenPositions;
  const canConfirm = typed.trim().toUpperCase() === CONFIRM_TEXT && understood;

  return (
    <Modal open={open} onClose={onClose} title="Aktifkan Auto-Pilot dengan UANG ASLI" width="max-w-lg">
      <div className="flex flex-col gap-3 text-xs text-muted">
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-fg">Hasil latihan Anda</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Trade" value={paper.count} />
            <Stat label="Win rate" value={paper.winRatePct === null ? "—" : `${paper.winRatePct.toFixed(0)}%`} />
            <Stat label="Net" value={`${formatSol(paper.netSol, 4)}`} tone={paper.netSol > 0 ? "up" : paper.netSol < 0 ? "down" : "flat"} sub="SOL" />
            <Stat label="Profit factor" value={paper.profitFactor === null ? "—" : paper.profitFactor.toFixed(2)} sub={paper.avgPnlPct !== null ? `rata-rata ${formatPct(paper.avgPnlPct, 1)}` : undefined} />
          </div>
        </div>

        {tooFew ? (
          <p className="rounded-md border border-warn/40 bg-warn/10 p-2 text-warn">
            Baru {paper.count} trade latihan. Terlalu sedikit untuk menilai apakah strategi ini menghasilkan — saran minimal {MIN_RECOMMENDED_TRADES} trade (±1–2 minggu).
          </p>
        ) : null}
        {negative ? (
          <p className="rounded-md border border-down/40 bg-down/10 p-2 text-down">
            Hasil latihan bersihnya RUGI. Dengan uang asli hasilnya biasanya lebih buruk, bukan lebih baik (slippage & keterlambatan nyata).
          </p>
        ) : null}

        <ul className="flex list-disc flex-col gap-1 pl-4">
          <li>
            Bot akan membeli <b className="text-fg">{formatSol(config.entry.solPerTrade, 4)} SOL</b> per trade, maksimal {config.entry.maxOpenPositions} posisi
            (<b className="text-fg">{formatSol(maxExposure, 3)} SOL</b> bersamaan), dan berhenti sendiri bila rugi hari ini mencapai {formatSol(config.guardrails.dailyLossLimitSol, 3)} SOL.
          </li>
          <li>Transaksi ditandatangani otomatis tanpa konfirmasi. Wallet harus tetap terbuka dan tab ini tetap aktif.</li>
          <li>Filter keamanan hanya menyaring penipuan yang terlihat. Dev/holder awal tetap bisa menjual habis kapan saja.</li>
          <li>Saat harga jatuh cepat, stop-loss bisa tereksekusi jauh di bawah target.</li>
          <li>Isi burner wallet hanya dengan jumlah yang siap Anda relakan.</li>
        </ul>

        <label className="flex items-start gap-2 text-fg">
          <input type="checkbox" className="mt-0.5" checked={understood} onChange={(event) => setUnderstood(event.target.checked)} />
          <span>Saya paham bisa kehilangan seluruh SOL di burner wallet ini.</span>
        </label>

        <div>
          <p className="mb-1">
            Ketik <b className="font-mono text-fg">{CONFIRM_TEXT}</b> untuk melanjutkan:
          </p>
          <Input value={typed} onChange={(event) => setTyped(event.target.value)} placeholder={CONFIRM_TEXT} className="font-mono" />
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Tetap latihan
          </Button>
          <Button
            variant="sell"
            disabled={!canConfirm}
            className={cn(!canConfirm && "opacity-50")}
            onClick={() => {
              setMode("live");
              onClose();
            }}
          >
            Aktifkan uang asli
          </Button>
        </div>
      </div>
    </Modal>
  );
}
