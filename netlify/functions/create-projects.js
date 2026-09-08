// POST /create-project { name, discipline } — admin only. Creates the project in
// the index and initialises an EMPTY manifest (no drawings until you upload).
const { store, requireAdmin, readJSON, writeJSON, keys, slugify, json, fail, httpError } = require("./lib/auth");

exports.handler = async (event, context) => {
  try {
    requireAdmin(context);
    if (event.httpMethod !== "POST") throw httpError(405, "POST only.");
    const body = JSON.parse(event.body || "{}");
    const name = (body.name || "").trim();
    if (!name) throw httpError(400, "Project name is required.");
    const discipline = (body.discipline || "Electrical").trim();

    const st = store(event);
    const idx = await readJSON(st, keys.projectsIndex(), { projects: [] });

    // unique id from the name
    let base = slugify(name), id = base, n = 2;
    const taken = new Set(idx.projects.map((p) => p.id));
    while (taken.has(id)) id = `${base}-${n++}`;

    const now = new Date().toISOString();
    const project = { id, name, discipline, createdAt: now };
    idx.projects.push(project);
    await writeJSON(st, keys.projectsIndex(), idx);

    // empty manifest — drawings map starts blank on purpose
    await writeJSON(st, keys.manifest(id), {
      project: { id, name, discipline, syncedAt: now },
      drawings: {},
    });

    return json(200, { ok: true, project });
  } catch (e) { return fail(e); }
};
