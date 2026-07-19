import type { PublicClient } from "viem";
import { zeroAddress } from "viem";
import type {
  Address,
  DexAdapter,
  PoolDescriptor,
  PoolState,
  QuoteInput,
  QuoteOutput,
  QuoteResult,
} from "@pax/shared-types";
import { factoryAbi, poolAbi, quoterV2Abi } from "./abis.js";
import {
  FEE_TIERS,
  SWAP_GAS_OVERHEAD,
  UNISWAP_V3_FACTORY,
  UNISWAP_V3_QUOTER_V2,
} from "./constants.js";
import { encodePath, encodePathReversed, computeRouteHash } from "./path.js";
import { computeIdealOutRaw, priceImpactBps } from "./math.js";

interface PoolInfo {
  address: Address;
  token0: Address;
  token1: Address;
  feeRaw: number;
  liquidity: bigint;
}

function pairKey(a: Address, b: Address): string {
  const [lo, hi] = [a.toLowerCase(), b.toLowerCase()].sort();
  return `${lo}:${hi}`;
}

/**
 * Uniswap V3アダプター（仕様書§6）。
 * - discoverPools: 全fee tierを走査し流動性のあるプールを返す
 * - getQuoteExactInput: マルチホップrouteをQuoterV2でQuote（同一ブロックにpin）
 * - 価格影響: 同一ブロックのslot0スポットとの比較（LP手数料は理想値に織込み済み）
 */
export class UniswapV3Adapter implements DexAdapter {
  readonly name = "uniswap-v3";

  /** pair -> 最良（最大流動性）プール。ensurePoolsForRouteで更新 */
  private readonly bestPools = new Map<string, PoolInfo>();

  constructor(private readonly client: PublicClient) {}

  async discoverPools(
    tokenA: Address,
    tokenB: Address,
  ): Promise<PoolDescriptor[]> {
    const addressCalls = FEE_TIERS.map((fee) => ({
      address: UNISWAP_V3_FACTORY,
      abi: factoryAbi,
      functionName: "getPool" as const,
      args: [tokenA, tokenB, fee] as const,
    }));
    const addresses = await this.client.multicall({
      contracts: addressCalls,
      allowFailure: true,
    });

    const found: { address: Address; feeRaw: number }[] = [];
    addresses.forEach((res, i) => {
      const fee = FEE_TIERS[i];
      if (
        fee !== undefined &&
        res.status === "success" &&
        res.result !== zeroAddress
      ) {
        found.push({ address: res.result as Address, feeRaw: fee });
      }
    });
    if (found.length === 0) return [];

    const stateCalls = found.flatMap((p) => [
      { address: p.address, abi: poolAbi, functionName: "liquidity" as const },
      { address: p.address, abi: poolAbi, functionName: "token0" as const },
      { address: p.address, abi: poolAbi, functionName: "token1" as const },
    ]);
    const states = await this.client.multicall({
      contracts: stateCalls,
      allowFailure: true,
    });

    const descriptors: PoolDescriptor[] = [];
    found.forEach((p, i) => {
      const liq = states[i * 3];
      const t0 = states[i * 3 + 1];
      const t1 = states[i * 3 + 2];
      if (
        liq?.status === "success" &&
        t0?.status === "success" &&
        t1?.status === "success"
      ) {
        const liquidity = liq.result as bigint;
        descriptors.push({
          dex: this.name,
          address: p.address,
          token0: t0.result as Address,
          token1: t1.result as Address,
          feeTierBps: p.feeRaw / 100,
          metadata: { feeRaw: p.feeRaw, liquidity: liquidity.toString() },
        });
      }
    });
    return descriptors;
  }

  /** route内の全隣接ペアについて最大流動性プールをキャッシュする */
  async ensurePoolsForRoute(route: Address[]): Promise<void> {
    for (let i = 0; i < route.length - 1; i += 1) {
      const a = route[i];
      const b = route[i + 1];
      if (!a || !b) continue;
      const key = pairKey(a, b);
      if (this.bestPools.has(key)) continue;
      const pools = await this.discoverPools(a, b);
      let best: PoolInfo | null = null;
      for (const d of pools) {
        const liquidity = BigInt(
          (d.metadata as { liquidity: string }).liquidity,
        );
        const feeRaw = (d.metadata as { feeRaw: number }).feeRaw;
        if (liquidity > 0n && (!best || liquidity > best.liquidity)) {
          best = {
            address: d.address,
            token0: d.token0,
            token1: d.token1,
            feeRaw,
            liquidity,
          };
        }
      }
      if (best) this.bestPools.set(key, best);
    }
  }

  /** キャッシュ破棄（定期リフレッシュ用） */
  invalidatePoolCache(): void {
    this.bestPools.clear();
  }

  private hopsForRoute(
    route: Address[],
  ): { pool: PoolInfo; zeroForOne: boolean }[] | { missingPair: string } {
    const hops: { pool: PoolInfo; zeroForOne: boolean }[] = [];
    for (let i = 0; i < route.length - 1; i += 1) {
      const tokenIn = route[i];
      const tokenOut = route[i + 1];
      if (!tokenIn || !tokenOut) return { missingPair: "invalid route" };
      const pool = this.bestPools.get(pairKey(tokenIn, tokenOut));
      if (!pool) return { missingPair: `${tokenIn}/${tokenOut}` };
      hops.push({
        pool,
        zeroForOne: pool.token0.toLowerCase() === tokenIn.toLowerCase(),
      });
    }
    return hops;
  }

  async getQuoteExactInput(params: QuoteInput): Promise<QuoteResult> {
    const started = Date.now();
    const blockNumber =
      params.blockNumber ?? (await this.client.getBlockNumber());
    const base: Omit<
      QuoteResult,
      "amountOutRaw" | "priceImpactBps" | "estimatedGasUnits" | "success"
    > = {
      chainId: 1,
      blockNumber,
      dex: this.name,
      route: params.route,
      amountInRaw: params.amountInRaw,
      amountInUsd: "0",
      amountOutUsd: "0",
      feeAmountUsd: "0",
      quoteLatencyMs: 0,
      source: "ONCHAIN_QUOTER",
    };

    await this.ensurePoolsForRoute(params.route);
    const hops = this.hopsForRoute(params.route);
    if ("missingPair" in hops) {
      return {
        ...base,
        amountOutRaw: 0n,
        priceImpactBps: 0,
        estimatedGasUnits: 0n,
        success: false,
        errorCode: `NO_POOL:${hops.missingPair}`,
        quoteLatencyMs: Date.now() - started,
      };
    }

    try {
      // 同一ブロックにpinしてslot0スポットとQuoteを取得（仕様書§6）
      const slot0Results = await this.client.multicall({
        contracts: hops.map((h) => ({
          address: h.pool.address,
          abi: poolAbi,
          functionName: "slot0" as const,
        })),
        allowFailure: false,
        blockNumber,
      });

      const path = encodePath(
        params.route,
        hops.map((h) => h.pool.feeRaw),
      );
      const [amountOut, , , gasEstimate] = (await this.client.readContract({
        address: UNISWAP_V3_QUOTER_V2,
        abi: quoterV2Abi,
        functionName: "quoteExactInput",
        args: [path, params.amountInRaw],
        blockNumber,
      })) as readonly [bigint, readonly bigint[], readonly number[], bigint];

      const ideal = computeIdealOutRaw(
        params.amountInRaw,
        hops.map((h, i) => {
          const slot0 = slot0Results[i] as readonly [
            bigint, number, number, number, number, number, boolean,
          ];
          return {
            sqrtPriceX96: slot0[0],
            zeroForOne: h.zeroForOne,
            feeRaw: h.pool.feeRaw,
          };
        }),
      );

      const firstHop = hops[0];
      return {
        ...base,
        ...(firstHop && hops.length === 1
          ? { poolAddress: firstHop.pool.address }
          : {}),
        amountOutRaw: amountOut,
        priceImpactBps: priceImpactBps(ideal, amountOut),
        estimatedGasUnits: gasEstimate + SWAP_GAS_OVERHEAD,
        success: true,
        quoteLatencyMs: Date.now() - started,
      };
    } catch (err) {
      return {
        ...base,
        amountOutRaw: 0n,
        priceImpactBps: 0,
        estimatedGasUnits: 0n,
        success: false,
        errorCode: truncateError(err),
        quoteLatencyMs: Date.now() - started,
      };
    }
  }

  async getQuoteExactOutput(params: QuoteOutput): Promise<QuoteResult> {
    const started = Date.now();
    const blockNumber =
      params.blockNumber ?? (await this.client.getBlockNumber());
    await this.ensurePoolsForRoute(params.route);
    const hops = this.hopsForRoute(params.route);
    const base = {
      chainId: 1 as const,
      blockNumber,
      dex: this.name,
      route: params.route,
      amountOutRaw: params.amountOutRaw,
      amountInUsd: "0",
      amountOutUsd: "0",
      feeAmountUsd: "0",
      priceImpactBps: 0,
      source: "ONCHAIN_QUOTER" as const,
    };
    if ("missingPair" in hops) {
      return {
        ...base,
        amountInRaw: 0n,
        estimatedGasUnits: 0n,
        success: false,
        errorCode: `NO_POOL:${hops.missingPair}`,
        quoteLatencyMs: Date.now() - started,
      };
    }
    try {
      const path = encodePathReversed(
        params.route,
        hops.map((h) => h.pool.feeRaw),
      );
      const [amountIn, , , gasEstimate] = (await this.client.readContract({
        address: UNISWAP_V3_QUOTER_V2,
        abi: quoterV2Abi,
        functionName: "quoteExactOutput",
        args: [path, params.amountOutRaw],
        blockNumber,
      })) as readonly [bigint, readonly bigint[], readonly number[], bigint];
      return {
        ...base,
        amountInRaw: amountIn,
        estimatedGasUnits: gasEstimate + SWAP_GAS_OVERHEAD,
        success: true,
        quoteLatencyMs: Date.now() - started,
      };
    } catch (err) {
      return {
        ...base,
        amountInRaw: 0n,
        estimatedGasUnits: 0n,
        success: false,
        errorCode: truncateError(err),
        quoteLatencyMs: Date.now() - started,
      };
    }
  }

  async getPoolState(pool: PoolDescriptor): Promise<PoolState> {
    const blockNumber = await this.client.getBlockNumber();
    const [slot0, liquidity] = await this.client.multicall({
      contracts: [
        { address: pool.address, abi: poolAbi, functionName: "slot0" as const },
        {
          address: pool.address,
          abi: poolAbi,
          functionName: "liquidity" as const,
        },
      ],
      allowFailure: false,
      blockNumber,
    });
    const s = slot0 as readonly [
      bigint, number, number, number, number, number, boolean,
    ];
    return {
      pool,
      blockNumber,
      sqrtPriceX96: s[0],
      tick: s[1],
      liquidity: liquidity as bigint,
      observedAt: new Date().toISOString(),
    };
  }

  async estimateSwapGas(params: QuoteInput): Promise<bigint> {
    const quote = await this.getQuoteExactInput(params);
    return quote.estimatedGasUnits;
  }
}

function truncateError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/\s+/g, " ").slice(0, 120);
}

export { computeRouteHash };
