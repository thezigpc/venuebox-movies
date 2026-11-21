// Staff sign-in, shared by both pages. Box staff go straight in (staffSignIn); otherwise the
// box's admin password (on a box) or this app's own.

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { basePath, staffSignIn } from "@bargames/gamekit/client";
import { api, ApiError, getToken, setToken, type AuthStatus } from "../api";

type Phase = { kind: "loading" } | { kind: "auth"; status: AuthStatus } | { kind: "ready" } | { kind: "offline"; message: string };

export function useStaffAuth() {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const check = useCallback(async () => {
    try {
      const status = await api.status();
      if (status.authenticated && getToken()) return void setPhase({ kind: "ready" });
      const staffToken = await staffSignIn(basePath());
      if (staffToken) {
        setToken(staffToken);
        return void setPhase({ kind: "ready" });
      }
      setToken("");
      setPhase({ kind: "auth", status });
    } catch (err) {
      setPhase({ kind: "offline", message: err instanceof Error ? err.message : "Can't reach the app." });
    }
  }, []);
  useEffect(() => void check(), [check]);
  const signOut = async () => {
    await api.logout().catch(() => undefined);
    setToken("");
    void check();
  };
  return { phase, check, signOut };
}

export function AuthGate({ title, phase, check, children }: { title: string; phase: Phase; check: () => Promise<void>; children: ReactNode }) {
  if (phase.kind === "loading") return <p className="muted center-page">Loading…</p>;
  if (phase.kind === "offline")
    return (
      <div className="auth card">
        <h1>{title}</h1>
        <p className="error">{phase.message}</p>
        <button onClick={() => void check()}>Try again</button>
      </div>
    );
  if (phase.kind === "auth") return <AuthForm title={title} status={phase.status} onDone={() => void check()} />;
  return <>{children}</>;
}

function AuthForm({ title, status, onDone }: { title: string; status: AuthStatus; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [wantSetup, setWantSetup] = useState(false);
  const setup = status.venueLogin ? wantSetup && status.setupAllowed : status.setupNeeded;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (setup && password !== confirm) return setError("The passwords don't match.");
    setBusy(true);
    try {
      const r = setup ? await api.setup(password) : await api.login(password);
      setToken(r.token);
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && status.venueLogin) setError("That isn't the venue box's admin password.");
      else setError(err instanceof Error ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  };

  if (status.broken && !status.venueLogin)
    return (
      <div className="auth card">
        <h1>{title}</h1>
        <p className="error">The admin password file on the server is damaged. Ask whoever runs the server to fix or delete admin.json in the data folder.</p>
      </div>
    );
  return (
    <form className="auth card" onSubmit={submit}>
      <h1>{title}</h1>
      <p className="muted">
        {setup
          ? status.venueLogin
            ? `Choose a separate password for this app (the box's admin password keeps working too). At least ${status.minPasswordLength} characters.`
            : `Choose the staff password. Whoever sets it first becomes the admin, so do this now. At least ${status.minPasswordLength} characters.`
          : status.venueLogin
            ? `Staff only. Sign in with the venue box's admin password${status.configured ? " (or this app's own password)" : ""}.`
            : "Staff only. Sign in to pick movies for the TVs."}
      </p>
      <label>
        Password
        <input type="password" autoComplete={setup ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} maxLength={200} autoCapitalize="none" autoFocus required />
      </label>
      {setup && (
        <label>
          Password again
          <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} maxLength={200} autoCapitalize="none" required />
        </label>
      )}
      {error && <p className="error">{error}</p>}
      <button className="primary" disabled={busy || !password}>
        {setup ? "Set password" : "Sign in"}
      </button>
      {status.venueLogin && status.setupAllowed && (
        <button type="button" className="link" onClick={() => (setWantSetup((x) => !x), setError(""))}>
          {wantSetup ? "Sign in with the box's password instead" : "Set a separate password for this app"}
        </button>
      )}
    </form>
  );
}
