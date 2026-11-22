import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export const PORT = num("PORT", 3017);
/** Built client, served by this process (one origin). */
export const CLIENT_DIST_PATH = process.env.CLIENT_DIST_PATH ?? path.resolve(here, "../../client/dist");
/** Everything written at runtime (see store.ts). The server address and token live here only. */
export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? path.resolve(here, "../../data"));
/** Overrides the password chosen on the /admin setup screen. */
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "";
/** Standalone name ("Movies" by default; the admin's name setting wins, the venue's rename on a box). */
export const GAME_NAME = process.env.GAME_NAME ?? "";
/** Dev only: pretend TVs to play on when there's no box (or the box can't play video yet). */
export const FAKE_TVS = /^(1|true|yes)$/i.test(process.env.MOVIES_FAKE_TVS ?? "");
export const VERSION = "0.2.0";
