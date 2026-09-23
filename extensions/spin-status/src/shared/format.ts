import { CAMPAIGN_TIMEZONE } from "../../../../app/config/campaign";

/** "November 2, 2026 at 9:00 a.m. PST" style, always in the campaign's zone. */
export function formatExpiry(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: CAMPAIGN_TIMEZONE,
    dateStyle: "long",
    timeStyle: "short",
  }).format(date);
}
