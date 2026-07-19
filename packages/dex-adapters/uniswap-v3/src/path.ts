import { concatHex, numberToHex, keccak256, encodePacked } from "viem";
import type { Address, Hex } from "@pax/shared-types";

/**
 * Uniswap V3マルチホップpath: token0 ++ fee(uint24) ++ token1 ++ fee ++ token2 ...
 */
export function encodePath(tokens: Address[], feesRaw: number[]): Hex {
  if (tokens.length < 2) throw new Error("path needs >= 2 tokens");
  if (feesRaw.length !== tokens.length - 1) {
    throw new Error(
      `fee count mismatch: ${feesRaw.length} fees for ${tokens.length} tokens`,
    );
  }
  const parts: Hex[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) throw new Error("invalid token in path");
    parts.push(token);
    if (i < feesRaw.length) {
      const fee = feesRaw[i];
      if (fee === undefined) throw new Error("invalid fee in path");
      parts.push(numberToHex(fee, { size: 3 }));
    }
  }
  return concatHex(parts);
}

/** exact output用: pathを逆順にエンコード（Uniswap仕様） */
export function encodePathReversed(tokens: Address[], feesRaw: number[]): Hex {
  return encodePath([...tokens].reverse(), [...feesRaw].reverse());
}

/** DB保存・重複排除に使うルート識別子（大文字小文字に依存しない） */
export function computeRouteHash(dex: string, route: Address[]): string {
  const normalized = route.map((a) => a.toLowerCase() as Address);
  return keccak256(encodePacked(["string", "address[]"], [dex, normalized]));
}
