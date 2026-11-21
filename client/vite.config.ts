import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: the client runs on :5187 and talks to the server on :3017.
export default defineConfig({
  // Relative asset URLs: the app may be served under a path (venue.example.com/movies/).
  base: "./",
  plugins: [react()],
  server: {
    host: true,
    port: 5187,
    proxy: {
      "/api": "http://localhost:3017",
      "/__bargames": "http://localhost:3017",
    },
  },
});
