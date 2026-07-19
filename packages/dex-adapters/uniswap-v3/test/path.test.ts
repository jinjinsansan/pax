import { describe, expect, it } from "vitest";
import type { Address } from "@pax/shared-types";
import { encodePath, encodePathReversed, computeRouteHash } from "../src/path.js";

const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7" as Address;
const PAXG = "0x45804880DE22913DAFE09F4980848ECE6ECBAF78" as Address;
const XAUT = "0x68749665FF8D2D112FA859AA293F07A622782F38" as Address;

describe("encodePath", () => {
  it("2トークン1ホップ: address(20) + fee(3) + address(20) = 43 bytes", () => {
    const path = encodePath([USDT, PAXG], [500]);
    expect(path.length).toBe(2 + 43 * 2);
    expect(path.toLowerCase()).toBe(
      ("0x" + USDT.slice(2) + "0001f4" + PAXG.slice(2)).toLowerCase(),
    );
  });

  it("3トークン2ホップ: 66 bytes", () => {
    const path = encodePath([USDT, PAXG, XAUT], [500, 100]);
    expect(path.length).toBe(2 + 66 * 2);
    expect(path.toLowerCase()).toContain("0001f4"); // fee 500
    expect(path.toLowerCase()).toContain("000064"); // fee 100
  });

  it("fee数がホップ数と合わないとthrow", () => {
    expect(() => encodePath([USDT, PAXG], [500, 100])).toThrow(/mismatch/);
  });

  it("encodePathReversedはトークン・feeとも逆順", () => {
    const fwd = encodePath([USDT, PAXG, XAUT], [500, 100]);
    const rev = encodePathReversed([USDT, PAXG, XAUT], [500, 100]);
    expect(rev.toLowerCase()).toBe(
      (
        "0x" +
        XAUT.slice(2) +
        "000064" +
        PAXG.slice(2) +
        "0001f4" +
        USDT.slice(2)
      ).toLowerCase(),
    );
    expect(rev).not.toBe(fwd);
  });
});

describe("computeRouteHash", () => {
  it("決定的で、ルート順序に依存する", () => {
    const h1 = computeRouteHash("uniswap-v3", [USDT, PAXG, XAUT, USDT]);
    const h2 = computeRouteHash("uniswap-v3", [USDT, PAXG, XAUT, USDT]);
    const h3 = computeRouteHash("uniswap-v3", [USDT, XAUT, PAXG, USDT]);
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h1).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
