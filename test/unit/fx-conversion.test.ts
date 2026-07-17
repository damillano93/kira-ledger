import { describe, expect, it } from 'vitest';
import {
  feeFromBps,
  quoteUsdcToUsd,
  usdcMinorToUsdCents,
} from '../../src/domain/offramp.js';

// The USDC->USD conversion is a pure decimals problem: 6dp -> 2dp at stablecoin
// par, scale factor 10^4. These specs pin the arithmetic down exactly — mixed
// decimal places are where money silently leaks.

describe('usdcMinorToUsdCents — 6dp -> 2dp at par', () => {
  it('converts the flagship amount exactly: 5,000 USDC -> 500,000 cents', () => {
    expect(usdcMinorToUsdCents(5_000_000_000n)).toBe(500_000n);
  });

  it('floors sub-cent dust (never credits fractional cents = never creates money)', () => {
    // 1.234567 USDC = 123.4567 cents -> 123 (the 0.4567 residue stays observable
    // on the conversion account, per ADR-008's residue rule)
    expect(usdcMinorToUsdCents(1_234_567n)).toBe(123n);
    // 0.009999 USDC -> 0 cents
    expect(usdcMinorToUsdCents(9_999n)).toBe(0n);
    // exactly one cent worth of USDC minor units
    expect(usdcMinorToUsdCents(10_000n)).toBe(1n);
  });

  it('is exact far beyond Number.MAX_SAFE_INTEGER (BigInt end to end)', () => {
    // 10 billion USDC — 10_000_000_000 * 10^6 minor units
    expect(usdcMinorToUsdCents(10_000_000_000_000_000n)).toBe(1_000_000_000_000n);
  });

  it('rejects negative amounts', () => {
    expect(() => usdcMinorToUsdCents(-1n)).toThrow(/negative/);
  });
});

describe('feeFromBps — basis points with round-half-even (ADR-008)', () => {
  it('computes the default 1% (100 bps) exactly on the flagship amount', () => {
    expect(feeFromBps(500_000n, 100)).toBe(5_000n);
  });

  it("rounds the ADR-008 worked tie to even: 50 bps of $445.00 -> $2.22, not $2.23", () => {
    expect(feeFromBps(44_500n, 50)).toBe(222n);
  });

  it('rounds ties to even in both directions', () => {
    expect(feeFromBps(1_800n, 25)).toBe(4n); // 4.5 -> 4 (even)
    expect(feeFromBps(2_200n, 25)).toBe(6n); // 5.5 -> 6 (even)
  });

  it('rounds non-ties to nearest', () => {
    expect(feeFromBps(1_000n, 33)).toBe(3n); // 3.3 -> 3
    expect(feeFromBps(1_000n, 37)).toBe(4n); // 3.7 -> 4
  });

  it('handles the bounds: 0 bps and 10000 bps', () => {
    expect(feeFromBps(500_000n, 0)).toBe(0n);
    expect(feeFromBps(500_000n, 10_000)).toBe(500_000n);
  });

  it('rejects out-of-range or fractional bps', () => {
    expect(() => feeFromBps(100n, -1)).toThrow();
    expect(() => feeFromBps(100n, 10_001)).toThrow();
    expect(() => feeFromBps(100n, 1.5)).toThrow();
  });
});

describe('quoteUsdcToUsd — the full conversion quote', () => {
  it('5,000 USDC at 100 bps: gross 500,000 / fee 5,000 / net 495,000 cents', () => {
    const q = quoteUsdcToUsd(5_000_000_000n, 100);
    expect(q).toEqual({
      grossUsdcMinor: 5_000_000_000n,
      grossUsdCents: 500_000n,
      feeUsdCents: 5_000n,
      netUsdCents: 495_000n,
    });
    // conservation on the USD leg: net + fee == gross, always
    expect(q.netUsdCents + q.feeUsdCents).toBe(q.grossUsdCents);
  });

  it('fee is computed on the FLOORED cent value, not the raw USDC units', () => {
    // 1.234567 USDC -> 123 cents; 100 bps of 123 = 1.23 -> 1 cent
    const q = quoteUsdcToUsd(1_234_567n, 100);
    expect(q.grossUsdCents).toBe(123n);
    expect(q.feeUsdCents).toBe(1n);
    expect(q.netUsdCents).toBe(122n);
  });

  it('refuses dust that rounds to zero USD (no zero-amount ledger legs)', () => {
    expect(() => quoteUsdcToUsd(9_999n, 100)).toThrow(/too small/);
  });

  it('refuses non-positive amounts', () => {
    expect(() => quoteUsdcToUsd(0n, 100)).toThrow(/positive/);
    expect(() => quoteUsdcToUsd(-5n, 100)).toThrow(/positive/);
  });
});
