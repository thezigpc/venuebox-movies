# Changelog

## 0.2.0 (2026-11-21)
- **Venuebox apps** (SDK 0.18.0, box 0.28.0): Android/Google TV and PC players.
  - A TV with `video.kind: "venuebox"` gets a profile built from the formats it reports.
  - It gets a direct link when the file fits; otherwise the server's HLS, in HEVC (fMP4) if
    the TV lists it, else H.264 (TS).
  - Skip and resume follow its `seek`.
  - "Venuebox app" isn't offered as a profile to pick by hand.
- **Fix: no more burned-in subtitles.**
  - Jellyfin used to pick the user's default subtitle track by itself. For a converted
    stream, it burned that track into the picture: a full video transcode, and subtitles
    nobody asked for.
  - A file with a default subtitle (often PGS) was also never sent as it is, on any TV.
  - Now the usual subtitle formats are declared as embedded, and the burn-in settings are
    removed from converted links. An MKV on an Apple TV is a plain remux again.
- The server's reasons for converting are read from the link too (Jellyfin 10.9+).
- Settings shows each TV's own maximum bitrate and height from the server, so a Venuebox
  TV shows its real limits.
- Dev fake TVs gain `fake-venuebox`, a 4K HEVC player that can seek.

## 0.1.1 (2026-11-21)
- SDK 0.17.0 (box 0.27.0): the box's video calls are now typed SDK calls
  (`bg.playVideo` / `videoControl` / `videoStatus`), with no run-time detection or casts.
- A box older than 0.27.0 lists no video TVs. The pages say that Movies needs box 0.27.0.
- Tested on the SDK 0.17.0 mock box's video TVs:
  - Roku 3930X: no seek or resume point, and the page says so;
  - Apple TV 4K: pause and absolute seek;
  - `video_started` / `video_stopped` accepted as standard events.

## 0.1.0 (2026-11-21)
- First release: a Jellyfin source, TV profiles, the staff picker with its TV dock, and
  settings (server address, certificate pin, limited-user sign-in, per-TV caps).
- Media provider commands; stream links never logged.
