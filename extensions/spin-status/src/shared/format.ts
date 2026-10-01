import { CAMPAIGN_UTC_OFFSET_MINUTES, CAMPAIGN_ZONE_LABEL } from "../../../../app/config/campaign";

/**
 * The instant moved by the campaign offset, to be formatted as UTC. Pacific
 * Time is a fixed UTC-7, so the customer's device never resolves a zone and
 * out of date time zone data on it cannot shift the result.
 */
function inCampaignZone(date: Date): Date {
  return new Date(date.getTime() + CAMPAIGN_UTC_OFFSET_MINUTES * 60_000);
}

/** "November 2, 2026 at 9:00 AM PT", always in the campaign's zone. en-US avoids "a.m." colliding with sentence periods. */
export function formatExpiry(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const text = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(inCampaignZone(date));
  return `${text} ${CAMPAIGN_ZONE_LABEL}`;
}

/** "Nov 2, 2026", in the campaign's zone. Used on the result card's meta line. */
export function formatExpiryShort(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(inCampaignZone(date));
}
