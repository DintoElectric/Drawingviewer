// GET /get-drawing?project=&sheet=&rev=&archive=0|1  [ &meta=1 | &chunk=i ]
// Any signed-in user. Large sheets can't fit one function response (~6MB cap),
// so the file is served in pieces: ?meta=1 returns {size,chunks}, and ?chunk=i
// returns that slice as raw bytes. The viewer stitches them into one Blob.
const { store, requireUser, keys, safeProjectId, safeSheet, safeRev, safeIndex, json, fail, httpError } = require("./lib/auth");
const DL_CHUNK = 3 * 1024 * 1024;
exports.handler = async (event, context) => {
  try {
    requireUser(context);
    const q = event.queryStringParameters || {};
    const pid = safeProjectId(q.project);
    const sheet = safeSheet(q.sheet);
    const rev = safeRev(q.rev);
    const key = q.archive === "1" ? keys.archiveFile(pid, sheet, rev) : keys.file(pid, sheet, rev);
    const st = store(event);
    const buf = await st.get(key, { type: "arrayBuffer" });
    if (!buf) throw httpError(404, "Drawing not found.");
    const bytes = Buffer.from(buf);
    const chunks = Math.max(1, Math.ceil(bytes.length / DL_CHUNK));
    if (q.meta === "1") return json(200, { size: bytes.length, chunks });
    const i = safeIndex(q.chunk == null ? 0 : q.chunk);
    if (i >= chunks) throw httpError(416, "Chunk out of range.");
    const slice = bytes.subarray(i * DL_CHUNK, (i + 1) * DL_CHUNK);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/octet-stream", "Cache-Control": "private, max-age=3600" },
      body: Buffer.from(slice).toString("base64"),
      isBase64Encoded: true,
    };
  } catch (e) { return fail(e); }
};
