/**
 * 判定閾値の初期値（仕様書 §9）。
 * 実行時は arb.system_config の値が優先され、ここはフォールバック。
 */
export const DEFAULT_THRESHOLDS = {
  referenceAlertPct: "0.50",
  executableAlertPct: "0.50",
  minimumNetProfitUsd: "25",
  minimumNetProfitPct: "0.10",
  maximumPriceImpactPct: "0.30",
  maximumQuoteAgeBlocks: 1,
  maximumQuoteLatencyMs: 3000,
  alertCooldownSeconds: 300,
  recoveryThresholdPct: "0.35",
} as const;

/**
 * トリガー式Quote戦略（設計議論 2026-07-19 で追加）:
 * CEX参考乖離がこの値未満の間はQuoteを縮退モードで実行し、RPC消費を抑える。
 */
export const QUOTE_TRIGGER = {
  /** この参考乖離(%)以上で全ルート×全金額のQuoteバーストへ昇格 */
  fullQuoteTriggerPct: "0.30",
  /** 縮退モード時のQuote間隔（ブロック数） */
  degradedModeBlockInterval: 30,
  /** 縮退モードでもQuoteする金額（USD） */
  degradedModeAmountsUsd: [10_000] as readonly number[],
} as const;
