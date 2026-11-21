# Changelog

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
