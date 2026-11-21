# Struktur Folder — Solana Meme Terminal

```
solana-meme-terminal/
├── .env.example · .gitignore · eslint.config.mjs · netlify.toml · vercel.json
├── next.config.mjs                 # CSP (iframe DexScreener, worker), header keamanan
├── package.json · postcss.config.mjs · tsconfig.json
├── public/
│   └── workers/heartbeat.js        # timer di Web Worker → tidak diperlambat saat tab di background
└── src/
    ├── app/
    │   ├── globals.css             # tema dark terminal (Tailwind v4 @theme)
    │   ├── layout.tsx
    │   ├── page.tsx                # Header + Scanner/Chart + Trade/Automation + Auto-Pilot + Posisi
    │   └── api/
    │       ├── jupiter/build/route.ts   # proxy Swap API V2 /build (API key di server)
    │       ├── jupiter/tokens/route.ts  # proxy Tokens API V2 (trending, skor organik) untuk Auto-Pilot
    │       └── jito/send/route.ts       # proxy Jito + fallback region
    ├── components/
    │   ├── Header.tsx              # status RPC, saldo SOL, Generate/Import/Export/Kunci
    │   ├── ScannerPanel.tsx        # input CA, market stats, iframe chart, skor keamanan, top holders
    │   ├── TradePanel.tsx          # tab Buy / Sell / Auto TP/SL, pengaturan eksekusi, progress tx
    │   ├── AutoSellForm.tsx        # form TP bertingkat, SL, trailing, status live
    │   ├── PositionsTable.tsx      # avg beli, harga kini, nilai, PnL live, Panic Sell 100%
    │   ├── AutoPilotPanel.tsx      # kontrol Auto-Pilot, statistik, kandidat, posisi, riwayat, log
    │   ├── AutoPilotSettings.tsx   # filter, keamanan, entry/exit, rem pengaman, biaya, simulasi
    │   ├── AutoPilotLiveDialog.tsx # konfirmasi sebelum memakai uang asli
    │   ├── WalletDialogs.tsx       # create / import / unlock / export / kunci akses
    │   ├── Toaster.tsx
    │   └── ui.tsx                  # Button, Input, Panel, Badge, Modal, Toggle, Stat
    ├── hooks/
    │   ├── useAutoSell.ts          # mesin Auto TP / SL / Trailing Stop
    │   ├── useAutoPilot.ts         # menghubungkan mesin Auto-Pilot ke halaman + wake lock
    │   ├── usePositions.ts         # saldo on-chain + jurnal + harga live → PnL
    │   ├── usePriceFeed.ts         # berlangganan price feed bersama
    │   ├── useTokenScan.ts · useTokenBalance.ts · useRpcHealth.ts
    │   ├── useWalletBootstrap.ts   # saldo SOL live, auto-lock, unlock audio
    │   └── useNow.ts
    ├── lib/
    │   ├── rpc.ts · wallet.ts · scanner.ts · swap.ts      # mesin inti (tahap 2)
    │   ├── price-feed.ts           # SATU polling DexScreener 2 dtk untuk semua mint
    │   ├── trade-actions.ts        # jalur eksekusi tunggal: manual, panic, auto-sell, Auto-Pilot
    │   ├── auto-sell-eval.ts       # evaluasi murni TP/SL/trailing (dipakai uang asli & latihan)
    │   ├── autopilot/
    │   │   ├── config.ts           # pengaturan + default gaya (b) + sanitasi
    │   │   ├── sources.ts          # Jupiter Trending/Top Traded, DexScreener Metas/Boosts, data market
    │   │   ├── strategy.ts         # filter, metrik, skor, verdict keamanan
    │   │   ├── paper.ts            # simulasi fill: price impact x·y=k, fee LP, penalti, fee+tip
    │   │   ├── guardrails.ts       # rem berhenti (rugi harian/beruntun) & rem kapasitas
    │   │   ├── stats.ts            # win rate, profit factor, drawdown, export CSV
    │   │   ├── types.ts
    │   │   └── engine.ts           # siklus penemuan, entry, pengelolaan posisi, stop darurat
    │   ├── heartbeat.ts · sound.ts · format.ts
    │   └── server/guard.ts
    └── store/                      # zustand
        ├── settings-store.ts       # slippage, fee, tip, mode kirim (persist)
        ├── journal-store.ts        # jurnal trade → harga beli rata-rata & realized PnL (persist)
        ├── auto-sell-store.ts      # aturan TP/SL + status level tereksekusi (persist)
        ├── autopilot-store.ts      # pengaturan, mode, posisi latihan/asli, riwayat, log (persist)
        ├── wallet-store.ts · trade-store.ts · toast-store.ts · ui-store.ts
```

## Status

1. ✅ Konfigurasi proyek
2. ✅ Mesin inti: wallet terenkripsi, scanner, swap Jupiter V2 + Jito
3. ✅ UI terminal + Auto TP/SL/Trailing + posisi & PnL
4. ✅ Deploy Vercel / Netlify (env check saat build, Node 24)
5. ✅ Auto-Pilot gaya (b): cari token → filter → cek keamanan → beli → TP/SL/batas waktu, mode latihan & uang asli
