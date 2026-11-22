import React from "react";
import ReactDOM from "react-dom/client";
import { basePath, ErrorBoundary, OnScreenKeyboard } from "@bargames/gamekit/client";
import { StaffPage } from "./pages/StaffPage";
import { AdminPage } from "./pages/AdminPage";
import { GuestPage } from "./pages/GuestPage";
import "./index.css";
import "./app.css";

// Three pages (bargames.json routes): player "/" the guest page (what's on, the vote), host
// "/staff" the staff picker and remote, admin "/admin" the settings. No TV page: the TVs play
// the stream in their own players.
const prefix = basePath();
const here = prefix && location.pathname.startsWith(prefix) ? location.pathname.slice(prefix.length) : location.pathname;
const path = here.replace(/\/+$/, "") || "/";
const Page = path === "/admin" ? AdminPage : path === "/staff" ? StaffPage : GuestPage;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary
      fallback={(_error, reload) => (
        <div className="center-page">
          <h1>Something broke</h1>
          <p className="muted">Reloading usually fixes it.</p>
          <button className="primary" onClick={reload}>
            Reload
          </button>
        </div>
      )}
    >
      <Page />
    </ErrorBoundary>
    <OnScreenKeyboard />
  </React.StrictMode>,
);
