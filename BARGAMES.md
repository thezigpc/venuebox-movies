# Bar Games integration report: Movies 0.5.3

- **Level:** 3, an app and a media provider.
- **SDK:** 0.19.0.
  - Box 0.27.0: `bg.playVideo` / `videoControl` / `videoStatus`, `bg.tvs()[].video`, and
    the standard `video_started` / `video_stopped` events.
  - Box 0.28.0: Venuebox apps, `video: { kind: "venuebox", model, formats }`.
  - Box 0.28.1: `formats.ranges`.
  - Box 0.28.2: `kind: "local"`, a screen on the box. Formats are used whatever the kind.
  - Box 0.29.0: `playVideo.tracks`, `videoControl({audio}|{subtitle})`, `videoStatus.audio/subtitle/remote`.
- **GameKit:** 0.10.6.
- **Manifest:**
  - `id: movies`, port 3017, `routing.basePath: true`, `network.internet: true`;
  - routes `player` `/` (guests: what's on, the vote; no sign-in), `host` `/staff` (staff)
    and `admin` `/admin`;
  - `media: { launch: [] }` and `video: { play: true }`.

## Checks (mock box, SDK 0.18.0 and 0.18.1, `--base /movies`, the real Jellyfin, the mock box's video TVs)

```
✓ health /health → 200
✓ /__bargames/venue.json returns the box's branding ("Movies (mock)")
✓ /__bargames/theme.css served
✓ status.media.targets → 3 TV(s)
✓ media_list → 7 item(s)
✓ phone page (routes.player) / → 200
all checks passed
```

On the same mock box:
- `video_started` / `video_stopped` were accepted.
- fake-patio (Apple TV 4K): HLS for an MKV, pause, +30 s as an absolute seek, stop.
- fake-bar (Roku 3930X): a direct MKV; skipping is refused before anything is sent to the TV.
- fake-den (Venuebox Android TV, 4K HEVC, seek):
  - four real files played as they are: H.264 MKV with AC3, with EAC3, and an HEVC 10-bit
    MKV with PGS subtitles;
  - +30 s was an absolute seek; stop.
  - The same HEVC MKV went to HLS on the Apple TV ("container mkv") and the Roku ("video
    hevc"), with no subtitle burned in.
- No token, server address, key or stream link in the app's or the mock box's log.

## TVs that report formats (Venuebox apps SDK 0.18.0; any kind, incl. local, SDK 0.18.2)

`video.formats` becomes the TV's profile (`profileFromFormats`, `shared/src/profiles.ts`):
- **Direct:** the containers it lists ("hls" aside), its video codecs, its audio plus
  passthrough, up to `maxHeight` (2160 when absent).
- **Otherwise HLS:** HEVC in fMP4 if it lists HEVC, else H.264 in TS.
- **HDR:** `formats.ranges` ("sdr" "hdr10" "hdr10plus" "hlg" "dovi" → Jellyfin's SDR, HDR10,
  HDR10Plus, HLG, DOVI). None listed: SDR only.
- **Bitrate:** 80 Mbit/s at 4K, 40 at 1080p, 20 below, lowered by the per-TV cap; "allow
  4K" applies.
- **`seek`:** decides ±30 s and resume points.
- **Malformed formats:** dropped, so the TV gets a safe 1080p H.264 profile.

## Events

Never with a link in them.

| Event | Where | data |
|---|---|---|
| `video_started` | `server/src/player.ts` startCurrent (each item that starts, queues too) | `{ tv, title }` |
| `video_stopped` | `server/src/player.ts` end() / pollOne (stop, end of the queue, TV error, stopped on the TV) | `{ tv }` |

The brief named them `movie_started` / `movie_stopped`. GameBroker asked for the shared
`video_*` names.

## Commands (`server/src/media.ts`)

- **media_list:** each library (as "… (shuffle)") and each collection, all `kind: "list"`.
- **media_play** `{ displayId, itemId }`:
  - itemId can be a movie, an episode, a series (from the next episode), a season, a
    collection (in order) or a library (shuffle);
  - answers within 2.5 s, with `pending: true` if it's still starting;
  - refuses with a message when: not set up, no TV given, the TV is unknown or offline, the
    item is gone, the TV said no (its reason in words).
- **media_stop:** stops the TV, then reports the position to Jellyfin.
- **status.media.targets:** every TV that `bg.tvs()` lists with `video`:
  - `linked` (ready), `starting`, `playing`, `paused` or `error`, from videoStatus;
  - `nowPlaying.title`, and `listName` = "N more from <collection>";
  - `itemId` is what was picked.

## Container

- It writes only `/data`:
  - `settings.json`: the server URL, the certificate pin, per-TV settings;
  - `secrets.json` (0600): the Jellyfin token, device id and poster key;
  - `admin.json`.
- Root filesystem read-only. No Docker on the dev PC, so the clean-checkout build is proven
  by the publish workflow.

## Image

- `ghcr.io/thezigpc/movies:0.1.1`, published by `.github/workflows/publish-image.yml`.

## Verified against the real Jellyfin (12.4.0, from the venue PC, 2026-11-21)

- Address typed without a scheme → `http://…`, with the note; test shows name and version.
- Sign-in as the limited (non-admin) user: the token is stored, the password isn't.
- Libraries, browsing (524 movies), search, and signed posters through the app.
- Fake TVs fetched each link the way the TV would:
  - Roku with H.264/AC3 MKV → direct file, HTTP 206;
  - Apple TV with MKV → HLS remux, fMP4 segment;
  - unknown TV with HEVC → HLS transcode, TS segment.
- Jellyfin's dashboard showed the session (Transcode, position).
- The log had no token, key or password in it.

## Audio and subtitles (0.3.0, every TV)

- Picked before play, changed while playing (`POST /api/admin/tvs/:id/tracks`).
- Another audio track: HLS with the track, picture copied. Subtitles: burned in.
- A change restarts the stream; a Roku starts over.
- Verified against the real Jellyfin with the dev fake TVs, which fetch the streams:
  - commentary audio: fMP4 segment;
  - French PGS burned in: fMP4 segment;
  - a switch on the Roku to commentary + English burned in: TS segment.

## Players that switch tracks (0.4.0, SDK 0.19.0)

Verified on the 0.19.0 mock box (fake-den) against the real Jellyfin:
- "2 Fast 2 Furious" with the commentary track and English PGS played as it is (it used to be
  a full conversion with burn-in).
- Back to the default audio with subtitles off: switched on the player, no new stream.
- From the remote: "next" on a single movie is ignored (logged); a subtitle was switched on the
  player.
- A text subtitle ("+1", English SDH SRT) as a side file: HTTP 200, text/vtt, 1708 cues.
- No token, address, key, link or side-file link in any log.

## Guest page and vote (0.5.0)

- `/api/public/state` and `/api/public/vote` need no sign-in. They carry titles, progress,
  signed poster paths and vote counts only.
- A vote is in memory. Voters are a random id per browser. In the venue (`bg.gateway(req).access`
  "venue-ip" or "local"): no cap per address, 30 new voters a minute. Outside: 6 per address.
- With no media server: tonight's list (`settings.json`) and typed vote options.
- Checked in headless Edge on the 0.19.0 mock box with the real Jellyfin: the phone, iPad
  portrait and iPad landscape layouts, the full remote, the details sheet, the vote sheet,
  the guest page, and both pages with no server.

## Known limits

- **One Jellyfin device.** One sign-in is one device, so Jellyfin's "now playing" shows only
  the TV that started last. Resume points and watched marks are per item, so they stay
  right. Fix later: a token per TV.
- **Roku:** no resume point and no ±30 s. Its built-in player starts at the beginning and
  can't seek (box 0.27.0). The page says so and hides the buttons.
- **Seen twice, not reproduced alone:** the first segment of a Roku HEVC→H.264 stream answered
  HTTP 500 while another stream of the same movie had subtitles burned in. The same request
  works on its own.
- **Not yet verified on a real TV.** Movies 0.1.1 is installed on the venue box (0.27.1), but
  there's no live testing at the venue until the user says so.

## SDK requests (sent to GameBroker; answers in brackets)

1. `bg.playVideo` / `videoControl` / `videoStatus` [accepted: box 0.27.0 / SDK 0.17.0].
   - Seek is absolute; Roku doesn't seek or start part-way.
   - `needs-pairing` for Apple TV AirPlay video.
2. `"video": { "play": true }` permission [accepted].
3. `bg.tvs()` gains `video: { kind, model }` [accepted].
4. `media.launch: []` as a media provider [already works].
5. Standard events `video_started` / `video_stopped` [done, SDK 0.17.0].
6. Mock box: fake Apple TV and Roku video TVs [done]; fake-den [done, SDK 0.18.0].
7. `formats.ranges` [done, SDK 0.18.1].
8. Later:
   - a `media_search { q }` command, so a scene can pick one movie;
   - `routes.player` optional for staff-only apps (the validator requires it today, so it's
     `/`, the sign-in-gated picker).
