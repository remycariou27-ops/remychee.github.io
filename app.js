// ====================== Configuration ======================
const CREDENTIALS = { user: "remychee", pass: "2" };

// Données propres à l'utilisateur connecté (préfixe "own:")
const STORE = new Proxy({}, { get: (_, name) => "own:" + String(name) });

// Données partagées entre tous les utilisateurs (préfixe "shared:")
const GLOBAL = {
  members: "shared:members",
  ownerProfile: "shared:ownerProfile",
};

// Aix-les-Bains
const WEATHER_COORDS = { lat: 45.6885, lon: 5.9152 };

// ====================== Utilitaires ======================
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const euro = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });
const fmt = (n) => euro.format(Number(n) || 0);

// load / save / remove sont définis plus bas (couche données Supabase + cache).

const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const escapeHtml = (str) =>
  String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function ymd(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}
const todayStr = () => ymd();

function frDate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

const minutes = (hhmm) => {
  const [h, m] = (hhmm || "0:0").split(":").map(Number);
  return h * 60 + m;
};
const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
function startOfWeek(d) {
  const x = new Date(d);
  const off = (x.getDay() + 6) % 7; // Lundi = 0
  x.setDate(x.getDate() - off);
  x.setHours(0, 0, 0, 0);
  return x;
}
const weekDays = (d) => Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(d), i));

const tx = (delta, reason) => ({ id: genId(), date: Date.now(), delta, reason });

// ====================== Backend Supabase + Discord ======================
// À configurer (voir guide) :
//  - SUPABASE_URL / SUPABASE_ANON_KEY : dans le tableau de bord Supabase (Settings → API)
//  - Authentication → Providers → Discord : activé avec ton Client ID + Client Secret
const SUPABASE_URL = "https://owpnpjlyttuhcozzizus.supabase.co" ;
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im93cG5wamx5dHR1aGNvenppenVzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE0NjU3NzMsImV4cCI6MjA5NzA0MTc3M30.w0MxDSrn7MhHVdGRn3Lc9hjU3h74uteXqvXknLaON4k";
const ADMIN_ID = "690680975188820018"; // ton ID Discord = administrateur

const supaConfigured = () =>
  /^https:\/\/.+\.supabase\.co/.test(SUPABASE_URL) && SUPABASE_ANON_KEY && !/^TA_/.test(SUPABASE_ANON_KEY);
const sb = supaConfigured() && window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

const loginView = $("#login-view");
const appView = $("#app");

// ---- Identité courante ----
let currentUser = null; // { id (Discord), name, avatar(url) }
function currentUid() {
  return currentUser ? currentUser.id : "anon";
}
const isLoggedIn = () => !!currentUser;

function userFromSession(session) {
  const u = session.user;
  const md = u.user_metadata || {};
  return {
    id: md.provider_id || md.sub || u.id,
    name: md.full_name || md.name || md.user_name || md.global_name || "Utilisateur",
    avatar: md.avatar_url || null,
  };
}

// ---- Couche données : cache mémoire + miroir localStorage + Supabase ----
let DB = {};

function parseKey(key) {
  const i = key.indexOf(":");
  const scope = key.slice(0, i);
  const k = key.slice(i + 1);
  return { owner: scope === "shared" ? "shared" : currentUid(), k };
}
// Clé localStorage namespacée par utilisateur (évite toute fuite entre comptes)
function lsKey(key) {
  const { owner, k } = parseKey(key);
  return `kv:${owner}:${k}`;
}

const load = (key, fallback) => {
  if (Object.prototype.hasOwnProperty.call(DB, key)) return DB[key];
  try {
    const raw = localStorage.getItem(lsKey(key));
    if (raw !== null) return JSON.parse(raw);
  } catch {}
  return fallback;
};
const save = (key, value) => {
  DB[key] = value;
  try {
    localStorage.setItem(lsKey(key), JSON.stringify(value));
  } catch {}
  if (sb) {
    const { owner, k } = parseKey(key);
    sb.from("kv").upsert({ owner, k, v: value }).then(({ error }) => error && console.warn("save", key, error.message));
  }
};
const remove = (key) => {
  delete DB[key];
  try {
    localStorage.removeItem(lsKey(key));
  } catch {}
  if (sb) {
    const { owner, k } = parseKey(key);
    sb.from("kv").delete().match({ owner, k }).then(({ error }) => error && console.warn("remove", key, error.message));
  }
};

async function hydrate() {
  DB = {};
  if (!sb) return;
  const { data, error } = await sb.from("kv").select("owner,k,v").in("owner", [currentUid(), "shared"]);
  if (error) {
    console.warn("hydrate", error.message);
    return;
  }
  data.forEach((row) => {
    const key = (row.owner === "shared" ? "shared:" : "own:") + row.k;
    DB[key] = row.v;
    try {
      localStorage.setItem(lsKey(key), JSON.stringify(row.v));
    } catch {}
  });
}

// Récupère l'éventuelle donnée locale (avant backend) vers l'espace de l'admin
function migrateLocalToUser() {
  if (String(currentUid()) !== String(ADMIN_ID)) return;
  ["bank", "livrets", "notes", "todos", "events", "eventTypes"].forEach((n) => {
    if (load("own:" + n, null) !== null) return;
    const legacy = localStorage.getItem("espace." + n);
    if (legacy !== null) {
      try {
        save("own:" + n, JSON.parse(legacy));
      } catch {}
    }
  });
}

// ---- Affichage ----
function showApp() {
  loginView.hidden = true;
  appView.hidden = false;
  $("#tab-reglages-btn").hidden = !isAdmin();
  renderUserChip();
  renderAll();
}
function showLogin() {
  appView.hidden = true;
  loginView.hidden = false;
  $("#login-config").hidden = supaConfigured();
}
function setLoginStatus(msg) {
  const el = $("#login-status");
  el.textContent = msg || "";
  el.hidden = !msg;
}
function setLoginError(msg) {
  const el = $("#login-error");
  el.textContent = msg || "";
  el.hidden = !msg;
}

// ---- Connexion / déconnexion ----
function startDiscordLogin() {
  if (!sb) {
    $("#login-config").hidden = false;
    return;
  }
  setLoginError("");
  setLoginStatus("Redirection vers Discord…");
  sb.auth.signInWithOAuth({
    provider: "discord",
    options: { redirectTo: window.location.origin + window.location.pathname, scopes: "identify" },
  });
}

$("#discord-login").addEventListener("click", startDiscordLogin);
$("#logout-btn").addEventListener("click", async () => {
  if (sb) await sb.auth.signOut();
  currentUser = null;
  DB = {};
  showLogin();
});

async function afterLogin() {
  await hydrate();
  migrateLocalToUser();
  cacheOwnerProfile();
  showApp();
}

async function handleAuth() {
  if (!sb) {
    showLogin();
    return;
  }
  const {
    data: { session },
  } = await sb.auth.getSession();
  if (session) {
    currentUser = userFromSession(session);
    await afterLogin();
  } else {
    showLogin();
  }
  sb.auth.onAuthStateChange(async (_event, sess) => {
    if (sess && !currentUser) {
      currentUser = userFromSession(sess);
      await afterLogin();
    }
  });
}

// ====================== Rôles & membres ======================
const ROLES = {
  admin: { label: "Administrateur", color: "#ef4444" },
  vip: { label: "VIP", color: "#e0b341" },
  membre: { label: "Membre", color: "#2ec27e" },
};
const getMembers = () => load(GLOBAL.members, []);
const setMembers = (l) => save(GLOBAL.members, l);

function roleOf(userId) {
  if (String(userId) === String(ADMIN_ID)) return "admin";
  const m = getMembers().find((x) => String(x.id) === String(userId));
  return m && ROLES[m.role] ? m.role : "membre";
}
const currentRole = () => roleOf(currentUid());
const isAdmin = () => currentRole() === "admin";

function cacheOwnerProfile() {
  if (currentUser && String(currentUser.id) === String(ADMIN_ID)) {
    save(GLOBAL.ownerProfile, { id: currentUser.id, name: currentUser.name, avatar: currentUser.avatar });
  }
}

function renderUserChip() {
  const chip = $("#user-chip");
  if (!chip || !currentUser) {
    if (chip) chip.innerHTML = "";
    return;
  }
  const avatar = currentUser.avatar ? `<img src="${currentUser.avatar}" alt="">` : "";
  const r = ROLES[currentRole()];
  chip.innerHTML = `${avatar}<span class="chip-name" style="color:${r.color}">${escapeHtml(currentUser.name)}</span>
    <span class="role-badge" style="color:${r.color};border-color:${r.color}">${r.label}</span>`;
}

// ---- Section « Administrateurs » (accueil) ----
function renderAdmins() {
  const box = $("#admins-list");
  if (!box) return;
  const admins = [];
  const owner = load(GLOBAL.ownerProfile, null);
  admins.push({ id: ADMIN_ID, name: owner ? owner.name : "Administrateur", avatar: owner ? owner.avatar : null });
  getMembers()
    .filter((m) => m.role === "admin")
    .forEach((m) => admins.push({ id: m.id, name: m.label || "Administrateur", avatar: null }));

  box.innerHTML = admins
    .map((a) => {
      const av = a.avatar
        ? `<img src="${a.avatar}" alt="">`
        : `<span>${escapeHtml((a.name || "?").charAt(0).toUpperCase())}</span>`;
      return `
      <div class="admin-card">
        <div class="admin-avatar">${av}</div>
        <div class="admin-name" style="color:${ROLES.admin.color}">${escapeHtml(a.name)}</div>
        <div class="admin-role">Administrateur</div>
      </div>`;
    })
    .join("");
}

// ---- Réglages : gestion des membres (admin uniquement) ----
function renderMembers() {
  const box = $("#members-list");
  if (!box) return;
  const list = getMembers();
  $("#members-empty").hidden = list.length > 0;
  box.innerHTML = list
    .map((m) => {
      const r = ROLES[m.role] || ROLES.membre;
      return `
      <div class="member-row">
        <span class="member-info">
          <span class="member-name" style="color:${r.color}">${escapeHtml(m.label || "(sans nom)")}</span>
          <span class="member-id">${escapeHtml(m.id)}</span>
        </span>
        <select data-member-role="${m.id}">
          <option value="membre"${m.role === "membre" ? " selected" : ""}>Membre</option>
          <option value="vip"${m.role === "vip" ? " selected" : ""}>VIP</option>
          <option value="admin"${m.role === "admin" ? " selected" : ""}>Administrateur</option>
        </select>
        <button class="icon-btn danger" data-member-del="${m.id}" title="Retirer">🗑</button>
      </div>`;
    })
    .join("");
  box.querySelectorAll("[data-member-role]").forEach((sel) =>
    sel.addEventListener("change", () => {
      const l = getMembers();
      const m = l.find((x) => String(x.id) === String(sel.dataset.memberRole));
      if (m) {
        m.role = sel.value;
        setMembers(l);
        renderMembers();
        renderAdmins();
        renderUserChip();
      }
    })
  );
  box.querySelectorAll("[data-member-del]").forEach((b) =>
    b.addEventListener("click", () => {
      setMembers(getMembers().filter((x) => String(x.id) !== String(b.dataset.memberDel)));
      renderMembers();
      renderAdmins();
    })
  );
}

const memberAddForm = $("#member-add-form");
if (memberAddForm) {
  memberAddForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const id = $("#member-id").value.trim();
    if (!/^\d{5,25}$/.test(id)) {
      alert("Identifiant Discord invalide (uniquement des chiffres).");
      return;
    }
    if (getMembers().some((m) => String(m.id) === id)) {
      alert("Ce membre est déjà dans la liste.");
      return;
    }
    setMembers([...getMembers(), { id, label: $("#member-label").value.trim(), role: $("#member-role").value }]);
    memberAddForm.reset();
    renderMembers();
    renderAdmins();
  });
}

// ====================== Navigation ======================
$$("#main-tabs .tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    $$("#main-tabs .tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const name = tab.dataset.tab;
    ["accueil", "organisation", "finances", "reglages"].forEach((v) => {
      $("#view-" + v).hidden = v !== name;
    });
    if (name === "accueil") renderDashboard();
    if (name === "reglages") renderMembers();
  });
});

$$(".subtabs").forEach((nav) => {
  nav.querySelectorAll(".subtab").forEach((btn) => {
    btn.addEventListener("click", () => {
      nav.querySelectorAll(".subtab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const name = btn.dataset.sub;
      const view = nav.closest(".view");
      $$(".subview", view).forEach((sv) => {
        sv.hidden = sv.id !== "sub-" + name;
      });
      if (name === "calendrier") renderCalendar();
      if (name === "budget") renderBudget();
    });
  });
});

// ====================== Horloge ======================
function tickClock() {
  const now = new Date();
  const te = $("#dash-time");
  const de = $("#dash-date");
  if (te) te.textContent = now.toLocaleTimeString("fr-FR");
  if (de)
    de.textContent = cap(
      now.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" })
    );
}
setInterval(tickClock, 1000);
tickClock();

// ====================== Météo (Open-Meteo) ======================
const WEATHER_CODES = {
  0: { label: "Ciel dégagé", icon: "☀️" },
  1: { label: "Plutôt dégagé", icon: "🌤️" },
  2: { label: "Partiellement nuageux", icon: "⛅" },
  3: { label: "Couvert", icon: "☁️" },
  45: { label: "Brouillard", icon: "🌫️" },
  48: { label: "Brouillard givrant", icon: "🌫️" },
  51: { label: "Bruine légère", icon: "🌦️" },
  53: { label: "Bruine", icon: "🌦️" },
  55: { label: "Bruine dense", icon: "🌦️" },
  61: { label: "Pluie légère", icon: "🌧️" },
  63: { label: "Pluie", icon: "🌧️" },
  65: { label: "Forte pluie", icon: "🌧️" },
  66: { label: "Pluie verglaçante", icon: "🌧️" },
  67: { label: "Forte pluie verglaçante", icon: "🌧️" },
  71: { label: "Neige légère", icon: "🌨️" },
  73: { label: "Neige", icon: "🌨️" },
  75: { label: "Forte neige", icon: "❄️" },
  77: { label: "Grains de neige", icon: "🌨️" },
  80: { label: "Averses légères", icon: "🌦️" },
  81: { label: "Averses", icon: "🌧️" },
  82: { label: "Fortes averses", icon: "⛈️" },
  85: { label: "Averses de neige", icon: "🌨️" },
  86: { label: "Fortes averses de neige", icon: "❄️" },
  95: { label: "Orage", icon: "⛈️" },
  96: { label: "Orage avec grêle", icon: "⛈️" },
  99: { label: "Orage violent", icon: "⛈️" },
};
let weatherLoaded = false;

function uvLabel(uv) {
  if (uv == null) return "";
  if (uv < 3) return "faible";
  if (uv < 6) return "modéré";
  if (uv < 8) return "élevé";
  if (uv < 11) return "très élevé";
  return "extrême";
}

async function loadWeather() {
  const body = $("#weather-body");
  if (!body) return;
  body.innerHTML = `<p class="muted">Chargement…</p>`;
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${WEATHER_COORDS.lat}` +
    `&longitude=${WEATHER_COORDS.lon}` +
    `&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,uv_index_max` +
    `&forecast_days=5&timezone=Europe%2FParis`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const cur = data.current;
    const d = data.daily;
    const w = WEATHER_CODES[cur.weather_code] || { label: "—", icon: "❓" };
    const max = Math.round(d.temperature_2m_max[0]);
    const min = Math.round(d.temperature_2m_min[0]);
    const uv = d.uv_index_max ? Math.round(d.uv_index_max[0]) : null;

    const forecast = d.time
      .map((iso, i) => {
        const jour = i === 0 ? "Auj." : cap(new Date(iso + "T00:00:00").toLocaleDateString("fr-FR", { weekday: "short" }));
        const fw = WEATHER_CODES[d.weather_code[i]] || { icon: "❓" };
        return `
          <div class="wf-day">
            <span class="wf-dow">${jour}</span>
            <span class="wf-icon">${fw.icon}</span>
            <span class="wf-temp">${Math.round(d.temperature_2m_max[i])}°<span class="wf-min">${Math.round(d.temperature_2m_min[i])}°</span></span>
          </div>`;
      })
      .join("");

    body.innerHTML = `
      <div class="weather-main">
        <span class="weather-icon">${w.icon}</span>
        <span class="weather-temp">${Math.round(cur.temperature_2m)}°</span>
      </div>
      <div class="weather-desc">${w.label}</div>
      <div class="weather-extra">
        <span>Ressenti ${Math.round(cur.apparent_temperature)}°</span>
        <span>Vent ${Math.round(cur.wind_speed_10m)} km/h</span>
        ${uv != null ? `<span>UV ${uv} (${uvLabel(uv)})</span>` : ""}
      </div>
      <div class="weather-forecast">${forecast}</div>`;
    weatherLoaded = true;
  } catch (e) {
    body.innerHTML = `
      <p class="muted">Météo indisponible (vérifiez votre connexion).</p>
      <button class="btn btn-ghost btn-sm" id="weather-retry">Réessayer</button>`;
    const r = $("#weather-retry");
    if (r) r.addEventListener("click", loadWeather);
  }
}
$("#weather-refresh").addEventListener("click", loadWeather);

// ====================== Types d'événement ======================
const getTypes = () => load(STORE.eventTypes, []);
const setTypes = (l) => save(STORE.eventTypes, l);
const typeById = (id) => getTypes().find((t) => t.id === id) || { name: "—", color: "#8a8a93" };
const colorOf = (e) => typeById(e.typeId).color;

const typeModal = $("#type-modal");

function openTypeModal() {
  renderTypeList();
  typeModal.hidden = false;
}
const closeTypeModal = () => (typeModal.hidden = true);

function renderTypeList() {
  const box = $("#type-list");
  box.innerHTML = getTypes()
    .map(
      (t) => `
      <div class="type-row" data-id="${t.id}">
        <input type="color" value="${t.color}" data-type-color="${t.id}" title="Couleur">
        <input type="text" value="${escapeHtml(t.name)}" data-type-name="${t.id}">
        <button class="icon-btn danger" data-type-del="${t.id}" title="Supprimer">🗑</button>
      </div>`
    )
    .join("");
  box.querySelectorAll("[data-type-color]").forEach((inp) =>
    inp.addEventListener("change", () => updateType(inp.dataset.typeColor, { color: inp.value }))
  );
  box.querySelectorAll("[data-type-name]").forEach((inp) =>
    inp.addEventListener("change", () => updateType(inp.dataset.typeName, { name: inp.value.trim() || "Type" }))
  );
  box.querySelectorAll("[data-type-del]").forEach((b) =>
    b.addEventListener("click", () => {
      if (getTypes().length <= 1) {
        alert("Gardez au moins un type.");
        return;
      }
      if (confirm("Supprimer ce type ? Les événements concernés deviendront neutres.")) {
        setTypes(getTypes().filter((t) => t.id !== b.dataset.typeDel));
        afterTypesChanged();
      }
    })
  );
}

function updateType(id, patch) {
  const list = getTypes();
  const t = list.find((x) => x.id === id);
  if (t) {
    Object.assign(t, patch);
    setTypes(list);
    afterTypesChanged();
  }
}

function afterTypesChanged() {
  renderTypeList();
  populateTypeSelect($("#event-type").value);
  renderCalendar();
  renderAgenda();
  renderDashEvents();
}

function populateTypeSelect(selectedId) {
  const sel = $("#event-type");
  const types = getTypes();
  const cur = selectedId || sel.value;
  sel.innerHTML = types.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join("");
  if (cur && types.some((t) => t.id === cur)) sel.value = cur;
}

$("#type-close").addEventListener("click", closeTypeModal);
typeModal.addEventListener("click", (e) => {
  if (e.target === typeModal) closeTypeModal();
});
$("#type-add-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const list = getTypes();
  list.push({ id: genId(), name: $("#type-add-name").value.trim() || "Type", color: $("#type-add-color").value });
  setTypes(list);
  $("#type-add-form").reset();
  $("#type-add-color").value = "#2ec27e";
  afterTypesChanged();
});

// ====================== Seed + migration ======================
function ensureSeed() {
  if (load(STORE.eventTypes, null) === null) {
    setTypes([
      { id: "t-rdv", name: "Rendez-vous", color: "#2ec27e" },
      { id: "t-perso", name: "Perso", color: "#6aa6ff" },
      { id: "t-autre", name: "Autre", color: "#e0b341" },
    ]);
  }
  const evs = getEvents();
  let changed = false;
  evs.forEach((e) => {
    if (e.start === undefined) {
      e.start = e.time || "";
      changed = true;
    }
    if (e.end === undefined) {
      e.end = "";
      changed = true;
    }
    if (!e.typeId) {
      e.typeId = { rdv: "t-rdv", perso: "t-perso", autre: "t-autre" }[e.type] || "t-autre";
      changed = true;
    }
  });
  if (changed) setEvents(evs);
}

// ====================== Dashboard ======================
function renderDashboard() {
  if (!weatherLoaded) loadWeather();
  renderAdmins();
  renderDashTasks();
  renderDashEvents();
  renderDashFinance();
  renderDashCalendar();
}

function renderDashFinance() {
  const box = $("#dash-finance");
  if (!box) return;
  const bank = getBank();
  const livrets = getLivrets();
  const bankBalance = bank ? Number(bank.balance) || 0 : 0;
  const totalLivrets = livrets.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  box.innerHTML = `
    <div class="finance-total">${fmt(bankBalance + totalLivrets)}</div>
    <div class="finance-break">
      <span>Compte : <b>${fmt(bankBalance)}</b></span>
      <span>Épargne : <b>${fmt(totalLivrets)}</b></span>
    </div>`;
}

function renderDashCalendar() {
  const box = $("#dash-calendar");
  if (!box) return;
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const first = new Date(year, month, 1);
  const startOffset = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = todayStr();
  const byDate = eventsByDate();

  const titleEl = $("#dash-cal-title");
  if (titleEl) titleEl.textContent = cap(first.toLocaleDateString("fr-FR", { month: "long", year: "numeric" }));

  const wd = ["L", "M", "M", "J", "V", "S", "D"];
  let html = wd.map((d) => `<span class="mc-wd">${d}</span>`).join("");
  for (let i = 0; i < startOffset; i++) html += `<span class="mc-cell"></span>`;
  for (let day = 1; day <= daysInMonth; day++) {
    const ds = ymd(new Date(year, month, day));
    const hasEv = (byDate[ds] || []).length > 0;
    html += `<span class="mc-cell ${ds === today ? "today" : ""}">${day}${hasEv ? '<i class="mc-dot"></i>' : ""}</span>`;
  }
  box.innerHTML = html;
}

function renderDashTasks() {
  const box = $("#dash-tasks");
  const today = todayStr();
  const todos = getTodos().filter((t) => !t.done && (!t.date || t.date <= today));
  if (!todos.length) {
    box.innerHTML = `<p class="muted">Rien de prévu aujourd'hui 🎉</p>`;
    return;
  }
  box.innerHTML = `<ul class="mini-list">${todos
    .map(
      (t) => `
      <li class="mini-todo">
        <label class="check">
          <input type="checkbox" data-todo="${t.id}">
          <span>${escapeHtml(t.text)}</span>
        </label>
        ${t.date && t.date < today ? `<span class="badge late">en retard</span>` : ""}
      </li>`
    )
    .join("")}</ul>`;
  box.querySelectorAll("input[data-todo]").forEach((cb) => cb.addEventListener("change", () => toggleTodo(cb.dataset.todo)));
}

function renderDashEvents() {
  const box = $("#dash-events");
  const today = todayStr();
  const events = getEvents().filter((e) => eventEndDate(e) >= today).sort(cmpEvent).slice(0, 6);
  if (!events.length) {
    box.innerHTML = `<p class="muted">Aucun rendez-vous à venir.</p>`;
    return;
  }
  box.innerHTML = `<ul class="mini-list">${events
    .map(
      (e) => `
      <li class="mini-event" style="border-left-color:${colorOf(e)}">
        <span class="mini-event-date">${cap(frDate(e.date))}${e.start ? " · " + e.start : ""}</span>
        <span class="mini-event-title">${escapeHtml(e.title)}</span>
      </li>`
    )
    .join("")}</ul>`;
}

// ====================== Bloc-notes (liste repliable) ======================
const getNotes = () => load(STORE.notes, []);
const setNotes = (l) => save(STORE.notes, l);
const noteModal = $("#note-modal");

function renderNotes() {
  const list = getNotes();
  const box = $("#notes-list");
  $("#notes-empty").hidden = list.length > 0;
  box.innerHTML = list
    .map(
      (n) => `
      <div class="note-row ${n.open ? "open" : ""}" data-id="${n.id}">
        <div class="note-row-head">
          <span class="note-chevron">▸</span>
          <span class="note-row-title">${escapeHtml(n.title)}</span>
          <span class="note-row-actions">
            <button class="icon-btn" data-note-edit="${n.id}" title="Modifier">✎</button>
            <button class="icon-btn danger" data-note-del="${n.id}" title="Supprimer">🗑</button>
          </span>
        </div>
        <div class="note-row-body">${escapeHtml(n.body || "").replace(/\n/g, "<br>") || "<span class='muted'>(vide)</span>"}</div>
      </div>`
    )
    .join("");

  box.querySelectorAll(".note-row-head").forEach((head) =>
    head.addEventListener("click", () => {
      const row = head.closest(".note-row");
      row.classList.toggle("open");
      const id = row.dataset.id;
      const l = getNotes();
      const n = l.find((x) => x.id === id);
      if (n) {
        n.open = row.classList.contains("open");
        setNotes(l);
      }
    })
  );
  box.querySelectorAll("[data-note-edit]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      openNoteModal(b.dataset.noteEdit);
    })
  );
  box.querySelectorAll("[data-note-del]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = b.dataset.noteDel;
      const note = getNotes().find((n) => n.id === id);
      if (note && confirm(`Supprimer la note « ${note.title} » ?`)) {
        setNotes(getNotes().filter((n) => n.id !== id));
        renderNotes();
      }
    })
  );
}

function openNoteModal(id) {
  $("#note-form").reset();
  $("#note-id").value = id || "";
  if (id) {
    const note = getNotes().find((n) => n.id === id);
    if (!note) return;
    $("#note-modal-title").textContent = "Modifier la note";
    $("#note-title").value = note.title;
    $("#note-body").value = note.body || "";
  } else {
    $("#note-modal-title").textContent = "Nouvelle note";
  }
  noteModal.hidden = false;
  $("#note-title").focus();
}
const closeNoteModal = () => (noteModal.hidden = true);
$("#add-note-btn").addEventListener("click", () => openNoteModal(null));
$("#note-cancel").addEventListener("click", closeNoteModal);
noteModal.addEventListener("click", (e) => {
  if (e.target === noteModal) closeNoteModal();
});
$("#note-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const id = $("#note-id").value;
  const list = getNotes();
  if (id) {
    const note = list.find((n) => n.id === id);
    if (note) {
      note.title = $("#note-title").value.trim();
      note.body = $("#note-body").value;
      note.updatedAt = Date.now();
    }
  } else {
    list.unshift({ id: genId(), title: $("#note-title").value.trim(), body: $("#note-body").value, open: false, updatedAt: Date.now() });
  }
  setNotes(list);
  closeNoteModal();
  renderNotes();
});

// ====================== To-do ======================
const getTodos = () => load(STORE.todos, []);
const setTodos = (l) => save(STORE.todos, l);
const todoModal = $("#todo-modal");

function renderTodos() {
  const list = getTodos().slice().sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    return (a.date || "9999").localeCompare(b.date || "9999");
  });
  const box = $("#todo-list");
  $("#todo-empty").hidden = list.length > 0;
  const today = todayStr();
  box.innerHTML = list
    .map(
      (t) => `
      <div class="todo-item ${t.done ? "done" : ""}">
        <label class="check">
          <input type="checkbox" data-todo="${t.id}" ${t.done ? "checked" : ""}>
          <span class="todo-text">${escapeHtml(t.text)}</span>
        </label>
        <div class="todo-right">
          ${t.date ? `<span class="badge ${!t.done && t.date < today ? "late" : ""}">${frDate(t.date)}</span>` : ""}
          <button class="icon-btn" data-todo-edit="${t.id}" title="Modifier">✎</button>
          <button class="icon-btn danger" data-todo-del="${t.id}" title="Supprimer">🗑</button>
        </div>
      </div>`
    )
    .join("");
  box.querySelectorAll("input[data-todo]").forEach((cb) => cb.addEventListener("change", () => toggleTodo(cb.dataset.todo)));
  box.querySelectorAll("[data-todo-edit]").forEach((b) => b.addEventListener("click", () => openTodoModal(b.dataset.todoEdit)));
  box.querySelectorAll("[data-todo-del]").forEach((b) =>
    b.addEventListener("click", () => {
      setTodos(getTodos().filter((t) => t.id !== b.dataset.todoDel));
      renderTodos();
      renderDashTasks();
    })
  );
}

function toggleTodo(id) {
  const list = getTodos();
  const t = list.find((x) => x.id === id);
  if (!t) return;
  t.done = !t.done;
  setTodos(list);
  renderTodos();
  renderDashTasks();
}

$("#todo-add-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("#todo-add-text").value.trim();
  if (!text) return;
  const list = getTodos();
  list.push({ id: genId(), text, done: false, date: $("#todo-add-date").value || "" });
  setTodos(list);
  $("#todo-add-form").reset();
  renderTodos();
  renderDashTasks();
});

function openTodoModal(id) {
  const t = getTodos().find((x) => x.id === id);
  if (!t) return;
  $("#todo-id").value = id;
  $("#todo-text").value = t.text;
  $("#todo-date").value = t.date || "";
  todoModal.hidden = false;
  $("#todo-text").focus();
}
const closeTodoModal = () => (todoModal.hidden = true);
$("#todo-cancel").addEventListener("click", closeTodoModal);
todoModal.addEventListener("click", (e) => {
  if (e.target === todoModal) closeTodoModal();
});
$("#todo-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const id = $("#todo-id").value;
  const list = getTodos();
  const t = list.find((x) => x.id === id);
  if (t) {
    t.text = $("#todo-text").value.trim();
    t.date = $("#todo-date").value || "";
  }
  setTodos(list);
  closeTodoModal();
  renderTodos();
  renderDashTasks();
});

// ====================== Événements ======================
const getEvents = () => load(STORE.events, []);
const setEvents = (l) => save(STORE.events, l);
const eventModal = $("#event-modal");

function cmpEvent(a, b) {
  if (a.date !== b.date) return a.date.localeCompare(b.date);
  return (a.start || "").localeCompare(b.start || "");
}

function eventChip(e) {
  const multi = isMultiDay(e);
  return `<button class="cal-chip" style="background:${colorOf(e)}" data-event="${e.id}">${
    e.start && !multi ? e.start + " " : ""
  }${escapeHtml(e.title)}</button>`;
}

// ---- Plage de dates d'un événement (date de début → date de fin) ----
function eventEndDate(e) {
  return e.endDate && e.endDate >= e.date ? e.endDate : e.date;
}
function isMultiDay(e) {
  return eventEndDate(e) > e.date;
}
function eventDays(e) {
  const out = [];
  let d = new Date(e.date + "T00:00:00");
  const end = new Date(eventEndDate(e) + "T00:00:00");
  let guard = 0;
  while (d <= end && guard < 400) {
    out.push(ymd(d));
    d = addDays(d, 1);
    guard++;
  }
  return out.length ? out : [e.date];
}

// ---- État + dispatch des vues ----
let calView = "month";
let calRef = new Date();
const TIME_H = 56; // hauteur d'une heure en px (grille semaine/jour)
const DRAG_SNAP = 15; // pas de calage en minutes
let dragState = null;

function renderCalendar() {
  $$(".cal-view-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === calView));
  const wrap = $("#calendar");
  if (calView === "month") renderMonthView(wrap);
  else renderTimeGridView(wrap, calView === "week" ? weekDays(calRef) : [new Date(calRef)]);
  updateCalTitle();
}

function updateCalTitle() {
  let t;
  if (calView === "month") {
    t = calRef.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
  } else if (calView === "week") {
    const d = weekDays(calRef);
    t =
      d[0].toLocaleDateString("fr-FR", { day: "numeric", month: "short" }) +
      " – " +
      d[6].toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });
  } else {
    t = calRef.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  }
  $("#cal-title").textContent = cap(t);
}

// Map jour -> événements (les multi-jours apparaissent sur chaque jour couvert)
function eventsByDate() {
  const map = {};
  getEvents().forEach((e) => eventDays(e).forEach((ds) => (map[ds] = map[ds] || []).push(e)));
  return map;
}

// ---- Vue mois ----
function renderMonthView(wrap) {
  const year = calRef.getFullYear();
  const month = calRef.getMonth();
  const first = new Date(year, month, 1);
  const startOffset = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = todayStr();
  const byDate = eventsByDate();

  const weekdays = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
  let html = `<div class="cal-grid cal-weekdays">${weekdays
    .map((d) => `<div class="cal-weekday">${d}</div>`)
    .join("")}</div><div class="cal-grid">`;

  for (let i = 0; i < 42; i++) {
    const dayNum = i - startOffset + 1;
    const cellDate = new Date(year, month, dayNum);
    const ds = ymd(cellDate);
    const other = dayNum < 1 || dayNum > daysInMonth;
    const evs = (byDate[ds] || []).slice().sort(cmpEvent);
    html += `
      <div class="cal-cell ${other ? "other" : ""} ${ds === today ? "today" : ""}" data-date="${ds}">
        <span class="cal-day">${cellDate.getDate()}</span>
        <div class="cal-events">
          ${evs.slice(0, 3).map(eventChip).join("")}
          ${evs.length > 3 ? `<span class="cal-more">+${evs.length - 3}</span>` : ""}
        </div>
      </div>`;
  }
  html += `</div>`;
  wrap.innerHTML = html;

  wrap.querySelectorAll(".cal-cell").forEach((cell) =>
    cell.addEventListener("click", () => openEventModal(null, cell.dataset.date))
  );
  wireEventClicks(wrap);
}

// ---- Vue semaine / jour (grille horaire) ----
function renderTimeGridView(wrap, days) {
  const H = TIME_H;
  const today = todayStr();
  const byDate = eventsByDate();
  const hours = Array.from({ length: 24 }, (_, h) => h);

  let html = `<div class="tg" style="--cols:${days.length};--h:${H}px">`;

  // En-tête des jours
  html += `<div class="tg-header"><div class="tg-corner"></div>`;
  html += days
    .map((d) => {
      const ds = ymd(d);
      return `<div class="tg-dayhead ${ds === today ? "today" : ""}">
        <span class="tg-dow">${cap(d.toLocaleDateString("fr-FR", { weekday: "short" }))}</span>
        <span class="tg-dnum">${d.getDate()}</span>
      </div>`;
    })
    .join("");
  html += `</div>`;

  // Ligne "journée entière" : événements sans heure OU sur plusieurs jours
  const isAllDay = (e) => !e.start || isMultiDay(e);
  const hasAllDay = days.some((d) => (byDate[ymd(d)] || []).some(isAllDay));
  if (hasAllDay) {
    html += `<div class="tg-allday"><div class="tg-allday-label">Journée</div>`;
    html += days
      .map((d) => {
        const ds = ymd(d);
        const evs = (byDate[ds] || []).filter(isAllDay).sort(cmpEvent);
        return `<div class="tg-allday-col" data-date="${ds}">${evs.map(eventChip).join("")}</div>`;
      })
      .join("");
    html += `</div>`;
  }

  // Corps : colonne des heures + colonnes des jours
  html += `<div class="tg-body">`;
  html += `<div class="tg-hours">${hours
    .map((h) => `<div class="tg-hour"><span>${String(h).padStart(2, "0")}:00</span></div>`)
    .join("")}</div>`;
  html += days
    .map((d) => {
      const ds = ymd(d);
      const evs = (byDate[ds] || [])
        .filter((e) => e.start && !isMultiDay(e))
        .sort((a, b) => minutes(a.start) - minutes(b.start));
      const blocks = evs
        .map((e) => {
          const s = minutes(e.start);
          const en = e.end ? minutes(e.end) : s + 60;
          const top = (s / 60) * H;
          const height = Math.max(((Math.max(en, s + 30) - s) / 60) * H, 22);
          return `<button class="tg-event" data-event="${e.id}" style="top:${top}px;height:${height}px;background:${colorOf(e)}">
            <span class="tg-event-time">${e.start}${e.end ? "–" + e.end : ""}</span>
            <span class="tg-event-title">${escapeHtml(e.title)}</span>
          </button>`;
        })
        .join("");
      return `<div class="tg-col ${ds === today ? "today" : ""}" data-date="${ds}">${blocks}</div>`;
    })
    .join("");
  html += `</div></div>`;
  wrap.innerHTML = html;

  // Glisser sur une colonne -> nouvel événement (heure début → heure fin)
  wrap.querySelectorAll(".tg-col").forEach((col) =>
    col.addEventListener("mousedown", (ev) => startDrag(ev, col))
  );
  wrap.querySelectorAll(".tg-allday-col").forEach((col) =>
    col.addEventListener("click", (ev) => {
      if (ev.target === col) openEventModal(null, col.dataset.date);
    })
  );
  wireEventClicks(wrap);

  // En-tête + barre "Journée" collants : positionne la barre sous l'en-tête
  const tg = $(".tg", wrap);
  const bodyEl = $(".tg-body", wrap);
  const header = $(".tg-header", wrap);
  const allday = $(".tg-allday", wrap);
  if (allday && header) allday.style.top = header.offsetHeight + "px";
  // Défilement initial vers 7h (sous les barres collantes)
  const stick = (header ? header.offsetHeight : 0) + (allday ? allday.offsetHeight : 0);
  if (tg && bodyEl) tg.scrollTop = bodyEl.offsetTop + 7 * H - stick;
}

function wireEventClicks(wrap) {
  wrap.querySelectorAll("[data-event]").forEach((el) =>
    el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openEventModal(el.dataset.event);
    })
  );
}

// ---- Glisser pour créer un événement (à la Apple) ----
function toHHMM(min) {
  min = Math.max(0, Math.min(1439, Math.round(min)));
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}
function minFromY(col, clientY) {
  const rect = col.getBoundingClientRect();
  let y = Math.max(0, Math.min(rect.height, clientY - rect.top));
  let m = (y / TIME_H) * 60;
  return Math.max(0, Math.min(1440, Math.round(m / DRAG_SNAP) * DRAG_SNAP));
}
function updateSelection() {
  if (!dragState) return;
  const a = Math.min(dragState.startMin, dragState.curMin);
  const b = Math.max(dragState.startMin, dragState.curMin);
  dragState.el.style.top = (a / 60) * TIME_H + "px";
  dragState.el.style.height = Math.max(((b - a) / 60) * TIME_H, 4) + "px";
}
function startDrag(ev, col) {
  if (ev.button !== 0) return; // clic gauche uniquement
  if (ev.target.closest(".tg-event")) return; // on a cliqué un événement existant
  ev.preventDefault();
  const startMin = minFromY(col, ev.clientY);
  const el = document.createElement("div");
  el.className = "tg-selection";
  col.appendChild(el);
  dragState = { col, date: col.dataset.date, startMin, curMin: startMin, el, moved: false };
  updateSelection();
}
document.addEventListener("mousemove", (ev) => {
  if (!dragState) return;
  dragState.curMin = minFromY(dragState.col, ev.clientY);
  if (Math.abs(dragState.curMin - dragState.startMin) >= DRAG_SNAP) dragState.moved = true;
  updateSelection();
});
document.addEventListener("mouseup", () => {
  if (!dragState) return;
  const { date, el, moved } = dragState;
  let a = Math.min(dragState.startMin, dragState.curMin);
  let b = Math.max(dragState.startMin, dragState.curMin);
  if (el && el.parentNode) el.parentNode.removeChild(el);
  dragState = null;
  if (!moved) {
    // simple clic -> créneau d'une heure
    a = Math.floor(a / 60) * 60;
    b = a + 60;
  } else if (b - a < DRAG_SNAP) {
    b = a + DRAG_SNAP;
  }
  openEventModal(null, date, toHHMM(a), toHHMM(b));
});

// ---- Navigation calendrier ----
$$(".cal-view-btn").forEach((b) =>
  b.addEventListener("click", () => {
    calView = b.dataset.view;
    renderCalendar();
  })
);
function shiftCal(dir) {
  if (calView === "month") calRef = new Date(calRef.getFullYear(), calRef.getMonth() + dir, 1);
  else if (calView === "week") calRef = addDays(calRef, 7 * dir);
  else calRef = addDays(calRef, dir);
  renderCalendar();
}
$("#cal-prev").addEventListener("click", () => shiftCal(-1));
$("#cal-next").addEventListener("click", () => shiftCal(1));
$("#cal-today").addEventListener("click", () => {
  calRef = new Date();
  renderCalendar();
});
$("#cal-types").addEventListener("click", openTypeModal);

// ---- Agenda ----
function eventRow(e) {
  const c = colorOf(e);
  const t = typeById(e.typeId);
  const when =
    cap(frDate(e.date)) +
    (isMultiDay(e) ? " → " + cap(frDate(eventEndDate(e))) : "") +
    (e.start ? "<br>" + e.start + (e.end ? "–" + e.end : "") : "");
  return `
    <button class="agenda-item" style="border-left-color:${c}" data-event="${e.id}">
      <span class="agenda-type" style="color:${c}">${escapeHtml(t.name)}</span>
      <span class="agenda-main">
        <span class="agenda-title">${escapeHtml(e.title)}</span>
        ${e.note ? `<span class="agenda-note">${escapeHtml(e.note)}</span>` : ""}
      </span>
      <span class="agenda-when">${when}</span>
    </button>`;
}

function renderAgenda() {
  const box = $("#agenda-list");
  const today = todayStr();
  const all = getEvents().slice().sort(cmpEvent);
  const upcoming = all.filter((e) => e.date >= today);
  const past = all.filter((e) => e.date < today).reverse();

  let html = "";
  if (!all.length) {
    html = `<p class="muted">Aucun événement. Ajoutez-en un depuis le calendrier ou ci-dessus.</p>`;
  } else {
    html += `<h3 class="agenda-section">À venir</h3>`;
    html += upcoming.length
      ? `<div class="agenda-group">${upcoming.map(eventRow).join("")}</div>`
      : `<p class="muted">Rien à venir.</p>`;
    if (past.length) {
      html += `<details class="history" style="margin-top:18px;">
        <summary>Passés (${past.length})</summary>
        <div class="agenda-group" style="margin-top:8px;">${past.map(eventRow).join("")}</div>
      </details>`;
    }
  }
  box.innerHTML = html;
  box.querySelectorAll(".agenda-item").forEach((it) => it.addEventListener("click", () => openEventModal(it.dataset.event)));
}

// ---- Modale événement ----
function openEventModal(id, presetDate, presetStart, presetEnd) {
  $("#event-form").reset();
  $("#event-id").value = id || "";
  populateTypeSelect();
  const del = $("#event-delete");
  if (id) {
    const ev = getEvents().find((e) => e.id === id);
    if (!ev) return;
    $("#event-modal-title").textContent = "Modifier l'événement";
    $("#event-title").value = ev.title;
    $("#event-date").value = ev.date;
    $("#event-end-date").value = ev.endDate || "";
    $("#event-start").value = ev.start || "";
    $("#event-end").value = ev.end || "";
    populateTypeSelect(ev.typeId);
    $("#event-note").value = ev.note || "";
    del.hidden = false;
  } else {
    $("#event-modal-title").textContent = "Nouvel événement";
    $("#event-date").value = presetDate || todayStr();
    $("#event-end-date").value = "";
    $("#event-start").value = presetStart || "";
    if (presetEnd) {
      $("#event-end").value = presetEnd;
    } else if (presetStart) {
      $("#event-end").value = toHHMM(minutes(presetStart) + 60);
    }
    del.hidden = true;
  }
  eventModal.hidden = false;
  $("#event-title").focus();
}
const closeEventModal = () => (eventModal.hidden = true);

$("#add-event-btn").addEventListener("click", () => openEventModal(null));
$("#add-event-btn2").addEventListener("click", () => openEventModal(null));
$("#event-add-type").addEventListener("click", openTypeModal);
$("#event-cancel").addEventListener("click", closeEventModal);
eventModal.addEventListener("click", (e) => {
  if (e.target === eventModal) closeEventModal();
});
$("#event-delete").addEventListener("click", () => {
  const id = $("#event-id").value;
  if (!id) return;
  setEvents(getEvents().filter((e) => e.id !== id));
  closeEventModal();
  renderEventsAll();
});
$("#event-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const id = $("#event-id").value;
  const list = getEvents();
  const endDateVal = $("#event-end-date").value || "";
  const startDateVal = $("#event-date").value;
  const data = {
    title: $("#event-title").value.trim(),
    date: startDateVal,
    endDate: endDateVal && endDateVal > startDateVal ? endDateVal : "",
    start: $("#event-start").value || "",
    end: $("#event-end").value || "",
    typeId: $("#event-type").value,
    note: $("#event-note").value.trim(),
  };
  if (id) {
    const ev = list.find((x) => x.id === id);
    if (ev) Object.assign(ev, data);
  } else {
    list.push({ id: genId(), ...data });
  }
  setEvents(list);
  closeEventModal();
  renderEventsAll();
});

function renderEventsAll() {
  renderCalendar();
  renderAgenda();
  renderDashEvents();
}

// ====================== Historique financier ======================
function renderHistory(transactions, open, owner) {
  const list = transactions || [];
  if (!list.length) return `<p class="muted">Aucun mouvement pour le moment.</p>`;
  const rows = list
    .slice()
    .reverse()
    .map((t) => {
      const pos = t.delta >= 0;
      return `
        <li class="tx">
          <div class="tx-main">
            <span class="tx-reason">${escapeHtml(t.reason || (pos ? "Entrée" : "Sortie"))}</span>
            <span class="tx-date">${new Date(t.date).toLocaleString("fr-FR")}</span>
          </div>
          <span class="tx-amount ${pos ? "pos" : "neg"}">${pos ? "+" : "−"} ${fmt(Math.abs(t.delta))}</span>
          <button class="tx-del" title="Supprimer ce mouvement" data-owner="${owner}" data-txid="${t.id}">×</button>
        </li>`;
    })
    .join("");
  return `
    <details class="history"${open ? " open" : ""}>
      <summary>Historique (${list.length})</summary>
      <ul class="tx-list">${rows}</ul>
    </details>`;
}

function wireHistory(root) {
  root.querySelectorAll(".tx-del").forEach((btn) => btn.addEventListener("click", () => deleteTx(btn.dataset.owner, btn.dataset.txid)));
}

function deleteTx(owner, txid) {
  if (owner === "bank") {
    const bank = getBank();
    if (!bank || !bank.transactions) return;
    const t = bank.transactions.find((x) => x.id === txid);
    if (!t) return;
    if (!confirm(`Supprimer le mouvement « ${t.reason} » ?\nLe solde sera réajusté.`)) return;
    bank.balance = (Number(bank.balance) || 0) - t.delta;
    bank.transactions = bank.transactions.filter((x) => x.id !== txid);
    bank.updatedAt = Date.now();
    save(STORE.bank, bank);
    renderBank();
    renderSummary();
  } else {
    const list = getLivrets();
    const livret = list.find((l) => l.id === owner);
    if (!livret || !livret.transactions) return;
    const t = livret.transactions.find((x) => x.id === txid);
    if (!t) return;
    if (!confirm(`Supprimer le mouvement « ${t.reason} » ?\nLe montant du livret sera réajusté.`)) return;
    livret.amount = (Number(livret.amount) || 0) - t.delta;
    livret.transactions = livret.transactions.filter((x) => x.id !== txid);
    setLivrets(list);
    renderLivrets();
    renderSummary();
  }
}

// ====================== Compte en banque ======================
const getBank = () => load(STORE.bank, null);

function renderBank() {
  const bank = getBank();
  const body = $("#bank-body");
  if (!bank) {
    body.innerHTML = `
      <p class="muted" style="margin-bottom:14px;">Aucun compte enregistré pour le moment.</p>
      <button class="btn btn-primary" id="bank-create">Créer mon compte</button>`;
    $("#bank-create").addEventListener("click", () => openBankModal(true));
    return;
  }
  body.innerHTML = `
    <div class="account-card">
      <div>
        <p class="account-name">${escapeHtml(bank.name || "Compte")}</p>
        <p class="muted">${bank.updatedAt ? "Dernière mise à jour : " + new Date(bank.updatedAt).toLocaleString("fr-FR") : ""}</p>
      </div>
      <div class="account-balance">${fmt(bank.balance)}</div>
    </div>
    <div class="livret-actions account-actions">
      <button class="btn btn-ghost" id="bank-in">+ Revenu</button>
      <button class="btn btn-ghost" id="bank-out">− Dépense</button>
      <button class="btn btn-ghost" id="bank-edit">Modifier</button>
      <button class="btn btn-danger" id="bank-delete">Supprimer le compte</button>
    </div>
    ${renderHistory(bank.transactions, true, "bank")}`;
  $("#bank-in").addEventListener("click", () => openMove("bank", null, "in"));
  $("#bank-out").addEventListener("click", () => openMove("bank", null, "out"));
  $("#bank-edit").addEventListener("click", () => openBankModal(false));
  $("#bank-delete").addEventListener("click", () => {
    askConfirm(`Supprimer définitivement le compte « ${bank.name || "Compte"} » et tout son historique ?`, () => {
      remove(STORE.bank);
      renderBank();
      renderSummary();
    });
  });
  wireHistory(body);
}

const bankModal = $("#bank-modal");
function openBankModal(isCreate) {
  const bank = getBank();
  $("#bank-form").reset();
  $("#bank-modal-title").textContent = isCreate ? "Créer mon compte" : "Modifier mon compte";
  bankModal.dataset.create = isCreate ? "1" : "0";
  if (!isCreate && bank) {
    $("#bank-name").value = bank.name || "";
    $("#bank-balance").value = bank.balance != null ? bank.balance : "";
  }
  bankModal.hidden = false;
  $("#bank-name").focus();
}
const closeBankModal = () => (bankModal.hidden = true);
$("#bank-cancel").addEventListener("click", closeBankModal);
bankModal.addEventListener("click", (e) => {
  if (e.target === bankModal) closeBankModal();
});
$("#bank-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const isCreate = bankModal.dataset.create === "1";
  const name = $("#bank-name").value.trim();
  const newBalance = parseFloat($("#bank-balance").value) || 0;
  let bank = getBank();
  if (isCreate || !bank) {
    bank = { name, balance: newBalance, updatedAt: Date.now(), transactions: [] };
    if (newBalance !== 0) bank.transactions.push(tx(newBalance, "Solde initial"));
  } else {
    const delta = newBalance - (Number(bank.balance) || 0);
    bank.name = name;
    bank.balance = newBalance;
    bank.updatedAt = Date.now();
    bank.transactions = bank.transactions || [];
    if (delta !== 0) bank.transactions.push(tx(delta, "Ajustement du solde"));
  }
  save(STORE.bank, bank);
  closeBankModal();
  renderBank();
  renderSummary();
});

// ====================== Livrets ======================
const getLivrets = () => load(STORE.livrets, []);
const setLivrets = (l) => save(STORE.livrets, l);
const livretModal = $("#livret-modal");

function renderLivrets() {
  const list = getLivrets();
  const container = $("#livrets-list");
  $("#livrets-empty").hidden = list.length > 0;
  container.innerHTML = "";
  list.forEach((l) => {
    const amount = Number(l.amount) || 0;
    const rate = Number(l.rate) || 0;
    const plafond = Number(l.plafond) || 0;
    const interetAnnuel = amount * (rate / 100);
    let progressHtml = "";
    if (plafond > 0) {
      const pct = Math.min((amount / plafond) * 100, 100);
      const over = amount > plafond;
      const restant = plafond - amount;
      progressHtml = `
        <div class="progress">
          <div class="progress-bar" style="width:${pct}%; ${over ? "background:var(--danger);" : ""}"></div>
        </div>
        <p class="progress-label ${over ? "over" : ""}">
          ${over ? "Plafond dépassé de " + fmt(amount - plafond) : Math.round(pct) + " % du plafond &middot; reste " + fmt(restant) + " disponible"}
        </p>`;
    }
    const card = document.createElement("div");
    card.className = "livret";
    card.innerHTML = `
      <div class="livret-top">
        <div>
          <p class="livret-name">${escapeHtml(l.name)}</p>
          <span class="livret-rate">${rate.toLocaleString("fr-FR")} % / an</span>
        </div>
        <div class="livret-amount">${fmt(amount)}</div>
      </div>
      <div class="livret-meta one">
        <div class="meta-item">
          <span class="k">Rendement estimé (an)</span>
          <span class="v">${fmt(interetAnnuel)}</span>
        </div>
      </div>
      ${progressHtml}
      <div class="livret-actions">
        <button class="btn btn-ghost" data-act="add" data-id="${l.id}">+ Dépôt</button>
        <button class="btn btn-ghost" data-act="remove" data-id="${l.id}">− Retrait</button>
        <button class="btn btn-ghost" data-act="edit" data-id="${l.id}">Modifier</button>
        <button class="btn btn-danger" data-act="delete" data-id="${l.id}">Supprimer</button>
      </div>
      ${renderHistory(l.transactions, false, l.id)}`;
    container.appendChild(card);
  });
  container.querySelectorAll("button[data-act]").forEach((btn) =>
    btn.addEventListener("click", () => handleLivretAction(btn.dataset.act, btn.dataset.id))
  );
  wireHistory(container);
}

function handleLivretAction(act, id) {
  if (act === "delete") {
    const livret = getLivrets().find((l) => l.id === id);
    if (!livret) return;
    askConfirm(`Supprimer définitivement le livret « ${livret.name} » et tout son historique ?`, () => {
      setLivrets(getLivrets().filter((l) => l.id !== id));
      renderLivrets();
      renderSummary();
    });
  } else if (act === "edit") {
    openLivretModal(id);
  } else if (act === "add") {
    openMove("livret", id, "in");
  } else if (act === "remove") {
    openMove("livret", id, "out");
  }
}

function openLivretModal(id) {
  $("#livret-form").reset();
  $("#livret-id").value = id || "";
  if (id) {
    const livret = getLivrets().find((l) => l.id === id);
    if (!livret) return;
    $("#livret-modal-title").textContent = "Modifier le livret";
    $("#livret-name").value = livret.name;
    $("#livret-amount").value = livret.amount;
    $("#livret-rate").value = livret.rate;
    $("#livret-plafond").value = livret.plafond || "";
  } else {
    $("#livret-modal-title").textContent = "Ajouter un livret";
  }
  livretModal.hidden = false;
  $("#livret-name").focus();
}
const closeLivretModal = () => (livretModal.hidden = true);
$("#add-livret-btn").addEventListener("click", () => openLivretModal(null));
$("#livret-cancel").addEventListener("click", closeLivretModal);
livretModal.addEventListener("click", (e) => {
  if (e.target === livretModal) closeLivretModal();
});
$("#livret-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const id = $("#livret-id").value;
  const list = getLivrets();
  const data = {
    name: $("#livret-name").value.trim(),
    amount: parseFloat($("#livret-amount").value) || 0,
    rate: parseFloat($("#livret-rate").value) || 0,
    plafond: parseFloat($("#livret-plafond").value) || 0,
  };
  if (id) {
    const livret = list.find((l) => l.id === id);
    if (livret) {
      const delta = data.amount - (Number(livret.amount) || 0);
      Object.assign(livret, data);
      livret.transactions = livret.transactions || [];
      if (delta !== 0) livret.transactions.push(tx(delta, "Ajustement du montant"));
    }
  } else {
    const livret = { id: genId(), ...data, transactions: [] };
    if (data.amount !== 0) livret.transactions.push(tx(data.amount, "Montant initial"));
    list.push(livret);
  }
  setLivrets(list);
  closeLivretModal();
  renderLivrets();
  renderSummary();
});

// ====================== Modale mouvement ======================
const moveModal = $("#move-modal");
function openMove(target, id, direction) {
  $("#move-form").reset();
  $("#move-warning").hidden = true;
  $("#move-target").value = target;
  $("#move-id").value = id || "";
  $("#move-direction").value = direction;
  $("#move-title").textContent =
    target === "bank"
      ? direction === "in"
        ? "Ajouter un revenu"
        : "Ajouter une dépense"
      : direction === "in"
      ? "Déposer de l'argent"
      : "Retirer de l'argent";
  moveModal.hidden = false;
  $("#move-amount").focus();
}
const closeMoveModal = () => (moveModal.hidden = true);
$("#move-cancel").addEventListener("click", closeMoveModal);
moveModal.addEventListener("click", (e) => {
  if (e.target === moveModal) closeMoveModal();
});
$("#move-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const target = $("#move-target").value;
  const id = $("#move-id").value;
  const direction = $("#move-direction").value;
  const amount = parseFloat($("#move-amount").value) || 0;
  const reason = $("#move-reason").value.trim();
  const warning = $("#move-warning");
  if (amount <= 0) {
    warning.textContent = "Veuillez saisir un montant valide.";
    warning.hidden = false;
    return;
  }
  const delta = direction === "in" ? amount : -amount;
  if (target === "bank") {
    const bank = getBank();
    if (!bank) return closeMoveModal();
    bank.balance = (Number(bank.balance) || 0) + delta;
    bank.updatedAt = Date.now();
    bank.transactions = bank.transactions || [];
    bank.transactions.push(tx(delta, reason || (direction === "in" ? "Revenu" : "Dépense")));
    save(STORE.bank, bank);
  } else {
    const list = getLivrets();
    const livret = list.find((l) => l.id === id);
    if (!livret) return closeMoveModal();
    if (direction === "out" && (Number(livret.amount) || 0) - amount < 0) {
      warning.textContent = "Le retrait dépasse le montant disponible.";
      warning.hidden = false;
      return;
    }
    livret.amount = (Number(livret.amount) || 0) + delta;
    livret.transactions = livret.transactions || [];
    livret.transactions.push(tx(delta, reason || (direction === "in" ? "Dépôt" : "Retrait")));
    setLivrets(list);
  }
  closeMoveModal();
  renderBank();
  renderLivrets();
  renderSummary();
});

// ====================== Confirmation par identifiants ======================
const confirmModal = $("#confirm-modal");
let pendingAction = null;
function askConfirm(text, action) {
  $("#confirm-form").reset();
  $("#confirm-warning").hidden = true;
  $("#confirm-text").textContent = text;
  pendingAction = action;
  confirmModal.hidden = false;
  $("#confirm-user").focus();
}
const closeConfirmModal = () => {
  confirmModal.hidden = true;
  pendingAction = null;
};
$("#confirm-cancel").addEventListener("click", closeConfirmModal);
confirmModal.addEventListener("click", (e) => {
  if (e.target === confirmModal) closeConfirmModal();
});
$("#confirm-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const user = $("#confirm-user").value.trim();
  const pass = $("#confirm-pass").value;
  if (user === CREDENTIALS.user && pass === CREDENTIALS.pass) {
    const action = pendingAction;
    confirmModal.hidden = true;
    pendingAction = null;
    if (action) action();
  } else {
    $("#confirm-warning").textContent = "Identifiant ou mot de passe incorrect.";
    $("#confirm-warning").hidden = false;
  }
});

// ====================== Budget mensuel ======================
const getBudget = () => load(STORE.budget, { income: 0, categories: [], fixed: [] });
const setBudget = (b) => save(STORE.budget, b);

function renderBudget() {
  const b = getBudget();
  const incomeEl = $("#budget-income");
  if (!incomeEl) return;
  if (document.activeElement !== incomeEl) incomeEl.value = b.income || "";

  const totalCats = (b.categories || []).reduce((s, c) => s + (Number(c.amount) || 0), 0);
  const totalFixed = (b.fixed || []).reduce((s, f) => s + (Number(f.amount) || 0), 0);
  const income = Number(b.income) || 0;
  const reste = income - totalCats - totalFixed;

  $("#budget-summary").innerHTML = `
    <div class="bsum-item"><span>Revenu</span><b>${fmt(income)}</b></div>
    <div class="bsum-item"><span>Catégories</span><b>${fmt(totalCats)}</b></div>
    <div class="bsum-item"><span>Fixes / abos</span><b>${fmt(totalFixed)}</b></div>
    <div class="bsum-item highlight"><span>Épargne possible</span><b class="${reste < 0 ? "neg" : "pos"}">${fmt(reste)}</b></div>`;

  // Catégories
  const cats = b.categories || [];
  $("#budget-cats").innerHTML = cats.length
    ? cats
        .map(
          (c) => `
      <div class="budget-row">
        <span class="bcat-color" style="background:${c.color || "#6aa6ff"}"></span>
        <span class="budget-name">${escapeHtml(c.name)}</span>
        <span class="budget-amount">${fmt(c.amount)}</span>
        <button class="icon-btn danger" data-cat-del="${c.id}" title="Supprimer">🗑</button>
      </div>`
        )
        .join("")
    : `<p class="muted">Aucune catégorie. Ex : Courses, Loisirs, Essence…</p>`;

  // Dépenses fixes
  const fixed = b.fixed || [];
  $("#budget-fixed").innerHTML = fixed.length
    ? fixed
        .map(
          (f) => `
      <div class="budget-row">
        <span class="budget-name">${escapeHtml(f.name)}</span>
        <span class="budget-amount">${fmt(f.amount)}</span>
        <button class="icon-btn danger" data-fixed-del="${f.id}" title="Supprimer">🗑</button>
      </div>`
        )
        .join("")
    : `<p class="muted">Aucun abonnement / dépense fixe.</p>`;

  $("#budget-cats")
    .querySelectorAll("[data-cat-del]")
    .forEach((btn) =>
      btn.addEventListener("click", () => {
        const bg = getBudget();
        bg.categories = (bg.categories || []).filter((c) => c.id !== btn.dataset.catDel);
        setBudget(bg);
        renderBudget();
      })
    );
  $("#budget-fixed")
    .querySelectorAll("[data-fixed-del]")
    .forEach((btn) =>
      btn.addEventListener("click", () => {
        const bg = getBudget();
        bg.fixed = (bg.fixed || []).filter((f) => f.id !== btn.dataset.fixedDel);
        setBudget(bg);
        renderBudget();
      })
    );
}

const budgetIncomeEl = $("#budget-income");
if (budgetIncomeEl) {
  budgetIncomeEl.addEventListener("input", () => {
    const b = getBudget();
    b.income = parseFloat(budgetIncomeEl.value) || 0;
    setBudget(b);
    renderBudget();
  });
}
const catAddForm = $("#cat-add-form");
if (catAddForm) {
  catAddForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const b = getBudget();
    b.categories = b.categories || [];
    b.categories.push({
      id: genId(),
      name: $("#cat-add-name").value.trim() || "Catégorie",
      color: $("#cat-add-color").value,
      amount: parseFloat($("#cat-add-amount").value) || 0,
    });
    setBudget(b);
    catAddForm.reset();
    $("#cat-add-color").value = "#6aa6ff";
    renderBudget();
  });
}
const fixedAddForm = $("#fixed-add-form");
if (fixedAddForm) {
  fixedAddForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const b = getBudget();
    b.fixed = b.fixed || [];
    b.fixed.push({ id: genId(), name: $("#fixed-add-name").value.trim() || "Dépense", amount: parseFloat($("#fixed-add-amount").value) || 0 });
    setBudget(b);
    fixedAddForm.reset();
    renderBudget();
  });
}

// ====================== Synthèse finances ======================
function renderSummary() {
  const bank = getBank();
  const livrets = getLivrets();
  const totalLivrets = livrets.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const bankBalance = bank ? Number(bank.balance) || 0 : 0;
  $("#sum-bank").textContent = fmt(bankBalance);
  $("#sum-livrets").textContent = fmt(totalLivrets);
  $("#sum-total").textContent = fmt(bankBalance + totalLivrets);
}

// ====================== Rendu global ======================
function renderAll() {
  ensureSeed();
  renderDashboard();
  renderNotes();
  renderTodos();
  renderCalendar();
  renderAgenda();
  renderBank();
  renderLivrets();
  renderSummary();
  renderBudget();
  renderMembers();
}

// ====================== Démarrage ======================
handleAuth();
