# Venuebox Movies: project notes

A box-only app for the Bar Games box. Staff pick a movie on the iPad, and the TV streams it
straight from the venue's Jellyfin server in its own player (Apple TV over AirPlay, Roku's
built-in player). The box hands the TV a link and never carries the video. Never use
doubletake or screen capture for movies.

## Rules
- **The repo is public.** The server address, keys and tokens go only in the app's settings
  in DATA_DIR: never in code, tests, README, commits, logs or memory.
  - `BRIEF.md` (it names the venue's test server) and the creds file are gitignored. Keep it
    that way.
  - Tests use the fake Jellyfin (`server/test/fakes.ts`).
- **Never log a stream URL, token or key.** Every line goes through `redact()`
  (`shared/src/redact.ts`, used by `server/src/log.ts`). Never put links in events.
- **Nothing may depend on the host, port or http/https.** A server move is a settings change
  only.
- Don't edit GameBroker, GameKit or other modules: send platform needs to the GameBroker
  session (ListAgents, "GameBroker Session").
- **Testing on this PC:** check that ports are free first (3017, 7080, 7199). Stop only the
  processes on your own ports, never by name. The venue box is at the venue: ask before
  installing on it.
- **Real-server testing:** the PC is on the Jellyfin allowlist. If the server stops
  answering, ask the user; don't work around it. Credentials come from the user only.

## Code map
- `shared/src`:
  - `url.ts`: normalise the server address;
  - `profiles.ts`: TV profiles as data, `canDirectPlay`, bitrate caps;
  - `redact.ts`; `types.ts`.
- `server/src/sources/types.ts`: the `MediaSource` interface.
  - `jellyfin.ts`: device profile → PlaybackInfo → a direct link or HLS; reporting.
  - `plex.ts`: stub, with notes for building it.
- `server/src/http.ts`: node:http/https, with a SHA-256 certificate pin (a pinned TLS socket
  passed as `createConnection`; **no `agent`** with it) and `probeCertificate`.
- `server/src/video.ts`:
  - the box's video calls (`bg.playVideo/videoControl/videoStatus`, detected at run time);
  - the dev fake (`MOVIES_FAKE_TVS=1`), which fetches the link to prove it works.
- `server/src/player.ts`: a session per TV, a queue (series, collection, library shuffle),
  status polling, Jellyfin reports, events.
- `server/src/media.ts`: media_list / media_play / media_stop and status.media.targets.
- `server/src/app.ts`: the HTTP API; `posters.ts`: signed poster links through the app.
- `server/src/vote.ts`: the guest vote (in memory): options from the library or typed, the
  winner through `player.play`; `Player.onFinished` tells it a movie ended by itself.
- Client (routes: player `/` guests, host `/staff`, admin `/admin`):
  - `pages/GuestPage.tsx`: public; what's on, tonight's list, the vote (`/api/public/*`);
  - `pages/StaffPage.tsx`: `useLayout` picks phone (mini bar + full remote), portrait (dock)
    or landscape (side panel); the vote sheet and tonight's list; styles in `app.css`;
  - `pages/AdminPage.tsx`: settings.
- To see a page: headless Edge works here (`msedge --headless=new --screenshot`, at least
  500 px wide); on the mock box, `/__bargames/staff?next=/staff` signs in.

## Platform contract (agreed with GameBroker 2026-11-21: box 0.27.0 / SDK 0.17.0; Venuebox apps box 0.28.0 / SDK 0.18.0)
- `playVideo(displayId, { url, mime, title, poster?, startAt? })`, `videoControl(…,
  "pause"|"resume"|"stop"|{ seek })`, `videoStatus` → `{ state, position?, duration?,
  message? }`.
- **Seek is absolute.** A Roku can't seek or start part-way (`canSeek` in player.ts).
- Reasons: offline, unsupported, not-allowed, error, needs-pairing (an Apple TV needs a
  second PIN in the box admin).
- `bg.tvs()[].video: { kind, model }`. Roku model = ECP number (3930X); Apple TV = pyatv
  model_str.
- SDK 0.18.0: `video.kind: "venuebox"` with `formats { containers, video, audio, maxHeight?, seek,
  passthrough?, ranges? }` (Jellyfin's lower-case names; "hls" in containers isn't a file
  container; ranges absent = SDR only, SDK 0.18.1).
  The profile is built from it (`profileFromFormats` in profiles.ts); `seek` decides
  `canSeek` (video.ts). Absent for Apple TVs and Rokus.
- Tracks (0.3.0): `TrackChoice { audioIndex?, subtitleIndex? }` (Jellyfin stream indexes).
  - Non-default audio or a subtitle means PlaybackInfo with **MediaSourceId** (without it,
    Jellyfin ignores the track indexes) and EnableDirectPlay false.
  - A chosen subtitle is burned in (its URL params are kept).
  - With none chosen, `withoutBurnedSubtitles` removes Jellyfin's own pick.
  - `Player.setTracks` restarts at the position; `tracksFor` carries the languages along a
    queue; `Session.busy` keeps the poller away while a stream starts.
- Native tracks (0.4.0, SDK 0.19.0, `formats.tracks`):
  - `playVideo.tracks` is built by `nativeTracks` (jellyfin.ts). Ids are "a<index>" and
    "s<index>" (shared/tracks.ts).
  - `index` is the place among tracks of that kind in the file (direct play only); in HLS,
    only the audio in the stream has index 0.
  - Text subtitles get a WebVTT url (`/Videos/{id}/{msid}/Subtitles/{i}/0/Stream.vtt`, which
    carries the key, so never log it).
  - `switchInPlace` tries `videoControl({audio}|{subtitle})` first. `pollOne` follows
    `status.audio/subtitle` and acts on `status.remote` (next/previous/tracks).
- Events: standard `video_started { tv, title }` / `video_stopped { tv }`.
- SDK 0.18.2: `kind: "local"` (a screen on the box, mpv). `formats` wins whatever the kind
  (`profileFor`, `canSeek`).
- Vendored SDK 0.19.0 (Movies 0.5.0).
- The public API (`/api/public/state`, `/api/public/vote`) must never carry a link, a key or
  the server's address: titles, progress and signed poster paths only. Installed on the venue box (0.1.1). **No live testing
  on the venue's TVs until the user says so.**

## Conventions
- npm workspaces (`shared`, `server`, `client`), TypeScript, Express 4, React 18 + Vite 5,
  Node 22, `node:test` via tsx.
- Image `ghcr.io/thezigpc/movies:<version>`. Bump `version` and the `image` tag together.
- Repo: https://github.com/thezigpc/venuebox-movies.
