// POST /publish-revisions — ADMIN ONLY. Each file references an uploadId + chunk
// count (previously sent to /upload-chunk). This reads the chunks from Blobs,
// concatenates them into the finished PDF, archives any superseded rev, writes
// the new file, updates the manifest, and clears the temp chunks.
const { store, requireAdmin, readJSON, writeJSON, keys, safeProjectId, safeSheet, safeRev, safeUploadId, json, fail, httpError } = require("./lib/auth");
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
    const publishable = files.filter((f) => f && f.sheet && f.uploadId && f.chunks && f.status !== "new-manual");
    if (!publishable.length) throw httpError(400, "Nothing to publish (each file needs a resolved sheet).");

    const issueDate = (body.issueDate || new Date().toISOString().slice(0, 10)).slice(0, 10);
    const reason = (body.reason || "Revised").slice(0, 120);
    const note = body.note ? String(body.note).slice(0, 300) : null;
    const summary = [];

    for (const f of publishable) {
      const sheet = safeSheet(f.sheet);
      const uploadId = safeUploadId(f.uploadId);
      const chunks = parseInt(f.chunks, 10);
      if (!Number.isInteger(chunks) || chunks < 1 || chunks > 4096) throw httpError(400, "Bad chunk count.");

      // reassemble the file from its temp chunks
      const parts = [];
      for (let i = 0; i < chunks; i++) {
        const part = await st.get(keys.tmpChunk(pid, uploadId, i), { type: "arrayBuffer" });
        if (!part) throw httpError(400, `Missing chunk ${i} for ${sheet} — re-upload this file.`);
        parts.push(Buffer.from(part));
      }
      const bytes = Buffer.concat(parts);

      const entry = manifest.drawings[sheet] || { title: f.title || sheet, history: [] };
      const cur = entry.currentRev || 0;
      let newRev = parseInt(f.newRev, 10);
      if (!Number.isInteger(newRev) || newRev <= cur) newRev = cur + 1;
      newRev = safeRev(newRev);

      if (cur > 0 && entry.currentRev) {
        const oldBuf = await st.get(keys.file(pid, sheet, entry.currentRev), { type: "arrayBuffer" }).catch(() => null);
        if (oldBuf) {
          await st.set(keys.archiveFile(pid, sheet, entry.currentRev), Buffer.from(oldBuf));
          await st.delete(keys.file(pid, sheet, entry.currentRev));
          const prev = (entry.history || []).find((h) => h.rev === entry.currentRev);
          if (prev) prev.archived = true;
        }
      }

      await st.set(keys.file(pid, sheet, newRev), bytes);

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

      // clear temp chunks
      for (let i = 0; i < chunks; i++) { await st.delete(keys.tmpChunk(pid, uploadId, i)).catch(() => {}); }
    }

    manifest.project = manifest.project || {};
    manifest.project.syncedAt = new Date().toISOString();
    await writeJSON(st, keys.manifest(pid), manifest);
    return json(200, { ok: true, published: summary });
  } catch (e) { return fail(e); }
};
