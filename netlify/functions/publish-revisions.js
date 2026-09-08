// POST /publish-revisions — ADMIN ONLY. The server half of the upload flow.
//
// The browser reads each PDF's title block (extract-core.js), shows the match,
// and sends the confirmed revisions here with the PDF as base64. This function:
//   - re-validates the sheet number server-side and builds the storage key
//     itself (never trusts a client-supplied path — closes path traversal),
//   - archives the file each rev supersedes,
//   - writes the new file,
//   - updates the project manifest.
//
// Storage is Netlify Blobs, so there's no git commit and no rebuild — the change
// is live on the next read.
const {
  store, requireAdmin, readJSON, writeJSON, keys,
  safeProjectId, safeSheet, safeRev, json, fail, httpError,
} = require("./lib/auth");

const SHEET_OK = /^[A-Z0-9][A-Z0-9.\-]{0,31}$/;

exports.handler = async (event, context) => {
  try {
    requireAdmin(context);
    if (event.httpMethod !== "POST") throw httpError(405, "POST only.");
    const body = JSON.parse(event.body || "{}");
    const pid = safeProjectId(body.project);
    const st = store(event);

    const manifest = await readJSON(st, keys.manifest(pid), null);
    if (!manifest) throw httpError(404, "Project not found.");
    manifest.drawings = manifest.drawings || {};

    const files = Array.isArray(body.files) ? body.files : [];
    const publishable = files.filter((f) => f && f.base64 && f.sheet && f.status !== "new-manual");
    if (!publishable.length) throw httpError(400, "Nothing to publish (each file needs a resolved sheet).");

    const issueDate = (body.issueDate || new Date().toISOString().slice(0, 10)).slice(0, 10);
    const reason = (body.reason || "Revised").slice(0, 120);
    const note = body.note ? String(body.note).slice(0, 300) : null;
    const summary = [];

    for (const f of publishable) {
      const sheet = safeSheet(f.sheet);          // server re-validates
      if (!SHEET_OK.test(sheet)) throw httpError(400, `Bad sheet: ${f.sheet}`);
      const entry = manifest.drawings[sheet] || { title: f.title || sheet, history: [] };
      const cur = entry.currentRev || 0;

      // decide the new rev the same way extract-core does: printed rev if it
      // advances, else increment. The client sends its computed newRev; trust it
      // only if it advances past current, otherwise recompute.
      let newRev = parseInt(f.newRev, 10);
      if (!Number.isInteger(newRev) || newRev <= cur) newRev = cur + 1;
      newRev = safeRev(newRev);

      // archive the superseded current file (copy to archive, delete current)
      if (cur > 0 && entry.currentRev) {
        const oldBuf = await st.get(keys.file(pid, sheet, entry.currentRev), { type: "arrayBuffer" }).catch(() => null);
        if (oldBuf) {
          await st.set(keys.archiveFile(pid, sheet, entry.currentRev), Buffer.from(oldBuf));
          await st.delete(keys.file(pid, sheet, entry.currentRev));
          const prev = (entry.history || []).find((h) => h.rev === entry.currentRev);
          if (prev) prev.archived = true;
        }
      }

      // write the new file from base64
      const bytes = Buffer.from(f.base64, "base64");
      await st.set(keys.file(pid, sheet, newRev), bytes);

      // update manifest entry
      entry.title = f.title || entry.title || sheet;
      entry.currentRev = newRev;
      entry.currentFile = `files/${sheet}_Rev${newRev}.pdf`;
      entry.issuedDate = issueDate;
      entry.status = "issued";
      entry.note = note;
      entry.history = (entry.history || []).filter((h) => h.rev !== newRev);
      entry.history.push({ rev: newRev, date: issueDate, reason, archived: false });
      entry.history.sort((a, b) => a.rev - b.rev);
      manifest.drawings[sheet] = entry;
      summary.push(`${sheet} → Rev ${newRev}`);
    }

    manifest.project = manifest.project || {};
    manifest.project.syncedAt = new Date().toISOString();
    await writeJSON(st, keys.manifest(pid), manifest);

    return json(200, { ok: true, published: summary });
  } catch (e) { return fail(e); }
};
