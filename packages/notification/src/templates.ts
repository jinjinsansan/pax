/**
 * 通知テンプレート（仕様書§10の書式に準拠）。
 * 0.5%の乖離を0.5%の利益として表示してはならない（§1）—
 * すべてのテンプレートで参考値/実行可能値/純利益を明示的に区別する。
 */

function usd(v: string | number | null): string {
  if (v === null) return "N/A";
  const n = typeof v === "string" ? Number(v) : v;
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatInfo(params: {
  divergencePct: number;
  paxgUsd: number | null;
  xautUsd: number | null;
}): string {
  return [
    "🟡 PAXG/XAUT 参考価格乖離",
    "",
    `乖離率: ${params.divergencePct.toFixed(2)}%`,
    `PAXG: $${usd(params.paxgUsd)}`,
    `XAUT: $${usd(params.xautUsd)}`,
    `時刻: ${new Date().toISOString()} (UTC)`,
    "",
    "注意: 外部参考価格の差であり、約定可能利益ではありません。",
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
  return [
    "🟠 実行可能価格乖離を検出",
    "",
    `方向: ${params.routeDescription}`,
    `想定元本: ${usd(params.amountUsd)} ${params.inputSymbol}`,
    `実行可能乖離: ${params.executableDivergencePct ?? "N/A"}%`,
    `粗利益: ${usd(params.grossProfitUsd)} ${params.inputSymbol}`,
    `想定ガス: ${usd(params.gasCostExpectedUsd)} USD`,
    `純利益見込: ${usd(params.netProfitUsd)} USD`,
    `ブロック: ${params.blockNumber}`,
    "",
    `判定: 純利益条件未達 (${params.rejectionReasons.join(", ") || "-"})`,
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
  const impactPct =
    params.maxPriceImpactBps !== null
      ? (params.maxPriceImpactBps / 100).toFixed(2)
      : "N/A";
  return [
    "🟢 純利益機会を検出",
    "",
    `方向: ${params.routeDescription}`,
    `想定元本: ${usd(params.amountUsd)} ${params.inputSymbol}`,
    `最終見込: ${usd(params.amountOutUsd)} ${params.inputSymbol}`,
    `粗利益: ${usd(params.grossProfitUsd)} ${params.inputSymbol}`,
    `ガス見込（High）: ${usd(params.gasCostHighUsd)} USD`,
    `安全マージン: ${usd(params.safetyBufferUsd)} USD`,
    `純利益見込: ${usd(params.netProfitUsd)} USD`,
    `純利益率: ${params.netProfitPct ?? "N/A"}%`,
    `最大価格影響: ${impactPct}%`,
    `ブロック: ${params.blockNumber}`,
    `機会ID: ${params.opportunityId}`,
    "",
    "監視のみ。取引は実行されていません。",
  ].join("\n");
}

export function formatSystem(event: string, detail?: string): string {
  return [
    `⚙️ SYSTEM: ${event}`,
    ...(detail ? ["", detail] : []),
    "",
    `時刻: ${new Date().toISOString()} (UTC)`,
  ].join("\n");
}
