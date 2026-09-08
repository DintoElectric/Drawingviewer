// auth.js — front-end side of Netlify Identity. Loads the widget, gates the page
// behind a login, and hands out token-attached fetches to the functions.
// Requires the Identity widget script in the page:
//   <script src="https://identity.netlify.com/v1/netlify-identity-widget.js"></script>

const identity = window.netlifyIdentity;

let readyResolve;
const ready = new Promise((r) => (readyResolve = r));

identity.on("init", (user) => readyResolve(user));
identity.on("login", () => { identity.close(); location.reload(); });
identity.on("logout", () => location.reload());
identity.init();

export function currentUser() { return identity.currentUser(); }

export async function getToken() {
  const u = identity.currentUser();
  return u ? await u.jwt() : null;
}

export function login() { identity.open("login"); }
export function signup() { identity.open("signup"); }
export function logout() { identity.logout(); }

// Block the page until someone is signed in. Shows a full-page gate with
// Sign in / Create account, and only calls `then` once we have a user.
export async function requireLogin(then) {
  await ready;
  const user = identity.currentUser();
  if (user) { hideGate(); then(user); return; }
  showGate();
}

function showGate() {
  if (document.getElementById("authGate")) return;
  const gate = document.createElement("div");
  gate.id = "authGate";
  gate.className = "gate";
  gate.innerHTML = `
    <div class="gate-card">
      <div class="gate-mark">D</div>
      <div class="gate-title">Drawings Hub</div>
      <div class="gate-sub">Sign in to view your projects and drawings.</div>
      <div class="gate-actions">
        <button class="btn btn-primary" id="gateLogin" style="min-height:40px"><i class="ph ph-sign-in"></i>Sign in</button>
        <button class="btn btn-secondary" id="gateSignup" style="min-height:40px"><i class="ph ph-user-plus"></i>Create account</button>
      </div>
    </div>`;
  document.body.appendChild(gate);
  document.getElementById("gateLogin").onclick = login;
  document.getElementById("gateSignup").onclick = signup;
}
function hideGate() { document.getElementById("authGate")?.remove(); }

// fetch a function with the Identity token attached.
export async function api(path, { method = "GET", body } = {}) {
  const token = await getToken();
  const res = await fetch(`/.netlify/functions/${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { login(); throw new Error("Please sign in."); }
  if (!res.ok) {
    const msg = (await res.json().catch(() => ({}))).error || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return res.json();
}

// fetch raw bytes (for streaming a PDF into an object URL).
export async function apiBlob(path) {
  const token = await getToken();
  const res = await fetch(`/.netlify/functions/${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.blob();
}
