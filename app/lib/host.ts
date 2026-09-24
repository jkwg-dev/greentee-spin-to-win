/**
 * Normalises a host for comparison.
 *
 * Accepts a full URL ("https://shop.myshopify.com/"), a bare host
 * ("shop.myshopify.com"), and either of those with a port, a path, wrapping
 * whitespace or mixed case. Returns null when there is no usable host.
 *
 * This exists because Shopify's session token `dest` claim is not guaranteed
 * to carry a scheme. Parsing it with `new URL()` alone throws on a bare host,
 * which rejects every valid token from that surface.
 */
export function normalizeHost(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim().toLowerCase();
  if (raw === "") return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`;
  try {
    const { hostname } = new URL(withScheme);
    return hostname === "" ? null : hostname;
  } catch {
    return null;
  }
}
