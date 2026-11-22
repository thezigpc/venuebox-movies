// What the server and the two pages (staff picker, settings) say to each other.

import type { TvProfileId } from "./profiles.js";

export const DEFAULT_NAME = "Movies";

export type ItemKind = "movie" | "series" | "season" | "episode" | "collection" | "library" | "folder" | "other";

/** A poster in a grid. `poster` is a path on this app's server (never the media server's). */
export interface Card {
  id: string;
  kind: ItemKind;
  title: string;
  year?: number;
  subtitle?: string;
  poster?: string;
  /** Watched to the end before. */
  played?: boolean;
  /** Part-watched: 0..1. */
  progress?: number;
}

export interface Library {
  id: string;
  title: string;
  kind: "movies" | "tvshows" | "boxsets" | "mixed";
  poster?: string;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** The file behind an item: shown to staff, used to choose direct play or transcode. */
export interface FileDetails {
  container: string;
  video?: { codec: string; width?: number; height?: number; range?: string; bitDepth?: number };
  audio?: { codec: string; channels?: number; language?: string; title?: string };
  bitrate?: number;
  sizeBytes?: number;
}

/** One audio or subtitle track of a file. */
export interface Track {
  /** The server's stream index. */
  index: number;
  /** "Dolby Digital 5.1 - English", "Commentary by the director - English - AAC - Stereo". */
  label: string;
  language?: string;
  codec: string;
  channels?: number;
  /** The file's default track. */
  default: boolean;
  /** Subtitles: only the foreign-language parts. */
  forced?: boolean;
  /** Subtitles: a file next to the video (.srt), not inside it. */
  external?: boolean;
  /** Subtitles: text (SRT, ASS…) rather than pictures (PGS, DVD). */
  text?: boolean;
}

export interface Tracks {
  audio: Track[];
  subtitles: Track[];
  /** The audio track that plays when none is picked. */
  defaultAudio?: number;
}

/**
 * Which tracks to play. Audio: a stream index; absent plays the default. Subtitles: a stream
 * index to burn in; null or absent: none.
 */
export interface TrackChoice {
  audioIndex?: number;
  subtitleIndex?: number | null;
}

export interface ItemDetail extends Card {
  overview?: string;
  runtimeSec?: number;
  /** Where the server's resume point is (part-watched), seconds. */
  resumeSec?: number;
  file?: FileDetails;
  /** A movie's or an episode's audio and subtitle tracks. */
  tracks?: Tracks;
  /** Seasons of a series, episodes of a season, movies of a collection. */
  children?: Card[];
  seriesTitle?: string;
  /** A movie or episode plays; a series, season or collection plays its next item. */
  playable: boolean;
}

export type TvState = "idle" | "starting" | "playing" | "paused" | "error" | "offline";

export interface NowPlaying {
  itemId: string;
  title: string;
  subtitle?: string;
  poster?: string;
  state: TvState;
  positionSec: number;
  durationSec?: number;
  method: "direct" | "transcode";
  /** What comes after this (a series' next episodes, the rest of a collection). */
  upNext?: string;
  message?: string;
  /** The tracks of what's playing, and which are on. */
  tracks?: Tracks;
  audioIndex?: number;
  /** The subtitle burned in, or null for none. */
  subtitleIndex?: number | null;
}

/** A box TV that can play video. */
export interface TvInfo {
  displayId: string;
  name: string;
  group?: string;
  kind: string;
  model?: string;
  online: boolean;
  profile: TvProfileId;
  /** The profile was chosen from what the box says the TV is (not set by staff). */
  profileAuto: boolean;
  /** The profile's name ("Apple TV 4K", "Venuebox app (Android TV 4K)"). */
  profileLabel: string;
  /** The TV's own maximum bitrate (Mbit/s) and height, before the cap and 4K settings. */
  maxMbps: number;
  maxHeight: number;
  capMbps: number | null;
  allow4k: boolean;
  /** Skip ±30 s and resume points work (not on a Roku, nor a Venuebox app that can't seek). */
  canSeek: boolean;
  /** Its player switches audio and subtitles itself (SDK 0.19.0): no new stream needed. */
  tracksNative: boolean;
  now: NowPlaying | null;
}

export interface ServerStatus {
  kind: "jellyfin";
  url: string | null;
  insecure: boolean;
  serverName?: string;
  version?: string;
  signedIn: boolean;
  userName?: string;
  /** The signed-in user is a server admin: warn (its key is in every link). */
  userIsAdmin?: boolean;
  /** SHA-256 fingerprint of the one self-signed certificate we trust, if any. */
  pinned?: string | null;
  problem?: string | null;
}

/** The certificate a server showed that isn't trusted: staff may pin it. */
export interface CertOffer {
  fingerprint: string;
  subject?: string;
  issuer?: string;
  validTo?: string;
  selfSigned: boolean;
  reason: string;
}

export interface TestResult {
  ok: boolean;
  serverName?: string;
  version?: string;
  product?: string;
  error?: string;
  cert?: CertOffer;
}

/** Why the TVs can't be played on, in words, or null when they can. */
export type VideoProblem = "standalone" | "box-too-old" | null;

/** When a guest vote closes: after some minutes, when the TV's movie ends, or when staff close it. */
export type VoteCloses = "time" | "movie-end" | "manual";

/** A movie staff typed in for the guest page ("Playing tonight"): no media server needed. */
export interface TonightEntry {
  id: string;
  title: string;
  /** When or where, as staff wrote it: "8:00 pm", "Patio TV after the game". */
  when?: string;
  /** It's on right now. */
  onNow: boolean;
}

export interface VoteOption {
  itemId: string;
  title: string;
  /** Typed in by staff, not from the media server: it can't start on a TV by itself. */
  manual?: boolean;
  year?: number;
  runtimeSec?: number;
  poster?: string;
}

/** The vote as guests see it. */
export interface VotePublic {
  open: boolean;
  options: (VoteOption & { votes: number })[];
  /** How many guests have voted. */
  total: number;
  /** The TV the winner plays on. */
  tvName?: string;
  closes?: VoteCloses;
  closesInSec?: number;
  /** The last round's winner, waiting to go on. */
  winner?: { title: string; votes: number; manual?: boolean };
  /** The option this guest voted for. */
  yourVote?: string;
}

export interface VoteStaff extends Omit<VotePublic, "yourVote"> {
  autoPlay: boolean;
  displayId?: string;
  winnerItemId?: string;
  winnerDisplayId?: string;
  /** Something staff should know ("Nobody voted"). */
  note?: string;
}

/** The guest page: what's on, and the vote. No links, no server details. */
export interface PublicState {
  name: string;
  playing: { tv: string; title: string; subtitle?: string; poster?: string; paused: boolean; progress?: number; endsInSec?: number }[];
  /** Typed in by staff. */
  tonight: TonightEntry[];
  vote: VotePublic | null;
}

export interface StaffState {
  name: string;
  ready: boolean;
  server: ServerStatus;
  tvs: TvInfo[];
  video: { problem: VideoProblem; fake: boolean };
  vote: VoteStaff;
  tonight: TonightEntry[];
}

export interface AdminState extends StaffState {
  settings: { name: string };
}
