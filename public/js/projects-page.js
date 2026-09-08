import { requireLogin, api } from "./auth.js";
import { mountTopbarUser, fmtDate, toast } from "./ui.js";

let isAdmin = false;

function renderProjects(projects) {
  const grid = document.getElementById("grid");
  const cards = projects.map((p) => `
    <a class="proj" href="./project.html?project=${encodeURIComponent(p.id)}">
      <div class="p-disc">${p.discipline || ""}</div>
      <div class="p-name">${p.name}</div>
      <div class="p-meta">Created ${fmtDate((p.createdAt || "").slice(0,10))}</div>
    </a>`).join("");

  const newCard = isAdmin
    ? `<div class="proj new" id="newProjectCard"><div><i class="ph ph-plus-circle"></i>New project</div></div>`
    : "";

  if (!projects.length && !isAdmin) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
      <i class="ph ph-folder-open"></i>
      <div class="es-title">No projects yet</div>
      <div class="es-sub">Once the admin creates a project and uploads drawings, they'll show up here.</div>
    </div>`;
    return;
  }
  grid.innerHTML = cards + newCard;
  document.getElementById("newProjectCard")?.addEventListener("click", openNewProject);
}

function openNewProject() { document.getElementById("newProjectDlg").classList.remove("hidden"); document.getElementById("npName").focus(); }
function closeNewProject() { document.getElementById("newProjectDlg").classList.add("hidden"); }

async function createProject() {
  const name = document.getElementById("npName").value.trim();
  const discipline = document.getElementById("npDiscipline").value;
  if (!name) { document.getElementById("npName").focus(); return; }
  const btn = document.getElementById("npCreate");
  btn.disabled = true;
  try {
    const { project } = await api("create-project", { method: "POST", body: { name, discipline } });
    location.href = `./project.html?project=${encodeURIComponent(project.id)}`;
  } catch (e) {
    toast("Couldn't create project", e.message, true);
    btn.disabled = false;
  }
}

async function main(user) {
  const { admin } = await mountTopbarUser();
  isAdmin = admin;
  document.getElementById("page").style.display = "";
  document.getElementById("sub").textContent = admin
    ? "Create a project, then upload drawings into it."
    : "Projects you have access to.";
  try {
    const { projects } = await api("list-projects");
    renderProjects(projects);
  } catch (e) {
    document.getElementById("grid").innerHTML = `<div class="empty-state" style="grid-column:1/-1"><i class="ph ph-warning-circle"></i><div class="es-title">Couldn't load projects</div><div class="es-sub">${e.message}</div></div>`;
  }

  document.getElementById("npClose").onclick = closeNewProject;
  document.getElementById("npCancel").onclick = closeNewProject;
  document.getElementById("npCreate").onclick = createProject;
}

requireLogin(main);
