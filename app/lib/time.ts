/**
 * Minimal IANA time zone helpers built on Intl, so we do not need a date
 * library for two conversions.
 */

const WALL_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/;

const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;

function offsetMinutesAt(utcMillis: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMillis));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return Math.round((asUtc - utcMillis) / 60_000);
}

/**
 * Parses an ISO-8601 string. If it carries an explicit offset or `Z`, it is
 * taken literally. Otherwise it is treated as wall-clock time in `timeZone`.
 * Handles DST transitions by resolving the offset twice.
 */
export function parseInZone(input: string, timeZone: string): Date {
  const trimmed = input.trim();
  if (HAS_OFFSET.test(trimmed)) {
    const d = new Date(trimmed);
    if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${input}`);
    return d;
  }
  const m = WALL_TIME.exec(trimmed);
  if (!m) throw new Error(`Invalid date: ${input}`);
  const [, y, mo, d, h = "0", mi = "0", s = "0", ms = "0"] = m;
  const guess = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
    Number(ms.padEnd(3, "0")),
  );
  const first = guess - offsetMinutesAt(guess, timeZone) * 60_000;
  const second = guess - offsetMinutesAt(first, timeZone) * 60_000;
  const result = new Date(second);
  if (Number.isNaN(result.getTime())) throw new Error(`Invalid date: ${input}`);
  return result;
}

/** Formats an instant for humans in the given zone, e.g. "Nov 2, 2026, 9:00 AM PST". */
export function formatInZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
