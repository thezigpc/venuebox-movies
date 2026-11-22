// Jellyfin behind MediaSource. Signs in as a dedicated, limited Jellyfin user and keeps only
// its access token. Stream links come from PlaybackInfo with a device profile built from the
// TV's TvProfile: a direct link to the file when the TV can play it as it is, otherwise the
// server's HLS (master.m3u8), which remuxes when the codecs fit and transcodes when not.
//
// Every address is built from the configured server URL (any scheme, host, port, base path),
// so a move behind a tunnel is a settings change only.

import { audioTrackId, canDirectPlay, serverPath, subtitleTrackId, type Card, type FileDetails, type FileInfo, type ItemDetail, type ItemKind, type Library, type Page, type TestResult, type TrackChoice, type Tracks, type TvProfile } from "@movies/shared";
import { HttpError, type Http, type HttpResponse } from "../http.js";
import { SourceError, type MediaSource, type NativeTrack, type NativeTracks, type Playback, type PlaybackOptions, type PlaySession, type ReportPosition } from "./types.js";
import { log } from "../log.js";

export interface JellyfinAuth {
  token: string;
  userId: string;
}

export interface JellyfinOptions {
  http: Http;
  /** The normalised server address (null: not set). Read on every call. */
  baseUrl: () => string | null;
  auth: () => JellyfinAuth | null;
  deviceId: () => string;
  deviceName: () => string;
  version: string;
  /** Our own poster path for an item id (signed), for the staff page's cards. */
  posterPath: (id: string) => string;
}

export interface SignInResult {
  token: string;
  userId: string;
  userName: string;
  isAdmin: boolean;
  serverId: string;
}

const TICKS = 10_000_000;
const toTicks = (sec: number) => Math.max(0, Math.round(sec * TICKS));
const fromTicks = (t?: number | null) => (t ? t / TICKS : 0);

/** Jellyfin's JSON, the parts we read. */
interface JItem {
  Id: string;
  Name?: string;
  Type?: string;
  CollectionType?: string;
  ProductionYear?: number;
  EndDate?: string;
  Overview?: string;
  RunTimeTicks?: number;
  ImageTags?: Record<string, string>;
  SeriesId?: string;
  SeriesName?: string;
  SeriesPrimaryImageTag?: string;
  SeasonId?: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  UserData?: { Played?: boolean; PlayedPercentage?: number; PlaybackPositionTicks?: number };
  MediaSources?: JSource[];
  ChildCount?: number;
}
interface JStream {
  Type?: string;
  Codec?: string;
  Width?: number;
  Height?: number;
  VideoRange?: string;
  VideoRangeType?: string;
  BitDepth?: number;
  Channels?: number;
  Language?: string;
  DisplayTitle?: string;
  Index?: number;
  IsDefault?: boolean;
  IsForced?: boolean;
  IsExternal?: boolean;
  IsTextSubtitleStream?: boolean;
  Title?: string;
}
interface JSource {
  Id: string;
  Container?: string;
  Bitrate?: number;
  Size?: number;
  RunTimeTicks?: number;
  MediaStreams?: JStream[];
  DefaultAudioStreamIndex?: number;
  SupportsDirectPlay?: boolean;
  SupportsTranscoding?: boolean;
  TranscodingUrl?: string;
  TranscodeReasons?: string[] | string;
}

const KIND: Record<string, ItemKind> = {
  Movie: "movie",
  Series: "series",
  Season: "season",
  Episode: "episode",
  BoxSet: "collection",
  CollectionFolder: "library",
  UserView: "library",
  Folder: "folder",
};

const MIME: Record<string, string> = { mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", mkv: "video/x-matroska", webm: "video/webm", ts: "video/mp2t", avi: "video/x-msvideo" };
const HLS_MIME = "application/vnd.apple.mpegurl";

/** The VideoRangeType values a TV with these ranges can be sent as they are. */
function rangeTypes(ranges: string[]): string[] {
  const out = new Set<string>();
  for (const r of ranges.map((x) => x.toUpperCase())) {
    if (r === "SDR") out.add("SDR");
    if (r === "HDR10") ["HDR10", "DOVIWithHDR10"].forEach((x) => out.add(x));
    if (r === "HDR10PLUS") ["HDR10Plus", "DOVIWithHDR10Plus"].forEach((x) => out.add(x));
    if (r === "HLG") ["HLG", "DOVIWithHLG"].forEach((x) => out.add(x));
    if (r === "DOVI") ["DOVI", "DOVIWithHDR10", "DOVIWithHLG", "DOVIWithSDR", "DOVIWithHDR10Plus"].forEach((x) => out.add(x));
  }
  return [...out];
}

const SUBTITLE_FORMATS = ["srt", "subrip", "ass", "ssa", "vtt", "webvtt", "mov_text", "pgssub", "pgs", "dvdsub", "dvbsub", "sub", "idx", "smi"];

/**
 * The server's HLS link without a burned-in subtitle. Jellyfin picks the user's default
 * subtitle track by itself (SubtitleStreamIndex -1 in the request doesn't stop it) and, for
 * HLS, burns it into the picture: a full video transcode nobody asked for. Dropping the
 * subtitle parameters gives the plain remux or transcode.
 */
export function withoutBurnedSubtitles(path: string): string {
  const [p, q = ""] = path.split("?", 2) as [string, string?];
  const params = new URLSearchParams(q);
  if (!params.has("SubtitleStreamIndex") && !params.has("SubtitleMethod")) return path;
  for (const k of ["SubtitleStreamIndex", "SubtitleMethod", "SubtitleCodec"]) params.delete(k);
  const reasons = params.get("TranscodeReasons");
  if (reasons != null) {
    const kept = reasons.split(",").filter((r) => r && r !== "SubtitleCodecNotSupported");
    if (kept.length) params.set("TranscodeReasons", kept.join(","));
    else params.delete("TranscodeReasons");
  }
  return `${p}?${params}`;
}

/** The server's reasons for converting: a field on older servers, in the link on 10.9+. */
function transcodeReasons(src: JSource, path: string): string[] {
  const field = Array.isArray(src.TranscodeReasons) ? src.TranscodeReasons : src.TranscodeReasons ? String(src.TranscodeReasons).split(",") : [];
  const fromUrl = new URLSearchParams(path.split("?", 2)[1] ?? "").get("TranscodeReasons")?.split(",") ?? [];
  return [...new Set([...field, ...fromUrl])].filter((r) => r && r !== "SubtitleCodecNotSupported");
}

/** Jellyfin's DeviceProfile for a TV: what it plays as it is, and the HLS to make otherwise. */
export function deviceProfile(p: TvProfile): Record<string, unknown> {
  return {
    Name: p.id === "venuebox" ? p.label : `Venuebox ${p.label}`,
    MaxStreamingBitrate: p.maxBitrate,
    MaxStaticBitrate: p.maxBitrate,
    DirectPlayProfiles: p.directContainers.length ? [{ Type: "Video", Container: p.directContainers.join(","), VideoCodec: p.videoCodecs.join(","), AudioCodec: p.audioCodecs.join(",") }] : [],
    TranscodingProfiles: [
      {
        Type: "Video",
        Container: p.hls.segment,
        Protocol: "hls",
        VideoCodec: p.hls.videoCodecs.join(","),
        AudioCodec: p.audioCodecs.join(","),
        Context: "Streaming",
        MaxAudioChannels: String(p.maxAudioChannels),
        MinSegments: 1,
        BreakOnNonKeyFrames: true,
      },
    ],
    ContainerProfiles: [],
    CodecProfiles: [
      {
        Type: "Video",
        Conditions: [
          { Condition: "LessThanEqual", Property: "Width", Value: String(p.maxWidth), IsRequired: false },
          { Condition: "LessThanEqual", Property: "Height", Value: String(p.maxHeight), IsRequired: false },
          { Condition: "EqualsAny", Property: "VideoRangeType", Value: rangeTypes(p.videoRanges).join("|"), IsRequired: false },
        ],
      },
      { Type: "VideoAudio", Conditions: [{ Condition: "LessThanEqual", Property: "AudioChannels", Value: String(p.maxAudioChannels), IsRequired: false }] },
    ],
    // No subtitles are shown yet, and none may be burned in. Declaring the usual formats as
    // embedded lets a file with a default subtitle track (often PGS) play as it is: without
    // them, the server refuses direct play (SubtitleCodecNotSupported) and burns the track in.
    SubtitleProfiles: SUBTITLE_FORMATS.map((Format) => ({ Format, Method: "Embed" })),
  };
}

function pickAudio(s: JSource): JStream | undefined {
  const audio = (s.MediaStreams ?? []).filter((m) => m.Type === "Audio");
  return audio.find((m) => m.Index === s.DefaultAudioStreamIndex) ?? audio.find((m) => m.IsDefault) ?? audio[0];
}

/** Drops undefined fields (smaller JSON, simpler comparisons). */
const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export function fileDetails(s: JSource): FileDetails {
  const v = (s.MediaStreams ?? []).find((m) => m.Type === "Video");
  const a = pickAudio(s);
  return {
    container: (s.Container ?? "").toLowerCase(),
    ...(v ? { video: defined({ codec: (v.Codec ?? "").toLowerCase(), width: v.Width, height: v.Height, range: v.VideoRangeType ?? v.VideoRange ?? "SDR", bitDepth: v.BitDepth }) } : {}),
    ...(a ? { audio: defined({ codec: (a.Codec ?? "").toLowerCase(), channels: a.Channels, language: a.Language, title: a.DisplayTitle }) } : {}),
    ...(s.Bitrate ? { bitrate: s.Bitrate } : {}),
    ...(s.Size ? { sizeBytes: s.Size } : {}),
  };
}

/** A track's name for staff: the server's, without the flags we show ourselves. */
function trackLabel(m: JStream): string {
  const base = (m.DisplayTitle ?? m.Title ?? "").replace(/\s*-\s*(Default|Forced|External)\b/gi, "").trim();
  return base || [m.Language, (m.Codec ?? "").toUpperCase()].filter(Boolean).join(" ") || `Track ${m.Index ?? "?"}`;
}

export function fileTracks(s: JSource): Tracks {
  const streams = s.MediaStreams ?? [];
  const track = (m: JStream) =>
    defined({
      index: m.Index ?? -1,
      label: trackLabel(m),
      language: m.Language || undefined,
      codec: (m.Codec ?? "").toLowerCase(),
      channels: m.Type === "Audio" ? m.Channels : undefined,
      default: m.IsDefault === true,
      forced: m.Type === "Subtitle" && m.IsForced ? true : undefined,
      external: m.Type === "Subtitle" && m.IsExternal ? true : undefined,
      text: m.Type === "Subtitle" ? m.IsTextSubtitleStream === true : undefined,
    });
  const def = pickAudio(s)?.Index;
  return {
    audio: streams.filter((m) => m.Type === "Audio" && typeof m.Index === "number").map(track),
    subtitles: streams.filter((m) => m.Type === "Subtitle" && typeof m.Index === "number").map(track),
    ...(typeof def === "number" ? { defaultAudio: def } : {}),
  };
}

const fileInfo = (d: FileDetails): FileInfo => ({ container: d.container, video: d.video, audio: d.audio, bitrate: d.bitrate });

function quote(v: string): string {
  return v.replace(/["\\\r\n]/g, "");
}

export class JellyfinSource implements MediaSource {
  readonly kind = "jellyfin" as const;

  constructor(private readonly o: JellyfinOptions) {}

  private base(): string {
    const b = this.o.baseUrl();
    if (!b) throw new SourceError("Set the media server's address in settings first.", 409, "refused");
    return b;
  }

  private authHeader(token?: string): string {
    const parts = [`Client="Venuebox Movies"`, `Device="${quote(this.o.deviceName())}"`, `DeviceId="${quote(this.o.deviceId())}"`, `Version="${this.o.version}"`];
    if (token) parts.push(`Token="${quote(token)}"`);
    return `MediaBrowser ${parts.join(", ")}`;
  }

  private requireAuth(): JellyfinAuth {
    const a = this.o.auth();
    if (!a) throw new SourceError("Sign in to the media server in settings first.", 401, "signed-out");
    return a;
  }

  private async call(method: string, path: string, body?: unknown, opts: { auth?: boolean; timeoutMs?: number } = {}): Promise<HttpResponse> {
    const url = serverPath(this.base(), path);
    const token = opts.auth === false ? undefined : this.requireAuth().token;
    let res: HttpResponse;
    try {
      res = await this.o.http({
        method,
        url,
        headers: { authorization: this.authHeader(token), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        timeoutMs: opts.timeoutMs ?? 15_000,
      });
    } catch (err) {
      if (err instanceof HttpError) {
        const cert = err.kind === "cert-untrusted" || err.kind === "pin-mismatch";
        throw new SourceError(err.message, 502, cert ? "cert" : "unreachable");
      }
      throw new SourceError(`Couldn't reach the media server (${(err as Error).message}).`, 502, "unreachable");
    }
    if (res.status === 401) throw new SourceError("The media server no longer accepts this app's sign-in. Sign in again in settings.", 401, "signed-out");
    if (res.status === 403) throw new SourceError("The media server refused: this user isn't allowed to do that (check the user's library access and playback rights).", 409, "refused");
    if (res.status === 404) throw new SourceError("The media server doesn't have that any more.", 404, "not-found");
    if (res.status >= 400) throw new SourceError(`The media server answered ${res.status}.`, 502, "other");
    return res;
  }

  private async get<T>(path: string): Promise<T> {
    const r = await this.call("GET", path);
    try {
      return r.json<T>();
    } catch {
      throw new SourceError("The media server's answer wasn't readable.", 502);
    }
  }

  private uid(): string {
    return encodeURIComponent(this.requireAuth().userId);
  }

  // ---------------------------------------------------------------- connection

  async test(): Promise<TestResult & { serverId?: string }> {
    let r: HttpResponse;
    try {
      r = await this.call("GET", "/System/Info/Public", undefined, { auth: false, timeoutMs: 10_000 });
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    let info: { ServerName?: string; Version?: string; ProductName?: string; Id?: string };
    try {
      info = r.json();
    } catch {
      return { ok: false, error: "That address answers, but it isn't a Jellyfin server (no server info). Check the port and the base path." };
    }
    if (!info?.Version || !info.Id) return { ok: false, error: "That address answers, but it isn't a Jellyfin server. Check the port and the base path." };
    if (info.ProductName && !/jellyfin/i.test(info.ProductName)) return { ok: false, error: `That's ${info.ProductName}, not Jellyfin.` };
    return { ok: true, serverName: info.ServerName, version: info.Version, product: info.ProductName ?? "Jellyfin Server", serverId: info.Id };
  }

  /** Signs in as the venue's limited user. The password is used once and never kept. */
  async signIn(username: string, password: string): Promise<SignInResult> {
    const r = await this.call("POST", "/Users/AuthenticateByName", { Username: username, Pw: password }, { auth: false }).catch((err: SourceError) => {
      if (err.kind === "signed-out") throw new SourceError("The server didn't accept that user name and password.", 400, "refused");
      throw err;
    });
    const a = r.json<{ AccessToken?: string; ServerId?: string; User?: { Id?: string; Name?: string; Policy?: { IsAdministrator?: boolean } } }>();
    if (!a.AccessToken || !a.User?.Id) throw new SourceError("The server's sign-in answer was missing its token.", 502);
    return { token: a.AccessToken, userId: a.User.Id, userName: a.User.Name ?? username, isAdmin: !!a.User.Policy?.IsAdministrator, serverId: a.ServerId ?? "" };
  }

  async signOut(): Promise<void> {
    await this.call("POST", "/Sessions/Logout", undefined, { timeoutMs: 5000 }).catch(() => undefined);
  }

  /** The signed-in user, to check a stored token still works. */
  async me(): Promise<{ name: string; isAdmin: boolean }> {
    const u = await this.get<{ Name?: string; Policy?: { IsAdministrator?: boolean } }>("/Users/Me");
    return { name: u.Name ?? "", isAdmin: !!u.Policy?.IsAdministrator };
  }

  // ---------------------------------------------------------------- browsing

  private posterFor(it: JItem): string | undefined {
    if (it.ImageTags?.Primary) return this.o.posterPath(it.Id);
    if (it.SeriesId && it.SeriesPrimaryImageTag) return this.o.posterPath(it.SeriesId);
    return undefined;
  }

  private card(it: JItem): Card {
    const kind = KIND[it.Type ?? ""] ?? "other";
    const pct = it.UserData?.PlayedPercentage;
    let subtitle: string | undefined;
    if (kind === "episode") subtitle = [it.ParentIndexNumber != null && it.IndexNumber != null ? `S${it.ParentIndexNumber} E${it.IndexNumber}` : "", it.SeriesName].filter(Boolean).join(" · ");
    else if (kind === "season") subtitle = it.SeriesName;
    else if (kind === "series" && it.ProductionYear) subtitle = it.EndDate ? `${it.ProductionYear}–${new Date(it.EndDate).getFullYear()}` : `${it.ProductionYear}–`;
    else if (kind === "collection" && it.ChildCount) subtitle = `${it.ChildCount} titles`;
    const poster = this.posterFor(it);
    return {
      id: it.Id,
      kind,
      title: it.Name ?? "Untitled",
      ...(it.ProductionYear && kind !== "series" ? { year: it.ProductionYear } : {}),
      ...(subtitle ? { subtitle } : {}),
      ...(poster ? { poster } : {}),
      ...(it.UserData?.Played ? { played: true } : {}),
      ...(pct && pct > 0 && pct < 100 && !it.UserData?.Played ? { progress: pct / 100 } : {}),
    };
  }

  async libraries(): Promise<Library[]> {
    const v = await this.get<{ Items?: JItem[] }>(`/UserViews?userId=${this.uid()}`);
    const kinds: Record<string, Library["kind"]> = { movies: "movies", tvshows: "tvshows", boxsets: "boxsets", "": "mixed", mixed: "mixed", homevideos: "mixed" };
    return (v.Items ?? []).flatMap((it) => {
      const kind = kinds[(it.CollectionType ?? "").toLowerCase()];
      if (!kind) return []; // music, books, live TV, playlists: not for a TV here
      const poster = it.ImageTags?.Primary ? this.o.posterPath(it.Id) : undefined;
      return [{ id: it.Id, title: it.Name ?? "Library", kind, ...(poster ? { poster } : {}) }];
    });
  }

  async resume(): Promise<Card[]> {
    const r = await this.get<{ Items?: JItem[] }>(`/Users/${this.uid()}/Items/Resume?mediaTypes=Video&includeItemTypes=Movie,Episode&fields=ChildCount&enableImageTypes=Primary&imageTypeLimit=1&limit=12`);
    return (r.Items ?? []).map((it) => this.card(it));
  }

  async collections(): Promise<Card[]> {
    const r = await this.get<{ Items?: JItem[] }>(`/Items?userId=${this.uid()}&recursive=true&includeItemTypes=BoxSet&sortBy=SortName&fields=ChildCount&limit=200`);
    return (r.Items ?? []).map((it) => this.card(it));
  }

  private static types(kind: Library["kind"]): string {
    return kind === "movies" ? "Movie" : kind === "tvshows" ? "Series" : kind === "boxsets" ? "BoxSet" : "Movie,Series,BoxSet";
  }

  async browse(libraryId: string, page: number, pageSize = 60): Promise<Page<Card>> {
    const lib = (await this.libraries()).find((l) => l.id === libraryId);
    if (!lib) throw new SourceError("That library isn't on the server any more (or this user can't see it).", 404, "not-found");
    const p = Math.max(0, Math.floor(page));
    const size = Math.min(100, Math.max(1, Math.floor(pageSize)));
    const q = `/Items?userId=${this.uid()}&parentId=${encodeURIComponent(libraryId)}&recursive=true&includeItemTypes=${JellyfinSource.types(lib.kind)}&sortBy=SortName&sortOrder=Ascending&fields=ChildCount&enableImageTypes=Primary&imageTypeLimit=1&startIndex=${p * size}&limit=${size}`;
    const r = await this.get<{ Items?: JItem[]; TotalRecordCount?: number }>(q);
    return { items: (r.Items ?? []).map((it) => this.card(it)), total: r.TotalRecordCount ?? 0, page: p, pageSize: size };
  }

  async search(q: string): Promise<Card[]> {
    const term = q.trim().slice(0, 100);
    if (term.length < 2) return [];
    const r = await this.get<{ Items?: JItem[] }>(`/Items?userId=${this.uid()}&searchTerm=${encodeURIComponent(term)}&recursive=true&includeItemTypes=Movie,Series,BoxSet,Episode&fields=ChildCount&enableImageTypes=Primary&imageTypeLimit=1&limit=48`);
    // Movies, shows and collections first, then episodes.
    const order: Record<string, number> = { movie: 0, collection: 1, series: 1, episode: 2 };
    return (r.Items ?? []).map((it) => this.card(it)).sort((a, b) => (order[a.kind] ?? 3) - (order[b.kind] ?? 3));
  }

  private async raw(id: string): Promise<JItem> {
    try {
      return await this.get<JItem>(`/Items/${encodeURIComponent(id)}?userId=${this.uid()}`);
    } catch (err) {
      // Before Jellyfin 10.9 a user's item lived under /Users/{id}/Items/{id}.
      if (err instanceof SourceError && err.kind === "not-found") return this.get<JItem>(`/Users/${this.uid()}/Items/${encodeURIComponent(id)}`);
      throw err;
    }
  }

  private async episodes(seriesId: string, seasonId?: string): Promise<JItem[]> {
    const r = await this.get<{ Items?: JItem[] }>(`/Shows/${encodeURIComponent(seriesId)}/Episodes?userId=${this.uid()}${seasonId ? `&seasonId=${encodeURIComponent(seasonId)}` : ""}&fields=UserData&enableImageTypes=Primary&imageTypeLimit=1&limit=3000`);
    return r.Items ?? [];
  }

  private async children(it: JItem): Promise<JItem[]> {
    if (it.Type === "Series") return (await this.get<{ Items?: JItem[] }>(`/Shows/${encodeURIComponent(it.Id)}/Seasons?userId=${this.uid()}&fields=ChildCount`)).Items ?? [];
    if (it.Type === "Season") return this.episodes(it.SeriesId ?? "", it.Id);
    if (it.Type === "BoxSet") return (await this.get<{ Items?: JItem[] }>(`/Items?userId=${this.uid()}&parentId=${encodeURIComponent(it.Id)}&sortBy=ProductionYear,SortName&fields=ChildCount&limit=500`)).Items ?? [];
    return [];
  }

  async item(id: string): Promise<ItemDetail> {
    const it = await this.raw(id);
    const card = this.card(it);
    const src = it.MediaSources?.[0];
    const kids = ["Series", "Season", "BoxSet"].includes(it.Type ?? "") ? await this.children(it) : [];
    const resume = fromTicks(it.UserData?.PlaybackPositionTicks);
    return {
      ...card,
      ...(it.Overview ? { overview: it.Overview } : {}),
      ...(it.RunTimeTicks ? { runtimeSec: Math.round(fromTicks(it.RunTimeTicks)) } : {}),
      ...(resume > 0 && !it.UserData?.Played ? { resumeSec: Math.round(resume) } : {}),
      ...(src ? { file: fileDetails(src), tracks: fileTracks(src) } : {}),
      ...(kids.length ? { children: kids.map((k) => this.card(k)) } : {}),
      ...(it.SeriesName ? { seriesTitle: it.SeriesName } : {}),
      playable: ["movie", "episode", "series", "season", "collection"].includes(card.kind),
    };
  }

  async queue(id: string): Promise<{ ids: string[]; label: string }> {
    const it = await this.raw(id);
    const label = it.Name ?? "";
    const playable = (x: JItem) => x.Type === "Movie" || x.Type === "Episode";
    if (playable(it)) return { ids: [it.Id], label };
    const fromNextUp = (eps: JItem[]) => {
      const start = eps.findIndex((e) => !e.UserData?.Played);
      return eps.slice(start < 0 ? 0 : start, (start < 0 ? 0 : start) + 50).map((e) => e.Id);
    };
    if (it.Type === "Series") return { ids: fromNextUp(await this.episodes(it.Id)), label };
    if (it.Type === "Season") return { ids: fromNextUp(await this.episodes(it.SeriesId ?? "", it.Id)), label: [it.SeriesName, label].filter(Boolean).join(" · ") };
    if (it.Type === "BoxSet") return { ids: (await this.children(it)).filter(playable).map((x) => x.Id), label };
    if (it.Type === "CollectionFolder" || it.Type === "UserView" || it.Type === "Folder") {
      const r = await this.get<{ Items?: JItem[] }>(`/Items?userId=${this.uid()}&parentId=${encodeURIComponent(it.Id)}&recursive=true&includeItemTypes=Movie,Episode&sortBy=Random&limit=25`);
      return { ids: (r.Items ?? []).map((x) => x.Id), label: `${label} (shuffle)` };
    }
    throw new SourceError("That can't be played on a TV.", 409, "refused");
  }

  // ---------------------------------------------------------------- playback

  /**
   * Asks the server how to play an item. Track choices only count with the file's id
   * (mediaSourceId): without it the server takes its own defaults, subtitle included.
   */
  private async playbackInfo(id: string, tv: TvProfile, directPlay: boolean, tracks?: { mediaSourceId: string; audioIndex?: number; subtitleIndex: number }) {
    const auth = this.requireAuth();
    const q = new URLSearchParams({ userId: auth.userId });
    if (tracks) {
      q.set("mediaSourceId", tracks.mediaSourceId);
      if (tracks.audioIndex != null) q.set("audioStreamIndex", String(tracks.audioIndex));
      q.set("subtitleStreamIndex", String(tracks.subtitleIndex));
    }
    const r = await this.call("POST", `/Items/${encodeURIComponent(id)}/PlaybackInfo?${q}`, {
      UserId: auth.userId,
      ...(tracks ? { MediaSourceId: tracks.mediaSourceId, ...(tracks.audioIndex != null ? { AudioStreamIndex: tracks.audioIndex } : {}) } : {}),
      DeviceProfile: deviceProfile(tv),
      MaxStreamingBitrate: tv.maxBitrate,
      EnableDirectPlay: directPlay,
      EnableDirectStream: false,
      EnableTranscoding: true,
      AllowVideoStreamCopy: true,
      AllowAudioStreamCopy: true,
      SubtitleStreamIndex: tracks?.subtitleIndex ?? -1,
      AutoOpenLiveStream: true,
    });
    return r.json<{ MediaSources?: JSource[]; PlaySessionId?: string; ErrorCode?: string }>();
  }

  async playback(id: string, tv: TvProfile, opts: PlaybackOptions = {}): Promise<Playback> {
    const auth = this.requireAuth();
    let info = await this.playbackInfo(id, tv, true);
    const first = info.MediaSources?.[0];
    const streams = first?.MediaStreams ?? [];
    const find = (type: string, i?: number | null) => (i != null && i >= 0 ? streams.find((m) => m.Type === type && m.Index === i) : undefined);
    const defAudio = first ? pickAudio(first)?.Index : undefined;
    const audioIndex = find("Audio", opts.audioIndex) && opts.audioIndex !== defAudio ? opts.audioIndex : undefined;
    const sub = find("Subtitle", opts.subtitleIndex);
    const subtitleIndex = sub?.Index ?? null;
    const fitsAsIs = !!first?.SupportsDirectPlay && !first.TranscodingUrl && canDirectPlay(tv, fileInfo(fileDetails(first))).ok;
    const native = opts.native === true;
    // A player that switches tracks itself (SDK 0.19.0) gets the file as it is with every track
    // listed, and text subtitles as a side file: no repackaging, nothing burned in. Only a
    // picture subtitle (PGS, DVD) that isn't inside a file it plays as it is gets burned in.
    // Other TVs pick the default track themselves, so a choice means the server's HLS.
    const burn = sub ? (native ? sub.IsTextSubtitleStream !== true && (!fitsAsIs || sub.IsExternal === true) : true) : false;
    const viaHls = burn || (audioIndex != null && (!native || !fitsAsIs));
    if (first && viaHls) {
      info = await this.playbackInfo(id, tv, false, { mediaSourceId: first.Id, audioIndex, subtitleIndex: burn ? (subtitleIndex as number) : -1 });
    } else if (first?.SupportsDirectPlay && !first.TranscodingUrl && !fitsAsIs) {
      // The server would send the file as it is, but our own check says this TV can't play it
      // (an MKV on an Apple TV, 4K turned off): ask again for its HLS.
      info = await this.playbackInfo(id, tv, false);
    }
    if (info.ErrorCode) {
      const why: Record<string, string> = {
        NotAllowed: "This Jellyfin user isn't allowed to play that (check its playback rights).",
        NoCompatibleStream: "The server has no version of that this TV can play, and won't transcode it.",
        RateLimitExceeded: "The server's streaming limit for this user is reached.",
      };
      throw new SourceError(why[info.ErrorCode] ?? `The server can't play that (${info.ErrorCode}).`, 409, "refused");
    }
    const src = info.MediaSources?.[0];
    if (!src) throw new SourceError("The server has no playable file for that.", 409, "refused");
    const ps = info.PlaySessionId ?? "";
    const details = fileDetails(src);
    const ours = canDirectPlay(tv, fileInfo(details));
    const base = this.base();
    const startAt = opts.startAt && opts.startAt > 0 ? Math.round(opts.startAt) : undefined;
    if (src.SupportsDirectPlay && ours.ok) {
      const containers = details.container.split(",").map((c) => c.trim());
      // The TV's own order: Jellyfin calls an MP4 "mov,mp4,m4a,…", and .mp4 is the safer name.
      const ext = tv.directContainers.find((c) => containers.includes(c)) ?? containers[0] ?? "mp4";
      const q = new URLSearchParams({ static: "true", MediaSourceId: src.Id, PlaySessionId: ps, DeviceId: this.o.deviceId(), api_key: auth.token });
      const audioOn = native && opts.audioIndex != null && find("Audio", opts.audioIndex) ? opts.audioIndex : defAudio;
      const subOn = native ? subtitleIndex : null;
      return {
        url: serverPath(base, `/Videos/${encodeURIComponent(id)}/stream.${ext}?${q}`),
        mime: MIME[ext] ?? "video/mp4",
        directPlay: true,
        ...(startAt ? { startAt } : {}),
        reasons: [],
        session: { itemId: id, mediaSourceId: src.Id, playSessionId: ps, method: "direct" },
        ...(typeof audioOn === "number" ? { audioIndex: audioOn } : {}),
        subtitleIndex: subOn,
        burned: null,
        ...(native ? { tracks: this.nativeTracks(id, src, { direct: true, audioOn, subtitleOn: subOn, defAudio }, auth.token) } : {}),
      };
    }
    if (!src.TranscodingUrl) {
      throw new SourceError("This TV can't play that file as it is, and the server won't transcode it for this user (turn on transcoding for the Jellyfin user).", 409, "refused");
    }
    // Nothing to burn in: the server's own subtitle pick isn't burned in either.
    let path = burn ? src.TranscodingUrl : withoutBurnedSubtitles(src.TranscodingUrl);
    const urlQ = new URLSearchParams(path.split("?", 2)[1] ?? "");
    const usedAudio = Number(urlQ.get("AudioStreamIndex") ?? NaN);
    const burned = burn && urlQ.get("SubtitleStreamIndex") === String(subtitleIndex) ? subtitleIndex : null;
    if (burn && burned == null) log.warn("jellyfin", "the server didn't take the subtitle", { item: id, subtitle: subtitleIndex });
    if (!/[?&](api_key|ApiKey)=/i.test(path)) path += `${path.includes("?") ? "&" : "?"}api_key=${encodeURIComponent(auth.token)}`;
    const serverReasons = transcodeReasons(src, path).filter((r) => r !== "DirectPlayError");
    const picked = [...(audioIndex != null ? ["another audio track"] : []), ...(burned != null ? ["subtitles burned in"] : [])];
    const audioOn = Number.isFinite(usedAudio) ? usedAudio : defAudio;
    // Native: a text subtitle is a side file on top of the converted picture.
    const subOn = burned ?? (native && sub && sub.IsTextSubtitleStream === true ? subtitleIndex : null);
    return {
      url: serverPath(base, path),
      mime: HLS_MIME,
      directPlay: false,
      ...(startAt ? { startAt } : {}),
      reasons: [...new Set([...picked, ...(ours.ok ? serverReasons : ours.reasons)])],
      session: { itemId: id, mediaSourceId: src.Id, playSessionId: ps, method: "transcode" },
      ...(typeof audioOn === "number" ? { audioIndex: audioOn } : {}),
      subtitleIndex: subOn,
      burned,
      ...(native ? { tracks: this.nativeTracks(id, src, { direct: false, audioOn, subtitleOn: subOn, defAudio }, auth.token) } : {}),
    };
  }

  /**
   * Every track for a player that switches them itself. In a file sent as it is, a track's
   * place is its order among tracks of its kind in the file (side files aren't in it). In the
   * server's HLS there's one audio track (the one asked for) and no subtitles: text subtitles
   * come as a WebVTT side file instead, and picture ones can't be switched to (the player
   * answers "unsupported" and we start again with it burned in).
   */
  private nativeTracks(id: string, src: JSource, o: { direct: boolean; audioOn?: number; subtitleOn: number | null; defAudio?: number }, token: string): NativeTracks {
    const streams = (src.MediaStreams ?? []).filter((m) => typeof m.Index === "number").sort((a, b) => (a.Index ?? 0) - (b.Index ?? 0));
    const audio = streams.filter((m) => m.Type === "Audio");
    const subs = streams.filter((m) => m.Type === "Subtitle");
    const inFile = subs.filter((m) => m.IsExternal !== true);
    const keep = <T extends { id: string }>(list: T[], on: (string | undefined)[]) => {
      if (list.length <= 32) return list;
      const must = list.filter((t) => on.includes(t.id));
      return [...must, ...list.filter((t) => !on.includes(t.id)).slice(0, 32 - must.length)];
    };
    const audioId = typeof o.audioOn === "number" ? audioTrackId(o.audioOn) : undefined;
    const subtitleId = o.subtitleOn != null ? subtitleTrackId(o.subtitleOn) : null;
    const audioTracks: NativeTrack[] = audio.map((m, pos) =>
      defined({
        id: audioTrackId(m.Index!),
        label: trackLabel(m).slice(0, 80),
        language: m.Language || undefined,
        index: o.direct ? pos : m.Index === o.audioOn ? 0 : undefined,
        default: m.Index === o.defAudio ? true : undefined,
      }),
    );
    const subTracks: NativeTrack[] = subs.map((m) => {
      const text = m.IsTextSubtitleStream === true;
      const pos = inFile.indexOf(m);
      const index = o.direct && pos >= 0 ? pos : undefined;
      const url = text && index == null ? this.subtitleUrl(id, src.Id, m.Index!, token) : undefined;
      return defined({
        id: subtitleTrackId(m.Index!),
        label: trackLabel(m).slice(0, 80),
        language: m.Language || undefined,
        index,
        url,
        format: url ? "vtt" : undefined,
        forced: m.IsForced ? true : undefined,
      });
    });
    return { audio: keep(audioTracks, [audioId]), subtitles: keep(subTracks, [subtitleId ?? undefined]), ...(audioId ? { audioId } : {}), subtitleId };
  }

  /** A text subtitle as WebVTT, for a player to load beside the video. Carries the key. */
  private subtitleUrl(id: string, mediaSourceId: string, index: number, token: string): string {
    return serverPath(this.base(), `/Videos/${encodeURIComponent(id)}/${encodeURIComponent(mediaSourceId)}/Subtitles/${index}/0/Stream.vtt?${new URLSearchParams({ api_key: token })}`);
  }

  tvPosterUrl(id: string): string | undefined {
    const b = this.o.baseUrl();
    // Jellyfin serves images without a key: the TV's link carries none.
    return b ? serverPath(b, `/Items/${encodeURIComponent(id)}/Images/Primary?maxWidth=600&quality=85`) : undefined;
  }

  async poster(id: string, width: number): Promise<{ contentType: string; body: Buffer } | null> {
    try {
      const r = await this.call("GET", `/Items/${encodeURIComponent(id)}/Images/Primary?maxWidth=${Math.round(width)}&quality=85`, undefined, { timeoutMs: 10_000 });
      const type = String(r.headers["content-type"] ?? "");
      if (!type.startsWith("image/")) return null;
      return { contentType: type, body: r.body };
    } catch (err) {
      if (err instanceof SourceError && err.kind === "not-found") return null;
      throw err;
    }
  }

  private body(s: PlaySession, p: ReportPosition, event?: string) {
    return {
      ItemId: s.itemId,
      MediaSourceId: s.mediaSourceId,
      PlaySessionId: s.playSessionId,
      PositionTicks: toTicks(p.positionSec),
      IsPaused: !!p.paused,
      PlayMethod: s.method === "direct" ? "DirectPlay" : "Transcode",
      CanSeek: true,
      ...(event ? { EventName: event } : {}),
    };
  }

  async reportStart(s: PlaySession, p: ReportPosition): Promise<void> {
    await this.call("POST", "/Sessions/Playing", this.body(s, p), { timeoutMs: 8000 });
  }

  async reportProgress(s: PlaySession, p: ReportPosition): Promise<void> {
    await this.call("POST", "/Sessions/Playing/Progress", this.body(s, p, p.paused ? "Pause" : "TimeUpdate"), { timeoutMs: 8000 });
  }

  async reportStop(s: PlaySession, p: ReportPosition): Promise<void> {
    await this.call("POST", "/Sessions/Playing/Stopped", this.body(s, p), { timeoutMs: 8000 });
    // A transcode keeps running on the server until it's told (or times out): free it.
    if (s.method === "transcode") {
      const q = new URLSearchParams({ deviceId: this.o.deviceId(), playSessionId: s.playSessionId });
      await this.call("DELETE", `/Videos/ActiveEncodings?${q}`, undefined, { timeoutMs: 8000 }).catch(() => undefined);
    }
  }
}
