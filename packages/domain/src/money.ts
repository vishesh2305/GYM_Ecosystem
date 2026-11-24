// All money is an integer number of minor units (paise, cents). Never floats.

function assertMinor(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer, got ${value}`);
  }
}

/**
 * Split `total` by integer `ratios` without losing or creating a single minor unit.
 * Leftover units go to the largest remainders; ties go to the earlier index.
 */
export function allocate(total: number, ratios: readonly number[]): number[] {
  assertMinor(total, "total");
  if (ratios.length === 0) throw new RangeError("ratios must not be empty");
  ratios.forEach((r, i) => assertMinor(r, `ratios[${i}]`));
  const sum = ratios.reduce((a, b) => a + b, 0);
  if (sum === 0) throw new RangeError("at least one ratio must be positive");

  // Integer arithmetic only: floor and remainder via %, so no float rounding errors.
  const shares = ratios.map((r, index) => {
    const scaled = total * r;
    if (!Number.isSafeInteger(scaled))
      throw new RangeError("total * ratio exceeds safe integer range");
    const remainder = scaled % sum;
    return { index, floor: (scaled - remainder) / sum, remainder };
  });

  let leftover = total - shares.reduce((a, s) => a + s.floor, 0);
  const order = [...shares].sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const share of order) {
    if (leftover === 0) break;
    if (share.remainder > 0) {
      share.floor += 1;
      leftover -= 1;
    }
  }
  return shares.map((s) => s.floor);
}

/** amount × basisPoints / 10,000, rounded half up. 1800 bp = 18% GST. */
export function applyBasisPoints(amount: number, basisPoints: number): number {
  assertMinor(amount, "amount");
  assertMinor(basisPoints, "basisPoints");
  const scaled = amount * basisPoints + 5000;
  if (!Number.isSafeInteger(scaled))
    throw new RangeError("amount * basisPoints exceeds safe integer range");
  return (scaled - (scaled % 10_000)) / 10_000;
}
