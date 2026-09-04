// publish-revisions.js — the secure half of the in-app upload flow.
//
// The browser sends confirmed revisions (each with the PDF as base64 and the
// supersede plan produced by extract-core). This function commits them to the
// repo in ONE atomic commit using GitHub's Git Data API: it archives every
// superseded file, writes the new canonically-named files, and rewrites
// manifest.json — then Netlify redeploys from that commit.
//
// The GitHub token lives only here, as a Netlify environment variable, so it
// never reaches the field tablet.
//
// Required env vars (Site settings → Environment variables):
//   GH_TOKEN   fine-grained PAT (or App token) with Contents: read+write on the repo
//   GH_REPO    "owner/name"
//   GH_BRANCH  branch to commit to (default "main")
//   PUBLISH_KEY (optional) shared secret; if set, requests must send it as
//               the x-publish-key header. Add a light gate before going public.

const API = "https://api.github.com";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  const token = process.env.GH_TOKEN;
  const repo = process.env.GH_REPO;
  const branch = process.env.GH_BRANCH || "main";
  if (!token || !repo) return json(500, { error: "Server not configured: set GH_TOKEN and GH_REPO." });

  if (process.env.PUBLISH_KEY && event.headers["x-publish-key"] !== process.env.PUBLISH_KEY)
    return json(401, { error: "Bad publish key" });

  let body;
  try { body = JSON.parse(event.body); } catch { return json(400, { error: "Bad JSON" }); }
  const files = (body.files || []).filter((f) => f.base64 && f.canonicalFile && f.status !== "new-manual");
  if (!files.length) return json(400, { error: "No publishable files (each needs a resolved sheet)." });

  const gh = ghClient(token, repo);
  const root = "public/"; // the site is published from /public

  try {
    // 1. current branch tip + tree
    const ref = await gh(`/git/ref/heads/${branch}`);
    const baseSha = ref.object.sha;
    const baseCommit = await gh(`/git/commits/${baseSha}`);
    const baseTreeSha = baseCommit.tree.sha;

    // 2. load + mutate the manifest
    const manifestPath = `${root}manifest.json`;
    const manifestFile = await gh(`/contents/${encodeURIComponent(manifestPath)}?ref=${branch}`);
    const manifest = JSON.parse(Buffer.from(manifestFile.content, "base64").toString("utf8"));
    manifest.drawings = manifest.drawings || {};

    const treeItems = [];
    const summary = [];

    for (const f of files) {
      const sheet = f.sheet;
      const entry = manifest.drawings[sheet] || { title: f.title || sheet, history: [] };

      // archive the file this rev supersedes (move it under drawings/archive/)
      if (f.status === "supersede" && f.archiveOldTo && entry.currentFile) {
        const oldRel = root + entry.currentFile;
        const archRel = root + f.archiveOldTo;
        const old = await gh(`/contents/${encodeURIComponent(oldRel)}?ref=${branch}`).catch(() => null);
        if (old) {
          treeItems.push({ path: archRel, mode: "100644", type: "blob", content: undefined, sha: old.sha });
          treeItems.push({ path: oldRel, mode: "100644", type: "blob", sha: null }); // delete old current
          // keep the archived path in that rev's history entry
          const prev = (entry.history || []).find((h) => h.rev === entry.currentRev);
          if (prev) prev.file = f.archiveOldTo;
        }
      }

      // write the new file (base64 → blob)
      const blob = await gh(`/git/blobs`, "POST", { content: f.base64, encoding: "base64" });
      treeItems.push({ path: root + f.canonicalFile, mode: "100644", type: "blob", sha: blob.sha });

      // update manifest entry
      entry.title = f.title || entry.title || sheet;
      entry.currentRev = f.newRev;
      entry.currentFile = f.canonicalFile;
      entry.issuedDate = body.issueDate || new Date().toISOString().slice(0, 10);
      entry.status = "issued";
      entry.note = body.note || null;
      entry.history = entry.history || [];
      entry.history = entry.history.filter((h) => h.rev !== f.newRev);
      entry.history.push({ rev: f.newRev, date: entry.issuedDate, reason: body.reason || "Revised", file: f.canonicalFile });
      manifest.drawings[sheet] = entry;
      summary.push(`${sheet} → Rev ${f.newRev}`);
    }

    manifest.project = manifest.project || {};
    manifest.project.syncedAt = new Date().toISOString();

    // manifest blob
    treeItems.push({ path: manifestPath, mode: "100644", type: "blob",
      content: JSON.stringify(manifest, null, 2) });

    // 3. tree → commit → move the branch
    const tree = await gh(`/git/trees`, "POST", { base_tree: baseTreeSha, tree: normalizeTree(treeItems) });
    const message = `Publish ${files.length} revision${files.length > 1 ? "s" : ""}: ${summary.join(", ")}`;
    const commit = await gh(`/git/commits`, "POST", { message, tree: tree.sha, parents: [baseSha] });
    await gh(`/git/refs/heads/${branch}`, "PATCH", { sha: commit.sha });

    return json(200, { ok: true, commit: commit.sha, published: summary });
  } catch (e) {
    return json(502, { error: `GitHub commit failed: ${e.message}` });
  }
};

// GitHub blob-delete needs the entry omitted with sha:null in a tree; normalize.
function normalizeTree(entries) {
  return entries.map((e) => {
    if (e.sha === null) return { path: e.path, mode: e.mode, type: e.type, sha: null };
    if (e.content !== undefined && e.sha === undefined) return { path: e.path, mode: e.mode, type: e.type, content: e.content };
    return { path: e.path, mode: e.mode, type: e.type, sha: e.sha };
  });
}

function ghClient(token, repo) {
  return async (path, method = "GET", payload) => {
    const res = await fetch(`${API}/repos/${repo}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "drawings-hub",
        ...(payload ? { "Content-Type": "application/json" } : {}),
      },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.status === 204 ? {} : res.json();
  };
}

function json(status, obj) {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
