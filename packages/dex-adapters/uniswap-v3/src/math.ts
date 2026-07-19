import { Decimal } from "decimal.js";

Decimal.set({ precision: 50 });

const Q96 = new Decimal(2).pow(96);

/**
 * slot0のsqrtPriceX96から「入力raw 1あたりの出力raw」を求める。
 * zeroForOne = true: token0 -> token1
 */
export function rawOutPerRawIn(
  sqrtPriceX96: bigint,
  zeroForOne: boolean,
): Decimal {
  const priceToken1PerToken0 = new Decimal(sqrtPriceX96.toString())
    .div(Q96)
    .pow(2);
  return zeroForOne
    ? priceToken1PerToken0
    : new Decimal(1).div(priceToken1PerToken0);
}

/**
 * スポット価格・LP手数料から理想出力を計算し、実Quoteとの差を価格影響(bps)として返す。
 * 理想出力に手数料を織り込むため、返る値は純粋なスリッページ（手数料除く）。
 */
export function computeIdealOutRaw(
  amountInRaw: bigint,
  hops: { sqrtPriceX96: bigint; zeroForOne: boolean; feeRaw: number }[],
): Decimal {
  let out = new Decimal(amountInRaw.toString());
  for (const hop of hops) {
    out = out
      .mul(rawOutPerRawIn(hop.sqrtPriceX96, hop.zeroForOne))
      .mul(new Decimal(1).minus(new Decimal(hop.feeRaw).div(1_000_000)));
  }
  return out;
}

export function priceImpactBps(
  idealOutRaw: Decimal,
  actualOutRaw: bigint,
): number {
  if (idealOutRaw.lte(0)) return 0;
  const impact = new Decimal(1)
    .minus(new Decimal(actualOutRaw.toString()).div(idealOutRaw))
    .mul(10_000);
  return Math.max(0, Math.round(impact.toNumber()));
}
