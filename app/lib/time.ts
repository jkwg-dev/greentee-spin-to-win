/**
 * Minimal wall-clock helpers for a fixed UTC offset, so we do not need a date
 * library or the runtime's time zone data for two conversions.
 */

const WALL_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/;

const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;

const OFFSET = /^([+-])(\d{2}):(\d{2})$/;

/** "-07:00" -> -420. */
export function offsetMinutes(offset: string): number {
  const m = OFFSET.exec(offset);
  if (!m) throw new Error(`Invalid UTC offset: ${offset}`);
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === "-" ? -minutes : minutes;
}

/**
 * Parses an ISO-8601 string. If it carries an explicit offset or `Z`, it is
 * taken literally. Otherwise it is treated as wall-clock time at `offset`
 * (e.g. "-07:00"), whatever the date.
 */
export function parseAtOffset(input: string, offset: string): Date {
  const trimmed = input.trim();
  if (HAS_OFFSET.test(trimmed)) {
    const d = new Date(trimmed);
    if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${input}`);
    return d;
  }
  const m = WALL_TIME.exec(trimmed);
  if (!m) throw new Error(`Invalid date: ${input}`);
  const [, y, mo, d, h = "0", mi = "0", s = "0", ms = "0"] = m;
  const wallAsUtc = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
    Number(ms.padEnd(3, "0")),
  );
  const result = new Date(wallAsUtc - offsetMinutes(offset) * 60_000);
  if (Number.isNaN(result.getTime())) throw new Error(`Invalid date: ${input}`);
  return result;
}
