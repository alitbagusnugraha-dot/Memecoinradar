"use client";

/**
 * Pengaturan Auto-Pilot: sumber, filter, keamanan, entry, exit, rem pengaman, biaya,
 * dan simulasi latihan. Semua nilai disanitasi (sanitizeConfig) sebelum disimpan.
 */

import { useState, type ReactNode } from "react";
import { DEFAULT_AUTOPILOT_CONFIG, configWarnings, sanitizeConfig, type AutoPilotConfig, type JupiterInterval } from "@/lib/autopilot/config";
import { useAutoPilotStore } from "@/store/autopilot-store";
import { pushToast } from "@/store/toast-store";
import { Button, Field, Input, Modal, Toggle, cn } from "./ui";

interface NumberFieldDef {
  key: string;
  label: string;
  hint?: string;
  suffix?: string;
  get: (config: AutoPilotConfig) => number;
  set: (config: AutoPilotConfig, value: number) => void;
}

const pct = (bps: number) => bps / 100;
const bps = (percent: number) => Math.round(percent * 100);

const SECTIONS: { title: string; note?: string; fields: NumberFieldDef[] }[] = [
  {
    title: "Siklus",
    fields: [
      { key: "interval", label: "Interval siklus", suffix: "detik", hint: "Min. 30. Tiap siklus memakai 1–2 request Jupiter.", get: (c) => c.discoveryIntervalSec, set: (c, v) => (c.discoveryIntervalSec = v) },
      { key: "scans", label: "Cek keamanan / siklus", hint: "Tiap cek ±4 request RPC Helius.", get: (c) => c.maxScansPerCycle, set: (c, v) => (c.maxScansPerCycle = v) },
      { key: "metaCount", label: "Jumlah meta DexScreener", get: (c) => c.sources.dexMetaCount, set: (c, v) => (c.sources.dexMetaCount = v) },
    ],
  },
  {
    title: "Filter market",
    note: "Gaya (b): token yang sudah berjalan beberapa jam dengan volume yang sedang naik.",
    fields: [
      { key: "minAge", label: "Umur pair min.", suffix: "jam", get: (c) => c.filters.minPairAgeHours, set: (c, v) => (c.filters.minPairAgeHours = v) },
      { key: "maxAge", label: "Umur pair maks.", suffix: "jam", get: (c) => c.filters.maxPairAgeHours, set: (c, v) => (c.filters.maxPairAgeHours = v) },
      { key: "minLiq", label: "Likuiditas min.", suffix: "USD", get: (c) => c.filters.minLiquidityUsd, set: (c, v) => (c.filters.minLiquidityUsd = v) },
      { key: "minMc", label: "Market cap min.", suffix: "USD", get: (c) => c.filters.minMarketCapUsd, set: (c, v) => (c.filters.minMarketCapUsd = v) },
      { key: "maxMc", label: "Market cap maks.", suffix: "USD", get: (c) => c.filters.maxMarketCapUsd, set: (c, v) => (c.filters.maxMarketCapUsd = v) },
      { key: "minVol", label: "Volume 1 jam min.", suffix: "USD", get: (c) => c.filters.minVolume1hUsd, set: (c, v) => (c.filters.minVolume1hUsd = v) },
      { key: "accel", label: "Volume naik min.", suffix: "×", hint: "Vol 1 jam ÷ rata-rata per jam (6 jam). 1,3 = 30% di atas rata-rata.", get: (c) => c.filters.minVolumeAccel, set: (c, v) => (c.filters.minVolumeAccel = v) },
      { key: "minH1", label: "Δ harga 1 jam min.", suffix: "%", get: (c) => c.filters.minPriceChange1hPct, set: (c, v) => (c.filters.minPriceChange1hPct = v) },
      { key: "maxH1", label: "Δ harga 1 jam maks.", suffix: "%", hint: "Di atas ini dianggap parabolik (rawan dibuang).", get: (c) => c.filters.maxPriceChange1hPct, set: (c, v) => (c.filters.maxPriceChange1hPct = v) },
      { key: "minM5", label: "Δ harga 5 menit min.", suffix: "%", get: (c) => c.filters.minPriceChange5mPct, set: (c, v) => (c.filters.minPriceChange5mPct = v) },
      { key: "maxM5", label: "Δ harga 5 menit maks.", suffix: "%", get: (c) => c.filters.maxPriceChange5mPct, set: (c, v) => (c.filters.maxPriceChange5mPct = v) },
      { key: "bs", label: "Rasio beli/jual 1 jam min.", get: (c) => c.filters.minBuySellRatio1h, set: (c, v) => (c.filters.minBuySellRatio1h = v) },
      { key: "tx", label: "Transaksi 1 jam min.", get: (c) => c.filters.minTxns1h, set: (c, v) => (c.filters.minTxns1h = v) },
      { key: "score", label: "Skor min.", suffix: "/100", get: (c) => c.filters.minScore, set: (c, v) => (c.filters.minScore = v) },
    ],
  },
  {
    title: "Organik & keamanan",
    note: "RISIKO TINGGI dan BAHAYA dari scanner selalu ditolak.",
    fields: [
      { key: "organic", label: "Skor organik Jupiter min.", suffix: "/100", hint: "0 = tidak dicek. Menyaring volume bot/wash trading.", get: (c) => c.filters.minOrganicScore, set: (c, v) => (c.filters.minOrganicScore = v) },
      { key: "dev", label: "Saldo dev maks.", suffix: "%", hint: "100 = tidak dicek.", get: (c) => c.filters.maxDevBalancePct, set: (c, v) => (c.filters.maxDevBalancePct = v) },
      { key: "top10", label: "Top 10 holder maks.", suffix: "%", hint: "Tanpa pool & burn.", get: (c) => c.security.maxTop10Pct, set: (c, v) => (c.security.maxTop10Pct = v) },
      { key: "whale", label: "Satu holder maks.", suffix: "%", get: (c) => c.security.maxSingleHolderPct, set: (c, v) => (c.security.maxSingleHolderPct = v) },
    ],
  },
  {
    title: "Entry (beli)",
    fields: [
      { key: "size", label: "Modal per trade", suffix: "SOL", get: (c) => c.entry.solPerTrade, set: (c, v) => (c.entry.solPerTrade = v) },
      { key: "maxOpen", label: "Posisi terbuka maks.", get: (c) => c.entry.maxOpenPositions, set: (c, v) => (c.entry.maxOpenPositions = v) },
      { key: "confirm", label: "Konfirmasi", suffix: "siklus", hint: "Harus lolos N siklus berturut-turut.", get: (c) => c.entry.confirmCycles, set: (c, v) => (c.entry.confirmCycles = v) },
      { key: "perHour", label: "Entry per jam maks.", get: (c) => c.entry.maxEntriesPerHour, set: (c, v) => (c.entry.maxEntriesPerHour = v) },
      { key: "perDay", label: "Entry per hari maks.", get: (c) => c.entry.maxTradesPerDay, set: (c, v) => (c.entry.maxTradesPerDay = v) },
      { key: "reentry", label: "Jeda beli ulang mint sama", suffix: "menit", get: (c) => c.entry.reentryCooldownMinutes, set: (c, v) => (c.entry.reentryCooldownMinutes = v) },
      { key: "buySlip", label: "Slippage beli", suffix: "%", get: (c) => pct(c.entry.buySlippageBps), set: (c, v) => (c.entry.buySlippageBps = bps(v)) },
    ],
  },
  {
    title: "Exit (jual)",
    fields: [
      { key: "hold", label: "Batas waktu tahan", suffix: "menit", hint: "0 = tanpa batas. Momentum yang hilang = keluar.", get: (c) => c.exit.maxHoldMinutes, set: (c, v) => (c.exit.maxHoldMinutes = v) },
      { key: "exitSlip", label: "Slippage jual", suffix: "%", get: (c) => pct(c.exit.exitSlippageBps), set: (c, v) => (c.exit.exitSlippageBps = bps(v)) },
    ],
  },
  {
    title: "Rem pengaman & biaya",
    fields: [
      { key: "dailyLoss", label: "Batas rugi harian", suffix: "SOL", hint: "Realized + unrealized. Tercapai → berhenti sampai besok.", get: (c) => c.guardrails.dailyLossLimitSol, set: (c, v) => (c.guardrails.dailyLossLimitSol = v) },
      { key: "streak", label: "Rugi beruntun maks.", hint: "0 = tidak dicek.", get: (c) => c.guardrails.maxConsecutiveLosses, set: (c, v) => (c.guardrails.maxConsecutiveLosses = v) },
      { key: "reserve", label: "Cadangan SOL di wallet", suffix: "SOL", hint: "Mode uang asli: untuk fee jual & rent.", get: (c) => c.guardrails.minWalletReserveSol, set: (c, v) => (c.guardrails.minWalletReserveSol = v) },
      { key: "prio", label: "Priority fee Auto-Pilot", suffix: "SOL", get: (c) => c.fees.priorityFeeSol, set: (c, v) => (c.fees.priorityFeeSol = v) },
      { key: "tip", label: "Tip Auto-Pilot", suffix: "SOL", hint: "Min. 0,000005.", get: (c) => c.fees.tipSol, set: (c, v) => (c.fees.tipSol = v) },
    ],
  },
  {
    title: "Simulasi latihan",
    note: "Mengubah modal awal langsung mengubah saldo latihan.",
    fields: [
      { key: "paperStart", label: "Modal awal latihan", suffix: "SOL", get: (c) => c.paper.startBalanceSol, set: (c, v) => (c.paper.startBalanceSol = v) },
      { key: "penalty", label: "Penalti keterlambatan / sisi", suffix: "%", hint: "Data DexScreener tertinggal + slippage nyata. Jangan 0.", get: (c) => c.paper.latencyPenaltyPct, set: (c, v) => (c.paper.latencyPenaltyPct = v) },
    ],
  },
];

const ALL_FIELDS = SECTIONS.flatMap((section) => section.fields);

interface Draft {
  numbers: Record<string, string>;
  jupiterTrending: boolean;
  jupiterTopTraded: boolean;
  jupiterInterval: JupiterInterval;
  dexTrendingMetas: boolean;
  dexBoosts: boolean;
  requireJupiterData: boolean;
  allowCaution: boolean;
  takeProfits: { triggerPct: string; sellPct: string }[];
  stopLossEnabled: boolean;
  stopLossPct: string;
  stopLossSellPct: string;
  trailingEnabled: boolean;
  trailingActivatePct: string;
  trailingDistancePct: string;
  trailingSellPct: string;
}

function toDraft(config: AutoPilotConfig): Draft {
  const numbers: Record<string, string> = {};
  for (const field of ALL_FIELDS) numbers[field.key] = String(field.get(config));
  return {
    numbers,
    jupiterTrending: config.sources.jupiterTrending,
    jupiterTopTraded: config.sources.jupiterTopTraded,
    jupiterInterval: config.sources.jupiterInterval,
    dexTrendingMetas: config.sources.dexTrendingMetas,
    dexBoosts: config.sources.dexBoosts,
    requireJupiterData: config.filters.requireJupiterData,
    allowCaution: config.security.allowCaution,
    takeProfits: config.exit.takeProfits.map((level) => ({ triggerPct: String(level.triggerPct), sellPct: String(level.sellPct) })),
    stopLossEnabled: config.exit.stopLoss !== null,
    stopLossPct: String(config.exit.stopLoss?.triggerPct ?? 15),
    stopLossSellPct: String(config.exit.stopLoss?.sellPct ?? 100),
    trailingEnabled: config.exit.trailing !== null,
    trailingActivatePct: String(config.exit.trailing?.activatePct ?? 15),
    trailingDistancePct: String(config.exit.trailing?.distancePct ?? 10),
    trailingSellPct: String(config.exit.trailing?.sellPct ?? 100),
  };
}

function parse(value: string): number {
  return Number(value.trim().replace(",", "."));
}

function fromDraft(draft: Draft, base: AutoPilotConfig): { config: AutoPilotConfig; invalid: string[] } {
  const config: AutoPilotConfig = structuredClone(base);
  const invalid: string[] = [];
  for (const field of ALL_FIELDS) {
    const value = parse(draft.numbers[field.key] ?? "");
    if (!Number.isFinite(value)) invalid.push(field.label);
    else field.set(config, value);
  }
  config.sources.jupiterTrending = draft.jupiterTrending;
  config.sources.jupiterTopTraded = draft.jupiterTopTraded;
  config.sources.jupiterInterval = draft.jupiterInterval;
  config.sources.dexTrendingMetas = draft.dexTrendingMetas;
  config.sources.dexBoosts = draft.dexBoosts;
  config.filters.requireJupiterData = draft.requireJupiterData;
  config.security.allowCaution = draft.allowCaution;
  config.exit.takeProfits = draft.takeProfits
    .map((level) => ({ triggerPct: parse(level.triggerPct), sellPct: parse(level.sellPct) }))
    .filter((level) => Number.isFinite(level.triggerPct) && Number.isFinite(level.sellPct) && level.triggerPct > 0 && level.sellPct > 0);
  config.exit.stopLoss = draft.stopLossEnabled ? { triggerPct: parse(draft.stopLossPct), sellPct: parse(draft.stopLossSellPct) } : null;
  config.exit.trailing = draft.trailingEnabled
    ? { activatePct: parse(draft.trailingActivatePct), distancePct: parse(draft.trailingDistancePct), sellPct: parse(draft.trailingSellPct) }
    : null;
  return { config: sanitizeConfig(config), invalid };
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-bg/40 p-3">
      <h4 className="text-xs font-semibold uppercase tracking-wider text-fg">{title}</h4>
      {note ? <p className="mt-0.5 text-[11px] text-dim">{note}</p> : null}
      <div className="mt-2.5 grid grid-cols-2 gap-2.5 sm:grid-cols-3">{children}</div>
    </section>
  );
}

function NumberInput({ value, onChange, suffix }: { value: string; onChange: (value: string) => void; suffix?: string }) {
  return (
    <div className="relative">
      <Input inputMode="decimal" value={value} onChange={(event) => onChange(event.target.value)} className={cn("font-mono", suffix && "pr-12")} />
      {suffix ? <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-dim">{suffix}</span> : null}
    </div>
  );
}

export function AutoPilotSettings({ open, onClose }: { open: boolean; onClose: () => void }) {
  const config = useAutoPilotStore((state) => state.config);
  const setConfig = useAutoPilotStore((state) => state.setConfig);
  const [draft, setDraft] = useState<Draft>(() => toDraft(config));

  const preview = fromDraft(draft, config);
  const warnings = configWarnings(preview.config);

  const setNumber = (key: string, value: string) => setDraft((current) => ({ ...current, numbers: { ...current.numbers, [key]: value } }));

  const save = () => {
    if (preview.invalid.length > 0) {
      pushToast({ kind: "error", title: "Angka tidak valid", message: preview.invalid.join(", ") });
      return;
    }
    setConfig(preview.config);
    pushToast({ kind: "success", title: "Pengaturan Auto-Pilot disimpan", message: "Berlaku mulai siklus berikutnya. Posisi yang sudah terbuka memakai aturan saat dibeli." });
    onClose();
  };

  const renderSection = (index: number, extra?: ReactNode) => {
    const section = SECTIONS[index]!;
    return (
      <Section title={section.title} note={section.note}>
        {section.fields.map((field) => (
          <Field key={field.key} label={field.label} hint={field.hint}>
            <NumberInput value={draft.numbers[field.key] ?? ""} suffix={field.suffix} onChange={(value) => setNumber(field.key, value)} />
          </Field>
        ))}
        {extra}
      </Section>
    );
  };

  return (
    <Modal open={open} onClose={onClose} title="Pengaturan Auto-Pilot" width="max-w-3xl">
      <div className="flex flex-col gap-3">
        <Section title="Sumber kandidat" note="Jupiter lewat server Anda (API key aman). DexScreener langsung dari browser.">
          <div className="col-span-2 flex flex-col gap-2 sm:col-span-3">
            <Toggle checked={draft.jupiterTrending} onChange={(value) => setDraft({ ...draft, jupiterTrending: value })} label="Jupiter Trending (disarankan)" />
            <Toggle checked={draft.jupiterTopTraded} onChange={(value) => setDraft({ ...draft, jupiterTopTraded: value })} label="Jupiter Top Traded (+1 request Jupiter/siklus)" />
            <Toggle checked={draft.dexTrendingMetas} onChange={(value) => setDraft({ ...draft, dexTrendingMetas: value })} label="DexScreener Metas (narasi yang sedang naik)" />
            <Toggle checked={draft.dexBoosts} onChange={(value) => setDraft({ ...draft, dexBoosts: value })} label="DexScreener Boosts (promosi BERBAYAR — sinyal campuran)" />
            <label className="flex items-center gap-2 text-xs text-muted">
              Interval Jupiter
              <select
                className="h-8 rounded-md border border-line bg-bg px-2 text-xs text-fg"
                value={draft.jupiterInterval}
                onChange={(event) => setDraft({ ...draft, jupiterInterval: event.target.value as JupiterInterval })}
              >
                {(["5m", "1h", "6h", "24h"] as const).map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </Section>

        {renderSection(0)}
        {renderSection(1)}
        {renderSection(
          2,
          <div className="col-span-2 flex flex-col justify-end gap-2 sm:col-span-3">
            <Toggle checked={draft.requireJupiterData} onChange={(value) => setDraft({ ...draft, requireJupiterData: value })} label="Tolak token tanpa data Jupiter" />
            <Toggle checked={draft.allowCaution} onChange={(value) => setDraft({ ...draft, allowCaution: value })} label="Izinkan level WASPADA (temuan medium)" />
          </div>,
        )}
        {renderSection(3)}

        <Section title="Exit (jual)" note="Dipasang otomatis di setiap posisi. Persen jual = persen dari sisa token saat itu.">
          <div className="col-span-2 flex flex-col gap-2 sm:col-span-3">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted">Take-profit</span>
            {draft.takeProfits.map((level, index) => (
              <div key={index} className="flex items-center gap-2">
                <span className="text-xs text-dim">+</span>
                <div className="w-24">
                  <NumberInput
                    value={level.triggerPct}
                    suffix="%"
                    onChange={(value) =>
                      setDraft({ ...draft, takeProfits: draft.takeProfits.map((item, i) => (i === index ? { ...item, triggerPct: value } : item)) })
                    }
                  />
                </div>
                <span className="text-xs text-dim">jual</span>
                <div className="w-24">
                  <NumberInput
                    value={level.sellPct}
                    suffix="%"
                    onChange={(value) =>
                      setDraft({ ...draft, takeProfits: draft.takeProfits.map((item, i) => (i === index ? { ...item, sellPct: value } : item)) })
                    }
                  />
                </div>
                <Button size="xs" variant="ghost" onClick={() => setDraft({ ...draft, takeProfits: draft.takeProfits.filter((_, i) => i !== index) })}>
                  Hapus
                </Button>
              </div>
            ))}
            {draft.takeProfits.length < 5 ? (
              <Button size="xs" variant="subtle" className="self-start" onClick={() => setDraft({ ...draft, takeProfits: [...draft.takeProfits, { triggerPct: "100", sellPct: "100" }] })}>
                + Level TP
              </Button>
            ) : null}

            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Toggle checked={draft.stopLossEnabled} onChange={(value) => setDraft({ ...draft, stopLossEnabled: value })} label="Stop-loss −" />
              <div className="w-24">
                <NumberInput value={draft.stopLossPct} suffix="%" onChange={(value) => setDraft({ ...draft, stopLossPct: value })} />
              </div>
              <span className="text-xs text-dim">jual</span>
              <div className="w-24">
                <NumberInput value={draft.stopLossSellPct} suffix="%" onChange={(value) => setDraft({ ...draft, stopLossSellPct: value })} />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Toggle checked={draft.trailingEnabled} onChange={(value) => setDraft({ ...draft, trailingEnabled: value })} label="Trailing aktif di +" />
              <div className="w-24">
                <NumberInput value={draft.trailingActivatePct} suffix="%" onChange={(value) => setDraft({ ...draft, trailingActivatePct: value })} />
              </div>
              <span className="text-xs text-dim">jarak</span>
              <div className="w-24">
                <NumberInput value={draft.trailingDistancePct} suffix="%" onChange={(value) => setDraft({ ...draft, trailingDistancePct: value })} />
              </div>
              <span className="text-xs text-dim">jual</span>
              <div className="w-24">
                <NumberInput value={draft.trailingSellPct} suffix="%" onChange={(value) => setDraft({ ...draft, trailingSellPct: value })} />
              </div>
            </div>
          </div>
          {SECTIONS[4]!.fields.map((field) => (
            <Field key={field.key} label={field.label} hint={field.hint}>
              <NumberInput value={draft.numbers[field.key] ?? ""} suffix={field.suffix} onChange={(value) => setNumber(field.key, value)} />
            </Field>
          ))}
        </Section>

        {renderSection(5)}
        {renderSection(6)}

        {warnings.length > 0 ? (
          <ul className="rounded-lg border border-warn/40 bg-warn/10 p-3 text-xs text-warn">
            {warnings.map((warning) => (
              <li key={warning}>• {warning}</li>
            ))}
          </ul>
        ) : null}

        <div className="flex flex-wrap justify-between gap-2">
          <Button variant="ghost" onClick={() => setDraft(toDraft(sanitizeConfig(DEFAULT_AUTOPILOT_CONFIG)))}>
            Kembalikan default
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Batal
            </Button>
            <Button variant="primary" onClick={save}>
              Simpan
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
