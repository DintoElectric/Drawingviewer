// GET /get-manifest?project=<id> — any signed-in user. Returns the project's
// manifest (empty drawings map if nothing uploaded yet).
const { store, requireUser, readJSON, keys, safeProjectId, json, fail, httpError } = require("./lib/auth");
exports.handler = async (event, context) => {
  try {
    requireUser(context);
    const pid = safeProjectId((event.queryStringParameters || {}).project);
    const st = store(event);
    const manifest = await readJSON(st, keys.manifest(pid), null);
    if (!manifest) throw httpError(404, "Project not found.");
    return json(200, manifest);
  } catch (e) { return fail(e); }
};
