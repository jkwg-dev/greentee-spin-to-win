import type { Config } from "@react-router/dev/config";
import { vercelPreset } from "@vercel/react-router/vite";

/**
 * The Vercel preset is applied unconditionally, as Vercel's docs require.
 *
 * It does not produce the deployable output itself: it emits server bundles
 * plus `.vercel/react-router-build-result.json`, which Vercel's React Router
 * framework builder reads to create the function. That builder only runs when
 * the project's framework preset is React Router, so `vercel.json` must set
 * `"framework": "react-router"` and must never set it to null.
 *
 * Applying the preset only when `process.env.VERCEL` is set looks harmless but
 * fails silently: the build still succeeds and every route 404s.
 */
export default {
  ssr: true,
  presets: [vercelPreset()],
} satisfies Config;
