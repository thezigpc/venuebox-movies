// The app's single connection to a Bar Games box. Off a box (no BG_CORE_URL / BG_GAME_TOKEN)
// every call is a no-op and the app runs standalone (SDK rule 1): settings and browsing work,
// playing on TVs says it needs a box.

import { createBarGames, type BarGames } from "@bargames/sdk/server";
import { log } from "./log.js";

export function makeBarGames(opts: { coreUrl?: string; token?: string; defaultName: string }): BarGames {
  const bg = createBarGames({ gameId: "movies", defaultName: opts.defaultName, coreUrl: opts.coreUrl, token: opts.token });
  bg.setStatusProvider(() => ({ rooms: [] }));
  return bg;
}

/** The venue's name on a box; null standalone or when the box can't be reached. */
export async function venueName(bg: BarGames): Promise<string | null> {
  if (!bg.connected) return null;
  try {
    return (await bg.venue()).game.displayName;
  } catch (err) {
    log.warn("bargames", "venue context unavailable", { err: String(err) });
    return null;
  }
}
