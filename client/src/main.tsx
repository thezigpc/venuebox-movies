import React from "react";
import ReactDOM from "react-dom/client";
import { basePath, ErrorBoundary, OnScreenKeyboard } from "@bargames/gamekit/client";
import { StaffPage } from "./pages/StaffPage";
import { AdminPage } from "./pages/AdminPage";
import "./index.css";

// Two pages (bargames.json routes: host "/" the staff picker for the iPad, admin "/admin").
// No guest page and no TV page: the TVs play the stream in their own players.
const prefix = basePath();
const here = prefix && location.pathname.startsWith(prefix) ? location.pathname.slice(prefix.length) : location.pathname;
const path = here.replace(/\/+$/, "") || "/";
const Page = path === "/admin" ? AdminPage : StaffPage;

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
