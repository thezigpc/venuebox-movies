// The box's side (SDK 0.9.0 media providers). On a box:
//   - media_list: each library and each collection, so the TVs page, scenes ("Movie night")
//     and a TV's startup choice can pick one;
//   - media_play { displayId, itemId }: a movie, an episode, a series (next episode on), a
//     collection (in order) or a library (shuffle) on that TV;
//   - media_stop: stop it; the box then shows its idle screen;
//   - status.media.targets: every video TV, in the state the TV reports.
// Off a box none of this runs (bg calls are no-ops).

import type { BarGames, MediaItem } from "@bargames/sdk/server";
import { log } from "./log.js";
import type { Player } from "./player.js";
import type { MediaSource } from "./sources/types.js";

/** media_play must answer well inside the box's 5 s command timeout. */
export const ANSWER_WITHIN_MS = 2500;

export function registerMedia(o: { bg: BarGames; player: Player; source: () => MediaSource; ready: () => boolean; answerWithinMs?: number }) {
  const { bg, player } = o;
  const answerWithin = o.answerWithinMs ?? ANSWER_WITHIN_MS;

  async function answerSoon<T>(work: Promise<T>): Promise<{ done: true; value: T } | { done: false }> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<{ done: false }>((r) => (timer = setTimeout(() => r({ done: false }), answerWithin)));
    const r = await Promise.race([work.then((value) => ({ done: true as const, value })), late]).finally(() => clearTimeout(timer));
    // We answered "pending": an error now only reaches the log (status shows the TV's state).
    if (!r.done) work.catch((err) => log.warn("media", "media_play finished with an error", { err: String(err) }));
    return r;
  }

  bg.onMediaList(async (): Promise<MediaItem[]> => {
    if (!o.ready()) return [];
    const source = o.source();
    const [libs, cols] = await Promise.all([source.libraries(), source.collections().catch(() => [])]);
    return [
      ...libs.map((l) => ({ id: l.id, name: `${l.title} (shuffle)`, kind: "list" as const })),
      ...cols.map((c) => ({ id: c.id, name: c.title, kind: "list" as const })),
    ];
  });

  bg.onMediaPlay(async ({ displayId, itemId }) => {
    if (!o.ready()) return { ok: false, message: "Movies isn't connected to a media server yet: set it up in the Movies app's settings." };
    if (!displayId) return { ok: false, message: "Pick a TV to play that on." };
    if (!itemId) return { ok: false, message: "Pick something to play." };
    try {
      const r = await answerSoon(player.play(displayId, itemId));
      return r.done ? { ok: true } : { ok: true, pending: true };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  });

  bg.onMediaStop(async ({ displayId }) => {
    try {
      await player.control(displayId, "stop");
      return { ok: true };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  });

  bg.setStatusProvider(() => ({
    rooms: [],
    media: {
      targets: player.cachedTvs().map((t) => {
        const now = player.nowPlaying(t.id);
        const origin = player.originOf(t.id);
        return {
          displayId: t.id,
          label: t.name,
          state: player.mediaState(t.id),
          ...(now && now.state !== "error" ? { nowPlaying: { title: now.title, ...(now.upNext ? { listName: now.upNext } : {}) } } : {}),
          ...(origin ? { itemId: origin } : {}),
        };
      }),
    },
  }));
}
