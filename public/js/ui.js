// ui.js — small shared helpers used across pages.
import { currentUser, logout, api } from "./auth.js";

export function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso + (iso && iso.length === 10 ? "T00:00:00" : ""));
  return isNaN(d) ? iso : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
export function relTime(iso) {
  if (!iso) return "";
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 24 ? `${hrs} hr ago` : fmtDate(iso.slice(0, 10));
}

// Fill a #topbarUser slot with the signed-in email + a sign-out control, and
// return { admin } once whoami resolves.
export async function mountTopbarUser() {
  const slot = document.querySelector("#topbarUser");
  const u = currentUser();
  let admin = false;
  try { admin = (await api("whoami")).admin; } catch {}
  if (slot) {
    const email = u?.email || "";
    const initials = (email.split("@")[0].slice(0, 2) || "?").toUpperCase();
    slot.innerHTML = `
      ${admin ? `<span class="tag tag-outline" style="font-size:10px;padding:2px 8px">Admin</span>` : ""}
      <div class="avatar" title="${email}">${initials}</div>
      <button class="btn btn-secondary" id="signOut" style="min-height:34px"><i class="ph ph-sign-out"></i>Sign out</button>`;
    document.getElementById("signOut").onclick = logout;
  }
  return { admin };
}

export function toast(title, body, isErr = false) {
  const t = document.createElement("div");
  t.className = "toast" + (isErr ? " err" : "");
  t.innerHTML = `<i class="${isErr ? "ph ph-warning-circle" : "ph-fill ph-check-circle"}" style="font-size:20px;color:${isErr ? "var(--color-neutral-300)" : "var(--color-accent-400)"}"></i>
    <div><div class="t-title">${title}</div><div class="t-body">${body}</div></div>`;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 5500);
}
