import { CAMPAIGN_TIMEZONE } from "../../../../app/config/campaign";

/** "November 2, 2026 at 9:00 AM PST", always in the campaign's zone. en-US avoids "a.m." colliding with sentence periods. */
export function formatExpiry(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: CAMPAIGN_TIMEZONE,
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}
