// Everything this app keeps, as JSON files in DATA_DIR (the kit's atomic JSON store). The
// server address, its certificate pin and the sign-in live here and nowhere else: never in
// the repo, the image, bargames.json or the environment.
//   settings.json  name, the server address, the pinned certificate, per-TV settings
//   secrets.json   the media server's access token (never the password), our device id,
//                  the poster-link key (0600)

import { chmod } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { createJsonStore, type JsonStore } from "@bargames/gamekit/server";
import { isProfileId, type TonightEntry, type TvProfileId } from "@movies/shared";

export interface TvSettings {
  /** Set by staff; absent: chosen from what the box says the TV is. */
  profile?: TvProfileId;
  capMbps: number | null;
  allow4k: boolean;
}

export const DEFAULT_TV: TvSettings = { capMbps: null, allow4k: true };

export interface Settings {
  name: string;
  source: "jellyfin";
  /** Normalised (shared/url.ts). null until staff type one. */
  serverUrl: string | null;
  /** SHA-256 fingerprint of the one self-signed certificate staff chose to trust. */
  pin: string | null;
  /** Last seen in a test: shown on the pages. */
  serverName: string;
  serverVersion: string;
  tvs: Record<string, TvSettings>;
  /** "Playing tonight", typed by staff for the guest page. */
  tonight: TonightEntry[];
}

export interface Secrets {
  deviceId: string;
  posterKey: string;
  jellyfin: {
    token: string;
    userId: string;
    userName: string;
    isAdmin: boolean;
    /** The server's own id: the sign-in survives an address change to the same server. */
    serverId: string;
  } | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export class Store {
  readonly json: JsonStore;
  settings: Settings = { name: "", source: "jellyfin", serverUrl: null, pin: null, serverName: "", serverVersion: "", tvs: {}, tonight: [] };
  secrets: Secrets = { deviceId: "", posterKey: "", jellyfin: null };

  constructor(readonly dir: string) {
    this.json = createJsonStore(dir);
  }

  async init(): Promise<void> {
    const s = await this.json.read<Settings>("settings.json", isObj as unknown as (v: unknown) => v is Settings);
    if (s) {
      this.settings = { ...this.settings, ...s, tvs: isObj(s.tvs) ? (s.tvs as Settings["tvs"]) : {}, tonight: Array.isArray(s.tonight) ? s.tonight.filter((e) => isObj(e) && typeof e.id === "string" && typeof e.title === "string") : [] };
      for (const t of Object.values(this.settings.tvs)) if (t.profile && !isProfileId(t.profile)) delete t.profile;
    }
    const sec = await this.json.read<Secrets>("secrets.json", isObj as unknown as (v: unknown) => v is Secrets);
    if (sec) this.secrets = { ...this.secrets, ...sec };
    let changed = false;
    if (!this.secrets.deviceId) (this.secrets.deviceId = `venuebox-movies-${randomUUID()}`), (changed = true);
    if (!this.secrets.posterKey) (this.secrets.posterKey = randomBytes(32).toString("hex")), (changed = true);
    if (changed) await this.saveSecrets();
  }

  tv(displayId: string): TvSettings {
    return { ...DEFAULT_TV, ...this.settings.tvs[displayId] };
  }

  saveSettings = () => this.json.write("settings.json", this.settings);

  async saveSecrets(): Promise<void> {
    await this.json.write("secrets.json", this.secrets);
    await chmod(this.json.file("secrets.json"), 0o600).catch(() => undefined);
  }
}
