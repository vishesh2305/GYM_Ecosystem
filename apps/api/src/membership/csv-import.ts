import { isDate } from "@gym/domain";
import { parse } from "csv-parse/sync";

export const MAX_IMPORT_ROWS = 10_000;
const COLUMNS = [
  "name",
  "phone",
  "email",
  "gender",
  "date_of_birth",
  "branch",
  "plan",
  "start_date",
  "end_date",
] as const;
export type ImportRow = Partial<Record<(typeof COLUMNS)[number], string>>;

/** "Date of birth" → "date_of_birth". */
const columnKey = (header: string) =>
  header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

/** Parse CSV text into rows keyed by known column names. Throws a readable Error for unusable files. */
export function parseMemberCsv(csv: string): ImportRow[] {
  let records: Record<string, string>[];
  try {
    records = parse(csv, {
      columns: (h: string[]) => h.map(columnKey),
      bom: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    });
  } catch (error) {
    throw new Error(`The file could not be read as CSV: ${(error as Error).message}`);
  }
  if (!records.length) throw new Error("The file has no member rows");
  if (!Object.hasOwn(records[0] ?? {}, "name")) throw new Error('The file needs a "Name" column');
  if (records.length > MAX_IMPORT_ROWS)
    throw new Error(`A file can have at most ${MAX_IMPORT_ROWS} rows; split it into smaller files`);
  return records.map(
    (r) => Object.fromEntries(COLUMNS.filter((c) => r[c]).map((c) => [c, r[c]])) as ImportRow,
  );
}

/** Accepts 2026-03-12, 12/03/2026 and 12-03-2026 (day first, as written in India). */
export function parseImportDate(value: string): string | null {
  const dayFirst = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(value);
  const iso = dayFirst
    ? `${dayFirst[3]}-${dayFirst[2]?.padStart(2, "0")}-${dayFirst[1]?.padStart(2, "0")}`
    : value;
  return isDate(iso) ? iso : null;
}
