// Plex: the next source (not built in 0.1.0). The venue's server runs both Jellyfin and Plex.
//
// Notes for building it behind MediaSource (sources/types.ts):
//   - Sign in: plex.tv PIN flow (POST https://plex.tv/api/v2/pins, the user approves at
//     plex.tv/link) gives an account token; then the server's own access token from
//     https://plex.tv/api/v2/resources (accessToken per server). Store that, never a password.
//     Like Jellyfin: a managed/home user that only sees the movie library, since its token is
//     in every TV link.
//   - Browse: /library/sections, /library/sections/{id}/all, /hubs/search?query=, /library/metadata/{id}
//     (Media[].Part[] give container, codecs, resolution, HDR via colorTrc / DOVIPresent).
//   - Stream: direct play = {server}{Part.key}?X-Plex-Token=…; otherwise the universal
//     transcoder's HLS: /video/:/transcode/universal/start.m3u8 with protocol=hls,
//     directPlay=0, directStream=1 (remux when the codecs fit), maxVideoBitrate, and a client
//     profile (X-Plex-Client-Profile-Extra) built from the TV's TvProfile.
//   - Report: /:/timeline?ratingKey=&state=playing|paused|stopped&time=ms&duration=ms, so
//     "now playing" and resume points stay right; stop the transcode with
//     /video/:/transcode/universal/stop?session=.
//   - Redaction already covers X-Plex-Token (shared/redact.ts).

import type { MediaSource } from "./types.js";
import { SourceError } from "./types.js";

export function createPlexSource(): MediaSource {
  const no = () => Promise.reject(new SourceError("Plex isn't supported yet: use the server's Jellyfin.", 409, "refused"));
  return {
    kind: "plex",
    test: no,
    libraries: no,
    collections: no,
    browse: no,
    search: no,
    resume: no,
    item: no,
    queue: no,
    playback: no,
    tvPosterUrl: () => undefined,
    poster: () => Promise.resolve(null),
    reportStart: no,
    reportProgress: no,
    reportStop: no,
  };
}
