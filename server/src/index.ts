import { createServer } from "node:http";
import { DEFAULT_NAME } from "@movies/shared";
import { createApp } from "./app.js";
import { makeBarGames } from "./bargames.js";
import { ADMIN_PASSWORD, CLIENT_DIST_PATH, DATA_DIR, FAKE_TVS, GAME_NAME, PORT } from "./config.js";
import { log } from "./log.js";

// The access token and certificate pin live in DATA_DIR: nothing written here is for others.
process.umask(0o077);

const bg = makeBarGames({ defaultName: GAME_NAME || DEFAULT_NAME });
const movies = await createApp({ dataDir: DATA_DIR, bg, adminPassword: ADMIN_PASSWORD, gameName: GAME_NAME, clientDist: CLIENT_DIST_PATH, fakeTvs: FAKE_TVS });

const server = createServer(movies.app);
server.listen(PORT, () => log.info("boot", "listening", { port: PORT, dataDir: DATA_DIR, box: bg.connected, fakeTvs: FAKE_TVS || undefined, video: movies.video.problem() ?? "ready" }));

let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info("boot", "shutting down", { signal });
  setTimeout(() => process.exit(0), 3000).unref();
  void movies
    .close()
    .catch(() => undefined)
    .then(() => bg.flush())
    .finally(() => server.close(() => process.exit(0)));
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
