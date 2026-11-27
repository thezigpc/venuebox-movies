# Changelog

## 0.6.1 (2026-11-27)
- The "playing for a minute with no place in the movie" fallback now only applies to a TV
  that has reported its place at least once since the app started. A player that never
  reports one (to be checked on the Apple TV) is no longer restarted at 1080p for it; an
  error from the TV still falls back.
- A log line per play says how many seconds the TV took to report its place.
- Getting a stream ready is held to 48 s in all, so staff get an answer in words before the
  box's gateway gives up on the request (60 s).

## 0.6.0 (2026-11-27)
- **Picture quality.** Staff pick Auto, Original, 1080p or 720p before a movie starts (the
  details sheet) and change it while it plays (the remote; the stream starts again at the
  same spot). The choice stays for the rest of a series or collection.
- **Auto falls back to 1080p** when 4K can't work:
  - subtitles burned into a 4K picture (the server converts the whole picture, too slowly
    at 4K) are made at 1080p from the start;
  - a conversion the server can't keep up with (timed before the TV gets it);
  - a TV that reports an error on the 4K stream, or says "playing" for a minute with no
    place in the movie (an Apple TV's "no" sign). Tried once, then it's an error.
  - Original never falls back.
- **The stream is started on the server before the TV is handed it.** The app fetches the
  part the TV will ask for first, so the TV doesn't wait through a slow start (about 20 s
  for burned-in subtitles on a big file), and a stream the server can't make is reported to
  staff in words instead of an error on the TV.
- Fix: the "no TVs" text no longer names Rokus (the box doesn't offer them for video until
  there's a Venuebox Roku channel).

## 0.5.3 (2026-11-21)
- A vote's winner no longer starts by itself unless staff ask for it. By default, when a vote
  closes, staff see the full result and press "Play it" (or clear it). "Start the winner by
  itself" is a tick box when opening a vote, off by default.
- Guests are told "The staff will put it on" instead of "Up next".

## 0.5.2 (2026-11-21)
- Staff who open the app land on the guest page (the app's main address). When the box
  vouches for them, that page now shows "Staff controls" (to `/staff`, no password) and
  "Settings". Guests don't see it; their footer link reads "Staff sign-in".

## 0.5.1 (2026-11-21)
- Fix: the guest vote's cap of 6 voters per network address would have blocked most of the
  room, because everyone on the venue's Wi-Fi arrives from the venue's one address. In the
  building (the box's `access` is "venue-ip" or "local") there's no cap on people, only a
  limit of 30 new voters a minute to stop a script. From outside the venue the cap stays.

## 0.5.0 (2026-11-21)
- **A new staff page**, at `/staff` (routes.host), laid out per device:
  - phone: the list, a mini player bar, and a full-screen remote;
  - iPad portrait: a dock at the bottom with the TVs and the remote;
  - iPad landscape: a side panel with the TVs, the remote and the vote.
  - The remote has a scrubber, ±30 s, audio and subtitles, and stop. It starts on the TV
    that's playing.
  - "Carry on watching" lists part-watched movies.
  - Links into the page: `#remote`, `#vote`, `#item=<id>`, `#tv=<id>`.
- **A guest page**, at `/` (routes.player, no sign-in): what's on each TV, tonight's list,
  and the vote. It shows titles and progress only: never a link or the server.
- **Guest vote.** Staff put up to 8 movies in a vote, from the library or typed in.
  - It closes after a set time, when the TV's movie ends, or when staff close it.
  - The winner starts by itself when the TV is free, or waits for "Play now".
  - One vote per browser, changeable; at most 6 voters per network address (changed in
    0.5.1).
  - Kept in memory: an app restart ends a vote.
- **Works with no media server.** Staff type a "Playing tonight" list for guests, and typed
  movies can go in a vote. A typed winner is announced for staff to put on.
- Fix: a refused vote action now says why, not "Bad request."

## 0.4.0 (2026-11-21)
- SDK 0.19.0 (box 0.29.0): **players that switch tracks themselves** (`formats.tracks`:
  screens on the box now, the Venuebox apps as they update).
  - A file they can play as it is goes as it is, with every audio track and subtitle
    listed, even with another audio track or subtitles chosen. No repackaging and no
    burning in.
  - Text subtitles (SRT, ASS…) go as a WebVTT side file, also on a converted stream. Only a
    picture subtitle (PGS, DVD) on a converted stream is still burned in.
  - Switching while playing happens on the TV, with no new stream. If the player can't (the
    track isn't in its stream, or a burned-in subtitle has to go), the stream starts again
    as before.
  - **The TV's own remote:** audio and subtitle changes made on the TV show on the iPad and
    carry on to the next episode. "Next" and "previous" move through a series or a
    collection. A track the player can't switch to starts a new stream with it.
  - The status is read about every 2 s while something plays.
- Apple TVs and Rokus work as in 0.3.0.

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
