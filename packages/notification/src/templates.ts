/**
 * 通知テンプレート（仕様書§10準拠・監視モニター向け日本語表現）。
 *
 * 方針（2026-07-19 仁さん指示）:
 * - 機械的な数字の羅列にせず、意味と文脈を日本語で説明する
 * - 友人など非エンジニアの読者にも伝わる表現にする
 * - ただし「参考値 / 実行可能値 / 純利益」の区別は絶対に崩さない（§1）
 */

function usd(v: string | number | null): string {
  if (v === null) return "不明";
  const n = typeof v === "string" ? Number(v) : v;
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function jstNow(): string {
  return new Date().toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatInfo(params: {
  divergencePct: number;
  paxgUsd: number | null;
  xautUsd: number | null;
}): string {
  return [
    "🟡 金トークンの価格に開きが出ています",
    "",
    `2つの金トークン（PAXGとXAUT）の取引所価格に ${params.divergencePct.toFixed(2)}% の差が発生しました。`,
    "",
    `　PAXG（パクソス・ゴールド）: $${usd(params.paxgUsd)}`,
    `　XAUT（テザー・ゴールド）: $${usd(params.xautUsd)}`,
    "",
    "⚠️ これは取引所の「表示価格」の差にすぎません。実際に売買して取れる利益とは別物です。",
    "",
    "システムはこれを合図に、実際のDEX（分散型取引所）へ全金額パターンの精密見積もりを開始しました。本当に利益が出る状態になれば 🟠 や 🟢 で続報します。",
    "",
    `${jstNow()} JST`,
  ].join("\n");
}

export function formatOpportunity(params: {
  routeDescription: string;
  amountUsd: number;
  inputSymbol: string;
  executableDivergencePct: string | null;
  grossProfitUsd: string | null;
  gasCostExpectedUsd: string | null;
  netProfitUsd: string | null;
  blockNumber: bigint;
  rejectionReasons: string[];
}): string {
  const divergence = params.executableDivergencePct
    ? `${Number(params.executableDivergencePct) >= 0 ? "+" : ""}${params.executableDivergencePct}%`
    : "不明";
  return [
    "🟠 「実際に交換してもプラス」の瞬間を検出",
    "",
    "表示価格だけでなく、DEXに実際の数量で見積もりを取った結果、一周してプラスになるルートが見つかりました。",
    "",
    `　ルート: ${params.routeDescription}`,
    `　元本: ${usd(params.amountUsd)} ${params.inputSymbol} を投入`,
    `　往復結果: ${divergence}（板の厚み・DEX手数料込みの実測値）`,
    `　粗利益: ${usd(params.grossProfitUsd)} ドル`,
    "",
    `ただし、ガス代（Ethereumの手数料、想定 ${usd(params.gasCostExpectedUsd)} ドル）と安全マージンを差し引くと、純利益見込みは ${usd(params.netProfitUsd)} ドル。通知基準（純利益25ドル以上など）には届かず、「惜しい機会」として記録しました。`,
    "",
    `ブロック番号: ${params.blockNumber} / ${jstNow()} JST`,
  ].join("\n");
}

export function formatProfitable(params: {
  routeDescription: string;
  amountUsd: number;
  inputSymbol: string;
  amountOutUsd: string | null;
  grossProfitUsd: string | null;
  gasCostHighUsd: string | null;
  safetyBufferUsd: string;
  netProfitUsd: string | null;
  netProfitPct: string | null;
  maxPriceImpactBps: number | null;
  blockNumber: bigint;
  opportunityId: string;
}): string {
  return [
    "🟢 本物の裁定機会を検出しました！",
    "",
    "全コストを差し引いても利益が残る、正真正銘の裁定チャンスです。30日測定で数えるべき「本物の機会」としてカウントします。",
    "",
    `　ルート: ${params.routeDescription}`,
    `　元本: ${usd(params.amountUsd)} ${params.inputSymbol}`,
    `　一周後: ${usd(params.amountOutUsd)} ${params.inputSymbol}`,
    "",
    `　粗利益:　　　　 +${usd(params.grossProfitUsd)} ドル`,
    `　ガス代(高め見積): -${usd(params.gasCostHighUsd)} ドル`,
    `　安全マージン:　　-${usd(params.safetyBufferUsd)} ドル`,
    "　──────────────",
    `　純利益見込み:　 +${usd(params.netProfitUsd)} ドル（${params.netProfitPct ?? "?"}%）`,
    "",
    `ブロック番号: ${params.blockNumber} / 機会ID: ${params.opportunityId}`,
    `${jstNow()} JST`,
    "",
    "※このシステムは監視専用です。実際の取引は一切行っていません。",
  ].join("\n");
}

export function formatSystem(event: string, detail?: string): string {
  return [
    `⚙️ システム通知: ${event}`,
    ...(detail ? ["", detail] : []),
    "",
    `${jstNow()} JST`,
  ].join("\n");
}

/** Worker起動時の自己紹介つき通知 */
export function formatBoot(params: {
  workerId: string;
  phase: number;
}): string {
  return [
    "📡 pax 監視システム 起動しました",
    "",
    "Ethereumブロックチェーンへの接続が完了し、金トークン（PAXG / XAUT）の裁定監視を開始します。",
    "",
    "【このシステムがやっていること】",
    "約12秒ごと（新しいブロックが生まれるたび）に、8種類の交換ルートへ「今、実際に交換したらいくら戻ってくるか」をDEXに問い合わせて記録しています。",
    "",
    "【通知の見方】",
    "🟡 = 表示価格に差が出た（まだ儲かるとは言えない）",
    "🟠 = 実際に交換してもプラスの瞬間（ただしガス代で消える）",
    "🟢 = 全コスト込みでも利益が残る本物の機会",
    "🚨 = システム停止の警報",
    "",
    "通知が静かな間は「儲かる機会が存在しない」ことを毎ブロック確認し続けている状態です。それ自体が貴重な測定データになります。",
    "",
    `worker: ${params.workerId} / Phase ${params.phase}（監視のみ・実取引なし）`,
    `${jstNow()} JST`,
  ].join("\n");
}
