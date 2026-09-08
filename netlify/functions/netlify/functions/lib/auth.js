// lib/auth.js — shared server helpers for every function.
//
// Auth model:
//   - Any request must carry a valid Netlify Identity JWT (Authorization: Bearer
//     <token>). Netlify verifies it and populates context.clientContext.user.
//     No user  -> 401. This is what makes "you must log in to view" real.
//   - Admin actions additionally require the caller's email to equal ADMIN_EMAIL
//     (set as a Netlify environment variable). Enforced here, server-side, so the
//     browser can never grant itself admin. This is the "sole admin" guarantee.
//
// Storage: one site-scoped Netlify Blobs store, "drawings-hub", persisted across
// deploys. connectLambda(event) wires the Blobs environment for classic handlers.

const { connectLambda, getStore } = require("@netlify/blobs");

const STORE = "drawings-hub";

function store(event) {
  connectLambda(event);
  return getStore({ name: STORE, consistency: "strong" });
}

// Pull the authenticated Identity user, or null.
function currentUser(context) {
  return (context && context.clientContext && context.clientContext.user) || null;
}

function isAdmin(user) {
  if (!user) return false;
  const adminEmail = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const email = (user.email || "").trim().toLowerCase();
  const byEmail = adminEmail && email && email === adminEmail;
  const roles = (user.app_metadata && user.app_metadata.roles) || [];
  const byRole = roles.includes("admin");
  // If ADMIN_EMAIL is set it is authoritative; otherwise fall back to the role.
  return adminEmail ? byEmail : byRole;
}

// Guards: return the user, or throw an {status,message} that the handler turns
// into an HTTP response.
function requireUser(context) {
  const user = currentUser(context);
  if (!user) throw httpError(401, "Sign in to continue.");
  return user;
}
function requireAdmin(context) {
  const user = requireUser(context);
  if (!isAdmin(user)) throw httpError(403, "Admin only.");
  return user;
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function json(status, obj) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(obj),
  };
}

// Turn a thrown error into a response (auth errors keep their status).
function fail(e) {
  return json(e.status || 500, { error: e.message || "Server error" });
}

// ---- safe keys -------------------------------------------------------
// Never build a storage key from a client-supplied path. Slugs are validated
// against a strict allowlist so a value like "../../x" can't escape.
const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHEET_KEY_RE = /^[A-Z0-9][A-Z0-9.\-]{0,31}$/; // matches normalizeSheet output

function safeProjectId(id) {
  const s = String(id || "").toLowerCase();
  if (!PROJECT_ID_RE.test(s)) throw httpError(400, "Bad project id.");
  return s;
}
function safeSheet(sheet) {
  const s = String(sheet || "").toUpperCase();
  if (!SHEET_KEY_RE.test(s)) throw httpError(400, `Bad sheet number: ${sheet}`);
  return s;
}
function safeRev(rev) {
  const n = parseInt(rev, 10);
  if (!Number.isInteger(n) || n < 1 || n > 999) throw httpError(400, "Bad revision.");
  return n;
}

// Blob key layout.
const keys = {
  projectsIndex: () => "projects/index.json",
  manifest: (pid) => `projects/${safeProjectId(pid)}/manifest.json`,
  file: (pid, sheet, rev) => `projects/${safeProjectId(pid)}/files/${safeSheet(sheet)}_Rev${safeRev(rev)}.pdf`,
  archiveFile: (pid, sheet, rev) => `projects/${safeProjectId(pid)}/files/archive/${safeSheet(sheet)}_Rev${safeRev(rev)}.pdf`,
};

// Convenience readers/writers for JSON blobs (return fallback if missing).
async function readJSON(st, key, fallback) {
  const v = await st.get(key, { type: "json" });
  return v == null ? fallback : v;
}
async function writeJSON(st, key, obj) {
  await st.setJSON(key, obj);
}

function slugify(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "project";
}

module.exports = {
  store, currentUser, isAdmin, requireUser, requireAdmin,
  httpError, json, fail, keys, readJSON, writeJSON,
  safeProjectId, safeSheet, safeRev, slugify,
};
