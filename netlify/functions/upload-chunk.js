// POST /upload-chunk { project, uploadId, index, total, dataB64 } — ADMIN ONLY.
// Stores one piece of a file in Blobs under a temp key. The pieces are small
// enough to fit a function request; publish-revisions stitches them together.
const { store, requireAdmin, keys, safeProjectId, safeUploadId, safeIndex, json, fail, httpError } = require("./lib/auth");
exports.handler = async (event, context) => {
  try {
    requireAdmin(context);
    if (event.httpMethod !== "POST") throw httpError(405, "POST only.");
    const b = JSON.parse(event.body || "{}");
    const pid = safeProjectId(b.project);
    const uploadId = safeUploadId(b.uploadId);
    const index = safeIndex(b.index);
    if (!b.dataB64) throw httpError(400, "Empty chunk.");
    const bytes = Buffer.from(b.dataB64, "base64");
    const st = store(event);
    await st.set(keys.tmpChunk(pid, uploadId, index), bytes);
    return json(200, { ok: true, index, bytes: bytes.length });
  } catch (e) { return fail(e); }
};
