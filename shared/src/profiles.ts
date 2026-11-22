// What each kind of TV can play as it is. Kept as data: a new TV model is a new entry here.
// The server's own device-profile format is built from these in the source (Jellyfin today).

export type TvProfileId = "appletv4k" | "roku3930" | "roku3800" | "venuebox" | "unknown";

export interface TvProfile {
  id: TvProfileId;
  label: string;
  maxWidth: number;
  maxHeight: number;
  /** Video codecs it plays, server names ("h264", "hevc"). */
  videoCodecs: string[];
  /** Dynamic ranges it plays: "SDR", "HDR10", "HDR10Plus", "HLG", "DOVI". */
  videoRanges: string[];
  /** Containers it plays from a plain file link. Empty: always ask for HLS. */
  directContainers: string[];
  /** The server's transcode when it can't play the file: HLS with these. */
  hls: { segment: "ts" | "mp4"; videoCodecs: string[] };
  audioCodecs: string[];
  maxAudioChannels: number;
  /** What the TV handles comfortably, bits per second (a per-TV cap may lower it). */
  maxBitrate: number;
}

export const TV_PROFILES: Record<TvProfileId, TvProfile> = {
  // AirPlay "play this URL": AVPlayer. MKV isn't an AVPlayer container, so an MKV gets the
  // server's HLS (a remux when the codecs fit: no quality lost, HDR kept).
  appletv4k: {
    id: "appletv4k",
    label: "Apple TV 4K",
    maxWidth: 3840,
    maxHeight: 2160,
    videoCodecs: ["hevc", "h264"],
    videoRanges: ["SDR", "HDR10", "HDR10Plus", "HLG", "DOVI"],
    directContainers: ["mp4", "m4v", "mov"],
    hls: { segment: "mp4", videoCodecs: ["hevc", "h264"] },
    audioCodecs: ["aac", "ac3", "eac3"],
    maxAudioChannels: 8,
    maxBitrate: 80_000_000,
  },
  // Roku's built-in player (ECP). AC3 is passed through to a receiver or the TV.
  roku3930: {
    id: "roku3930",
    label: "Roku Express (3930)",
    maxWidth: 1920,
    maxHeight: 1080,
    videoCodecs: ["h264"],
    videoRanges: ["SDR"],
    directContainers: ["mp4", "m4v", "mov", "mkv"],
    hls: { segment: "ts", videoCodecs: ["h264"] },
    audioCodecs: ["aac", "ac3"],
    maxAudioChannels: 6,
    maxBitrate: 20_000_000,
  },
  roku3800: {
    id: "roku3800",
    label: "Roku Streaming Stick (3800)",
    maxWidth: 1920,
    maxHeight: 1080,
    videoCodecs: ["h264", "hevc"],
    videoRanges: ["SDR"],
    directContainers: ["mp4", "m4v", "mov", "mkv"],
    hls: { segment: "ts", videoCodecs: ["h264"] },
    audioCodecs: ["aac", "ac3"],
    maxAudioChannels: 6,
    maxBitrate: 20_000_000,
  },
  // A TV whose player reports what it plays: a Venuebox app (Android/Google TV, a PC) or a
  // screen plugged into the box (kind "local"). Its real profile is built from those formats
  // (profileFromFormats); this is only for one that reports none.
  venuebox: {
    id: "venuebox",
    label: "Venuebox app",
    maxWidth: 1920,
    maxHeight: 1080,
    videoCodecs: ["h264"],
    videoRanges: ["SDR"],
    directContainers: ["mp4", "m4v", "mkv"],
    hls: { segment: "ts", videoCodecs: ["h264"] },
    audioCodecs: ["aac", "ac3"],
    maxAudioChannels: 6,
    maxBitrate: 20_000_000,
  },
  // A TV we don't know: 1080p H.264 HLS with stereo AAC plays everywhere.
  unknown: {
    id: "unknown",
    label: "Other TV (safe: 1080p H.264 HLS)",
    maxWidth: 1920,
    maxHeight: 1080,
    videoCodecs: ["h264"],
    videoRanges: ["SDR"],
    directContainers: [],
    hls: { segment: "ts", videoCodecs: ["h264"] },
    audioCodecs: ["aac"],
    maxAudioChannels: 2,
    maxBitrate: 10_000_000,
  },
};

export const PROFILE_IDS = Object.keys(TV_PROFILES) as TvProfileId[];
export const isProfileId = (v: unknown): v is TvProfileId => typeof v === "string" && v in TV_PROFILES;

/** Profiles staff can pick by hand. "venuebox" isn't one: it comes from what the TV reports. */
export const PICKABLE_PROFILE_IDS = PROFILE_IDS.filter((p) => p !== "venuebox");

/**
 * What a Venuebox app's player says it plays (bg.tvs()[].video.formats, SDK 0.18.0). Lower-case
 * names as Jellyfin uses them. "hls" in containers means it plays HLS (not a file container).
 */
export interface TvFormats {
  containers: string[];
  video: string[];
  audio: string[];
  maxHeight?: number;
  /** Seek and start part-way work. */
  seek: boolean;
  /** Audio it sends on to a receiver as it is (it plays those too). */
  passthrough?: string[];
  /** Picture ranges it shows correctly: "sdr" "hdr10" "hdr10plus" "hlg" "dovi" (SDK 0.18.1). Absent: SDR only. */
  ranges?: string[];
}

const RANGE_NAMES: Record<string, string> = { sdr: "SDR", hdr10: "HDR10", hdr10plus: "HDR10Plus", "hdr10+": "HDR10Plus", hlg: "HLG", dovi: "DOVI", dolbyvision: "DOVI" };

const lower = (xs: unknown): string[] => (Array.isArray(xs) ? xs.filter((x): x is string => typeof x === "string").map((x) => x.trim().toLowerCase()).filter(Boolean) : []);
const CODEC_ALIAS: Record<string, string> = { avc: "h264", h265: "hevc", hevc: "hevc", h264: "h264" };

/**
 * A Venuebox TV's profile, from the formats it reports. Direct play when the file fits them;
 * otherwise the server's HLS in the best codec it lists (HEVC in fMP4 segments, else H.264 in
 * TS). HDR only as its ranges list it; none listed means SDR (the server tone-maps HDR files).
 */
/** The profile's name for a TV that reports its formats, by what kind it is. */
export function formatsLabel(kind?: string): string {
  if (kind === "venuebox") return "Venuebox app";
  if (kind === "local") return "Screen on the box";
  return "Its own player";
}

export function profileFromFormats(f: TvFormats, kind = "venuebox"): TvProfile {
  const video = [...new Set(lower(f.video).map((c) => CODEC_ALIAS[c] ?? c))];
  const audio = [...new Set([...lower(f.audio), ...lower(f.passthrough)])];
  const containers = lower(f.containers).filter((c) => c !== "hls" && c !== "m3u8");
  const maxHeight = typeof f.maxHeight === "number" && f.maxHeight >= 240 ? Math.round(f.maxHeight) : 2160;
  const hlsCodecs = ["hevc", "h264"].filter((c) => video.includes(c));
  const ranges = [...new Set(["SDR", ...lower(f.ranges).flatMap((r) => (RANGE_NAMES[r] ? [RANGE_NAMES[r]] : []))])];
  return {
    id: "venuebox",
    label: formatsLabel(kind),
    maxWidth: Math.round((maxHeight * 16) / 9),
    maxHeight,
    videoCodecs: video.length ? video : ["h264"],
    videoRanges: ranges,
    directContainers: containers,
    hls: hlsCodecs.includes("hevc") ? { segment: "mp4", videoCodecs: hlsCodecs } : { segment: "ts", videoCodecs: ["h264"] },
    audioCodecs: audio.length ? audio : ["aac"],
    maxAudioChannels: 8,
    maxBitrate: maxHeight > 1080 ? 80_000_000 : maxHeight > 720 ? 40_000_000 : 20_000_000,
  };
}

/**
 * The profile for a box TV, from what the box says it is (bg.tvs() video). A TV that reports
 * its formats gets a profile built from them, whatever its kind (SDK 0.18.2).
 */
export function profileFor(video?: { kind?: string; model?: string; formats?: unknown } | null): TvProfileId {
  const kind = (video?.kind ?? "").toLowerCase();
  const model = (video?.model ?? "").toLowerCase();
  if (video?.formats || kind === "venuebox" || kind === "local") return "venuebox";
  if (kind === "appletv" || kind === "airplay") return "appletv4k";
  if (kind === "roku") {
    if (/^3800/.test(model) || /streaming stick/.test(model)) return "roku3800";
    // Any other Roku: the Express's H.264-only list is the one every Roku plays.
    return "roku3930";
  }
  return "unknown";
}

export interface TvOptions {
  /** Per-TV cap from settings, Mbit/s. null: the profile's own maximum. */
  capMbps?: number | null;
  /** Off: no more than 1080p even on a 4K TV (saves the server's upload). */
  allow4k?: boolean;
}

/** The profile with this TV's settings applied. One that reports formats gets its from them. */
export function effectiveProfile(id: TvProfileId, o: TvOptions = {}, formats?: TvFormats | null, kind?: string): TvProfile {
  const base = id === "venuebox" && formats ? profileFromFormats(formats, kind) : (TV_PROFILES[id] ?? TV_PROFILES.unknown);
  const p = id === "venuebox" && !formats && kind ? { ...base, label: formatsLabel(kind) } : base;
  const capped = o.allow4k === false && p.maxHeight > 1080 ? { ...p, maxWidth: 1920, maxHeight: 1080 } : p;
  return { ...capped, maxBitrate: chooseBitrate(capped, o.capMbps) };
}

/** The bitrate to ask for: the TV's maximum, lowered by a per-TV cap. */
export function chooseBitrate(p: Pick<TvProfile, "maxBitrate">, capMbps?: number | null): number {
  if (capMbps == null || !Number.isFinite(capMbps) || capMbps <= 0) return p.maxBitrate;
  return Math.min(p.maxBitrate, Math.round(capMbps * 1_000_000));
}

/** A file's details, as the source reports them. */
export interface FileInfo {
  /** One or several names, e.g. "mkv" or Jellyfin's "mov,mp4,m4a,3gp,3g2,mj2". */
  container: string;
  video?: { codec: string; width?: number; height?: number; range?: string };
  audio?: { codec: string; channels?: number };
  /** Bits per second, whole file. */
  bitrate?: number;
}

export type DirectPlay = { ok: true } | { ok: false; reasons: string[] };

/** Normalises a dynamic-range name to the family a TV must support ("DOVIWithHDR10" → "DOVI"). */
export function rangeFamily(range?: string): string {
  const r = (range ?? "SDR").toUpperCase();
  if (r.startsWith("DOVI")) return "DOVI";
  if (r.startsWith("HDR10PLUS") || r === "HDR10+") return "HDR10PLUS";
  if (r.startsWith("HDR10") || r === "HDR") return "HDR10";
  if (r.startsWith("HLG")) return "HLG";
  return "SDR";
}

/**
 * Can this TV play the file exactly as it is (a plain link to the file)? Our own check, next
 * to the server's: we only send a direct link when both agree, so an Apple TV never gets an
 * MKV it can't open. The reasons are for the staff page ("MKV: the server remuxes it").
 */
export function canDirectPlay(p: TvProfile, f: FileInfo): DirectPlay {
  const reasons: string[] = [];
  const containers = f.container.toLowerCase().split(",").map((c) => c.trim());
  if (!containers.some((c) => p.directContainers.includes(c))) reasons.push(`container ${containers[0] || "?"}`);
  if (f.video) {
    const codec = f.video.codec.toLowerCase();
    if (!p.videoCodecs.includes(codec === "avc" ? "h264" : codec === "h265" ? "hevc" : codec)) reasons.push(`video ${codec}`);
    if ((f.video.height ?? 0) > p.maxHeight || (f.video.width ?? 0) > p.maxWidth) reasons.push(`${f.video.height}p is above ${p.maxHeight}p`);
    const fam = rangeFamily(f.video.range);
    if (!p.videoRanges.map((r) => r.toUpperCase()).includes(fam)) reasons.push(`${fam} video`);
  }
  if (f.audio) {
    if (!p.audioCodecs.includes(f.audio.codec.toLowerCase())) reasons.push(`audio ${f.audio.codec.toLowerCase()}`);
    if ((f.audio.channels ?? 0) > p.maxAudioChannels) reasons.push(`${f.audio.channels} audio channels`);
  }
  if (f.bitrate && f.bitrate > p.maxBitrate) reasons.push(`${Math.round(f.bitrate / 1e6)} Mbit/s is above the ${Math.round(p.maxBitrate / 1e6)} Mbit/s cap`);
  return reasons.length ? { ok: false, reasons } : { ok: true };
}
