// GET /list-projects — any signed-in user sees the project list.
const { store, requireUser, readJSON, keys, json, fail } = require("./lib/auth");
exports.handler = async (event, context) => {
  try {
    requireUser(context);
    const st = store(event);
    const idx = await readJSON(st, keys.projectsIndex(), { projects: [] });
    // newest first
    idx.projects.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    return json(200, idx);
  } catch (e) { return fail(e); }
};
