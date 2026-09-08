// GET /get-drawing?project=<id>&sheet=<SHEET>&rev=<N>&archive=0|1
// Any signed-in user. Streams the PDF bytes back from Blobs — there are no public
// blob URLs, so this function is the only way to read a drawing, which is what
// keeps drawings behind the login.
//
// Note: classic functions return the body base64-encoded, so very large sheets
// (> ~5-6 MB) can exceed the response limit. Typical single-sheet electrical PDFs
// are well under that. If you routinely handle very large scans, see SETUP.md for
// the external-bucket upgrade path.
const { store, requireUser, keys, safeProjectId, safeSheet, safeRev, fail, httpError } = require("./lib/auth");

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
    const MAX = 5.5 * 1024 * 1024;
    if (bytes.length > MAX) throw httpError(413, "This sheet is too large to stream through the viewer. See SETUP.md.");

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${sheet}_Rev${rev}.pdf"`,
        "Cache-Control": "private, max-age=3600",
      },
      body: bytes.toString("base64"),
      isBase64Encoded: true,
    };
  } catch (e) { return fail(e); }
};
