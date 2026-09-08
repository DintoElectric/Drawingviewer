// POST /update-drawing { project, sheet, title } — ADMIN ONLY.
// Edits a sheet's display name (title) in the manifest.
const { store, requireAdmin, readJSON, writeJSON, keys, safeProjectId, safeSheet, json, fail, httpError } = require("./lib/auth");
exports.handler = async (event, context) => {
  try {
    requireAdmin(context);
    if (event.httpMethod !== "POST") throw httpError(405, "POST only.");
    const b = JSON.parse(event.body || "{}");
    const pid = safeProjectId(b.project);
    const sheet = safeSheet(b.sheet);
    const st = store(event);
    const manifest = await readJSON(st, keys.manifest(pid), null);
    if (!manifest || !manifest.drawings || !manifest.drawings[sheet]) throw httpError(404, "Sheet not found.");
    const title = String(b.title == null ? manifest.drawings[sheet].title || "" : b.title).slice(0, 140).trim();
    manifest.drawings[sheet].title = title;
    manifest.project = manifest.project || {};
    manifest.project.syncedAt = new Date().toISOString();
    await writeJSON(st, keys.manifest(pid), manifest);
    return json(200, { ok: true, sheet, title });
  } catch (e) { return fail(e); }
};
