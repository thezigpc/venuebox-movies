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

export interface ItemDetail extends Card {
  overview?: string;
  runtimeSec?: number;
  /** Where the server's resume point is (part-watched), seconds. */
  resumeSec?: number;
  file?: FileDetails;
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
  capMbps: number | null;
  allow4k: boolean;
  /** Skip ±30 s and resume points work (not on a Roku). */
  canSeek: boolean;
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

export interface StaffState {
  name: string;
  ready: boolean;
  server: ServerStatus;
  tvs: TvInfo[];
  video: { problem: VideoProblem; fake: boolean };
}

export interface AdminState extends StaffState {
  settings: { name: string };
}
