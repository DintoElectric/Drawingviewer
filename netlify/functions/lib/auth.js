// lib/auth.js — shared server helpers for every function.
const { connectLambda, getStore } = require("@netlify/blobs");

const STORE = "drawings-hub";

function store(event) {
  connectLambda(event);
  return getStore(STORE);
}

function currentUser(context) {
  return (context && context.clientContext && context.clientContext.user) || null;
}

function isAdmin(user) {
  if (!user) return false;
  const adminEmail = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const email = (user.email || "").trim().toLowerCase();
  const byEmail = adminEmail && email && email === adminEmail;
  const roles = (user.app_metadata && user.app_metadata.roles) || [];
  return adminEmail ? byEmail : roles.includes("admin");
}

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

function fail(e) {
  return json(e.status || 500, { error: e.message || "Server error" });
}

// ---- safe keys -------------------------------------------------------
const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHEET_KEY_RE = /^[A-Z0-9][A-Z0-9.\-]{0,31}$/;
const UPLOAD_ID_RE = /^[a-z0-9]{8,64}$/;

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
function safeUploadId(id) {
  const s = String(id || "").toLowerCase();
  if (!UPLOAD_ID_RE.test(s)) throw httpError(400, "Bad upload id.");
  return s;
}
function safeIndex(i) {
  const n = parseInt(i, 10);
  if (!Number.isInteger(n) || n < 0 || n > 4095) throw httpError(400, "Bad chunk index.");
  return n;
}

const keys = {
  projectsIndex: () => "projects/index.json",
  manifest: (pid) => `projects/${safeProjectId(pid)}/manifest.json`,
  file: (pid, sheet, rev) => `projects/${safeProjectId(pid)}/files/${safeSheet(sheet)}_Rev${safeRev(rev)}.pdf`,
  archiveFile: (pid, sheet, rev) => `projects/${safeProjectId(pid)}/files/archive/${safeSheet(sheet)}_Rev${safeRev(rev)}.pdf`,
  tmpChunk: (pid, uploadId, i) => `projects/${safeProjectId(pid)}/tmp/${safeUploadId(uploadId)}/${safeIndex(i)}`,
};

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
  safeProjectId, safeSheet, safeRev, safeUploadId, safeIndex, slugify,
};
