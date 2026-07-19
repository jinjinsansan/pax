import { Decimal } from "decimal.js";

Decimal.set({ precision: 50 });

/** wei/gas単価の3シナリオ（仕様書§8.5。PROFITABLE判定はHighを使う） */
export interface GasPriceScenarios {
  lowWeiPerGas: bigint;
  expectedWeiPerGas: bigint;
  highWeiPerGas: bigint;
}

/**
 * ブロックのbase fee / priority feeからシナリオを構成する。
 *   Low:      baseFee + tip/2      （空いている想定）
 *   Expected: baseFee*1.25 + tip   （通常）
 *   High:     baseFee*2 + tip*2    （混雑・急変時）
 */
export function gasScenariosFromBlock(
  baseFeePerGas: bigint,
  priorityFeePerGas: bigint,
): GasPriceScenarios {
  return {
    lowWeiPerGas: baseFeePerGas + priorityFeePerGas / 2n,
    expectedWeiPerGas: (baseFeePerGas * 5n) / 4n + priorityFeePerGas,
    highWeiPerGas: baseFeePerGas * 2n + priorityFeePerGas * 2n,
  };
}

/** gas units × wei/gas × ETH/USD → USD文字列 */
export function gasCostUsd(
  gasUnits: bigint,
  weiPerGas: bigint,
  ethUsd: number,
): string {
  return new Decimal((gasUnits * weiPerGas).toString())
    .div(new Decimal(10).pow(18))
    .mul(ethUsd)
    .toFixed(4);
}
