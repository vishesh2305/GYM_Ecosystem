import { addDays, addMonths } from "./dates";
import { applyBasisPoints } from "./money";

export type DurationUnit = "day" | "month";

/** Indian GST slabs in basis points (18% = 1800). Gym memberships are usually 18%. */
export const GST_RATES_BPS = [0, 500, 1200, 1800, 2800] as const;

/** Inclusive last day of a membership that starts on `start`. */
export function planEndDate(
  start: string,
  duration: { unit: DurationUnit; count: number },
): string {
  return duration.unit === "day"
    ? addDays(start, duration.count - 1)
    : addDays(addMonths(start, duration.count), -1);
}

export interface PriceBreakdown {
  pricePaise: number;
  joiningFeePaise: number;
  /** Price + joining fee: the amount GST applies to. */
  taxablePaise: number;
  gstPaise: number;
  totalPaise: number;
}

/** Plan prices are stored before GST; this is what the member pays. */
export function priceBreakdown(input: {
  pricePaise: number;
  joiningFeePaise: number;
  gstRateBps: number;
}): PriceBreakdown {
  if (!(GST_RATES_BPS as readonly number[]).includes(input.gstRateBps)) {
    throw new RangeError(`GST rate must be one of ${GST_RATES_BPS.join(", ")} basis points`);
  }
  const taxablePaise = input.pricePaise + input.joiningFeePaise;
  const gstPaise = applyBasisPoints(taxablePaise, input.gstRateBps);
  return {
    pricePaise: input.pricePaise,
    joiningFeePaise: input.joiningFeePaise,
    taxablePaise,
    gstPaise,
    totalPaise: taxablePaise + gstPaise,
  };
}
