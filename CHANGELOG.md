# Changelog

## 0.3.0 (2026-11-21)
- **Audio track and subtitles**, picked before a movie starts (the details sheet) and changed
  while it plays (the dock: "Audio & subtitles").
  - The default audio track and no subtitles play as before: the file as it is when the TV
    can play it.
  - Another audio track: the server repackages the movie with it. The picture is copied.
  - Subtitles: burned into the picture. That's the server's heaviest work, and the page
    warns, more strongly on a 4K movie.
  - Changing while playing starts the stream again a few seconds back from where it was. A
    TV that can't start part-way (a Roku) starts over, and the page says so first.
  - A series or a collection keeps the chosen languages on the next items, using each file's
    own tracks.
- Jellyfin only honours track choices when the request names the file (MediaSourceId). Movies
  now sends it.
- Fix: the status poll could drop a TV's session while a stream was starting. The TV kept
  playing, but Movies lost track of it.

## 0.2.2 (2026-11-21)
- SDK 0.18.2 (box 0.28.2): a screen plugged into the box (`video.kind: "local"`, played
  by mpv) plays movies.
- Any TV that reports `formats` gets its profile from them, whatever its kind. Skip and
  resume follow its `seek`.
- Settings names it: "Venuebox app", "Screen on the box", or "Its own player".

## 0.2.1 (2026-11-21)
- SDK 0.18.1 (box 0.28.1): a Venuebox app's `formats.ranges` decides HDR.
  - "sdr" "hdr10" "hdr10plus" "hlg" "dovi" map to Jellyfin's ranges.
  - With no ranges listed, SDR only: HDR isn't guessed from 4K + HEVC any more, and the
    server tone-maps HDR files.

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
