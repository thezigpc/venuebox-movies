# Bar Games integration report: Movies 0.1.0

- **Level:** 3, an app and a media provider.
- **SDK:** 0.16.0. The video calls are from the agreed SDK 0.17.0 contract; they're
  detected at run time.
- **GameKit:** 0.10.6.
- **Manifest:**
  - `id: movies`, port 3017, `routing.basePath: true`, `network.internet: true`;
  - routes `player`/`host` `/` (the staff picker; staff sign-in) and `admin` `/admin`;
  - `media: { launch: [] }` and `video: { play: true }`.

## Checks (mock box, SDK 0.16.0, `--base /movies`, the real Jellyfin, fake TVs)

```
✓ health /health → 200
✓ /__bargames/venue.json returns the box's branding ("Movies (mock)")
✓ /__bargames/theme.css served
✓ status.media.targets → 3 TV(s)
✓ media_list → 7 item(s)
✓ phone page (routes.player) / → 200
all checks passed
```

The SDK 0.16.0 mock box flags `video_started` / `video_stopped` as non-standard. They become
standard in SDK 0.17.0 (agreed with GameBroker), and the box accepts snake_case at run time.

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

- `ghcr.io/thezigpc/movies:0.1.0`, published by `.github/workflows/publish-image.yml`.

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

## Known limits (0.1.0)

- **One Jellyfin device.** One sign-in is one device, so Jellyfin's "now playing" shows only
  the TV that started last. Resume points and watched marks are per item, so they stay
  right. Fix later: a token per TV.
- **Roku:** no resume point and no ±30 s. Its built-in player starts at the beginning and
  can't seek (box 0.27.0). The page says so and hides the buttons.
- **No subtitles.**
- **Not yet verified on a real Apple TV or Roku:** waiting for box 0.27.0.

## SDK requests (sent to GameBroker; answers in brackets)

1. `bg.playVideo` / `videoControl` / `videoStatus` [accepted: box 0.27.0 / SDK 0.17.0].
   - Seek is absolute; Roku doesn't seek or start part-way.
   - `needs-pairing` for Apple TV AirPlay video.
2. `"video": { "play": true }` permission [accepted].
3. `bg.tvs()` gains `video: { kind, model }` [accepted].
4. `media.launch: []` as a media provider [already works].
5. Standard events `video_started` / `video_stopped` [being added].
6. Mock box: fake Apple TV and Roku video TVs [coming].
7. Later:
   - a `media_search { q }` command, so a scene can pick one movie;
   - `routes.player` optional for staff-only apps (the validator requires it today, so it's
     `/`, the sign-in-gated picker).
