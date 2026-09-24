/**
 * Serves the production build locally (`pnpm start`), for smoke testing.
 *
 * The Vercel preset splits the server build into per-runtime bundles under
 * `build/server/<bundleId>/index.js` instead of `build/server/index.js`, so
 * the path is resolved rather than hardcoded. On Vercel this script is not
 * used at all: Vercel builds the function from the preset's manifest.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

const SERVER_DIR = "build/server";

function resolveServerBuild() {
  const flat = path.join(SERVER_DIR, "index.js");
  if (existsSync(flat)) return flat;
  if (existsSync(SERVER_DIR)) {
    for (const entry of readdirSync(SERVER_DIR)) {
      const candidate = path.join(SERVER_DIR, entry, "index.js");
      if (existsSync(candidate)) return candidate;
    }
  }
  console.error(`No server build found under ${SERVER_DIR}. Run "pnpm build" first.`);
  process.exit(1);
}

const target = resolveServerBuild();
console.log(`serving ${target}`);
spawn("react-router-serve", [target], { stdio: "inherit", shell: true }).on("exit", (code) =>
  process.exit(code ?? 0),
);
