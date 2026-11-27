# Venuebox Movies

A Bar Games box app. Staff pick a movie on the iPad and tap **Play on this TV**. The movie
comes from the venue's own Jellyfin server, wherever it is on the internet. The box asks the
server for a stream link and hands it to the TV. The TV then streams straight from the
server in its own player, so the box never carries the video:

- **Apple TV:** AirPlay "play this URL", in full 4K/HDR with the original sound;
- **Roku:** Roku's built-in player;
- **Venuebox app** (Android/Google TV, a PC): its own player, which tells the box what it
  plays (box 0.28.0 or newer);
- **A screen plugged into the box:** played by the box itself (box 0.28.2 or newer).

```
iPad (staff) → Movies app: "play Movie X on TV 3"
Movies app   → media server: browse, search, playback info, stream link
Movies app   → box → TV: "play this link"
TV           ⇄ media server: the video itself
```

"Venuebox" means it runs on a box. Standalone, it browses the server but can't play on TVs.

Three pages:
- **Guests** (`/`): what's on each TV, what's playing tonight, and a vote for the next movie.
  No sign-in. It never plays anything.
- **Staff** (`/staff`): browse, play, the TV remote, the guest vote and tonight's list. It's
  laid out for a phone, an iPad upright, and an iPad on its side.
- **Settings** (`/admin`).

**Picture quality:** Auto (the default) plays the best the TV takes and falls back to 1080p
when the server can't convert 4K fast enough or the TV won't show it. Staff can also pick
Original (never shrunk), 1080p or 720p, before or during a movie.

**With no media server**, the app still runs the guest page: staff type tonight's movies and
the movies for a vote by hand, and put the winner on themselves.

## Setting it up (on the box)

1. Install the app from the box's Apps tab, and approve **video playback** when asked.
2. On the media server, **create a Jellyfin user that can only see the movie libraries**:
   - not an administrator;
   - video playback and transcoding allowed.

   Its key is what the TVs' links carry.
3. Open the app's **Settings**:
   - Type the server's full address: `http://host:8096`, `https://host:8920`,
     `https://host/jellyfin`, any port, any path. With no `http://` or `https://`, it
     assumes `http://`.
   - Press **Save and test**. It shows the server's name and version.
   - Sign in as the limited user. Only its access token is kept, never the password.
4. Under TVs, check each TV's type. It's picked automatically from what the box says the TV
   is. Optionally set a bitrate cap, or turn 4K off.

The server must let in the bar's public IP: the TVs connect to it directly.

**Moving the server** (a new host, a tunnel, https on another port): change the address in
Settings. Nothing else depends on it, and if it's the same server, the sign-in carries over.

**https:**
- A real certificate is the normal case.
- A self-signed one can be trusted by its fingerprint. Settings shows it on first connect.
  **Apple TVs and Rokus won't accept a self-signed certificate**, though, so their links
  would fail: use http for the stream, or get a real certificate.
- With plain http, the token in every link crosses the internet unencrypted.

## What plays how

Each TV type has a profile, kept as data in `shared/src/profiles.ts`. If the TV can play the
file as it is, it gets a direct link. Otherwise it gets the server's HLS (`master.m3u8`),
which remuxes when the codecs fit and transcodes when they don't.

| TV | Plays as it is |
|---|---|
| Apple TV 4K | up to 2160p, HEVC/H.264, HDR10/Dolby Vision, MP4/MOV (an MKV is remuxed to HLS), AAC/AC3/EAC3 |
| Roku Express (3930) | 1080p H.264, MP4/MKV, AAC/AC3 (passthrough) |
| Roku Streaming Stick (3800) | the same, plus HEVC |
| Venuebox app, screen on the box | whatever its player lists (containers, codecs, height). Otherwise HLS in HEVC if it lists it, else H.264 |
| Other | always 1080p H.264 HLS with stereo AAC |

The bitrate asked for is the TV's maximum, lowered by the per-TV cap.

What a pick plays:
- a movie or an episode plays on its own;
- a series plays from its next unwatched episode and carries on;
- a collection plays its movies in order;
- a library plays shuffled.

**Audio and subtitles:** staff pick them in a movie's details, or change them from the TV
dock while it plays.
- Another audio track has the server repackage the movie with it; the picture isn't changed.
- Subtitles are burned into the picture, a full conversion: the heaviest work the server does.
- With the default audio and no subtitles, nothing is converted that doesn't need to be.
- On a TV whose player switches tracks itself (a Venuebox app, a screen on the box, box
  0.29.0), the movie plays as it is whatever is chosen, text subtitles come as a side file,
  and switching is instant. The TV's own remote can change them, and skip to the next or
  previous episode.

Start, progress and stop are reported to Jellyfin, so its resume points stay right.

## Development

```bash
npm install
npm test                 # shared + server tests (a fake Jellyfin, fake TVs, a fake box)
npm run build
MOVIES_FAKE_TVS=1 ADMIN_PASSWORD=dev-pass npm start    # http://localhost:3017
```

- `MOVIES_FAKE_TVS=1` gives four pretend TVs (Apple TV, Roku, Venuebox app, other). Each play fetches the link the way a TV
  would: a file's first bytes, or an HLS playlist and its first segment. That proves the
  server hands out a link that works.
- Against a pretend box: `npx bargames mock-box . --base /movies` (Git Bash:
  `MSYS_NO_PATHCONV=1`), then start the server with the env vars it prints.

**Privacy:**
- Never log a stream link, token or key.
- Every log line goes through `redact()` (`shared/src/redact.ts`).
- Stream links aren't sent in events.
- The server address, certificate pin and token live only in `/data`.

## Plex

Plex is the next source, behind the same `MediaSource` interface. See
`server/src/sources/plex.ts`.
