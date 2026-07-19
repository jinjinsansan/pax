# pax — PAXG/XAUT Arbitrage Monitor

PAXG・XAUT間の価格乖離が、実際の約定条件と全コスト控除後にアービトラージとして成立するかを
オンチェーンQuoteに基づいて継続検証し、Telegramへ通知する監視システム。

**Phase 1: 監視・検証専用。実資金を一切動かさない。秘密鍵を保持しない。**
（`PRIVATE_KEY`が環境変数に設定されているとWorkerは起動を拒否します）

設計仕様: [`PAXG_XAUT_Arbitrage_Monitor_Design_Spec_v1.1.md`](./PAXG_XAUT_Arbitrage_Monitor_Design_Spec_v1.1.md)

## 3層の分離（最重要方針）

1. **Reference Divergence** — 外部参考価格（CEX/CoinGecko）の乖離。補助情報
2. **Executable Divergence** — DEXの実Quoteによる乖離（流動性・手数料・スリッページ込み）
3. **Net Arbitrage Profit** — ガス・安全マージン控除後の純利益

0.5%の乖離は0.5%の利益ではない。

## 構成

```
apps/       monitor-worker(VPS主系) / standby-worker(Render) / report-worker / dashboard(Vercel)
packages/   shared-types / chain-config / validation / quote-engine / opportunity-engine /
            dex-adapters / notification / database / observability
supabase/   migrations（arbスキーマ）
tools/      tx-inspector（Tx HashのERC-20 Transfer連鎖解析）
```

## 開発

```bash
pnpm install
pnpm check   # lint + typecheck + test + build
```

環境変数は `.env.example` をコピーして `.env.local` に置く。**実値をgitへ入れない。**
