import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js/min";

export type { CountryCode };

/** Normalise user input to E.164 (e.g. "+919812345678"), or null if it is not a valid number. */
export function normalizePhone(input: string, defaultRegion: CountryCode): string | null {
  const parsed = parsePhoneNumberFromString(input, defaultRegion);
  return parsed?.isValid() ? parsed.number : null;
}
