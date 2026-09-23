/**
 * Verifies the store has granted every scope the app needs.
 *
 *   pnpm check:scopes
 *
 * Requests a client-credentials token and compares its `scope` readback with
 * the scopes in shopify.app.toml. Run after `pnpm deploy` and after approving
 * the scope change on the store.
 */
import fs from "node:fs";
import { loadEnv } from "~/config/env.server";

const REQUIRED = (() => {
  const toml = fs.readFileSync(new URL("../shopify.app.toml", import.meta.url), "utf8");
  const m = /^scopes\s*=\s*"([^"]+)"/m.exec(toml);
  if (!m) throw new Error("scopes not found in shopify.app.toml");
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
})();

/** write_x implies read_x. */
function granted(scope: string, have: Set<string>): boolean {
  if (have.has(scope)) return true;
  return scope.startsWith("read_") && have.has(scope.replace(/^read_/, "write_"));
}

async function main() {
  const env = loadEnv();
  const res = await fetch(`https://${env.shopDomain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.shopifyApiKey,
      client_secret: env.shopifyApiSecret,
    }),
  });
  if (!res.ok) {
    console.error(`token request failed: HTTP ${res.status} ${await res.text()}`);
    process.exitCode = 1;
    return;
  }
  const json = (await res.json()) as { scope?: string };
  const have = new Set(
    (json.scope ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  console.log(`granted: ${[...have].join(", ") || "(none)"}`);
  const missing = REQUIRED.filter((s) => !granted(s, have));
  if (missing.length) {
    console.error(
      `MISSING: ${missing.join(", ")}\nDeploy the app version with these scopes and approve the change on the store.`,
    );
    process.exitCode = 1;
  } else {
    console.log(`all required scopes granted: ${REQUIRED.join(", ")}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
