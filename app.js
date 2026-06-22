/* ====================================================================
   Nordhaven Capital — site public + portail de prêt
   Backend SÉCURISÉ : Supabase (Auth + PostgreSQL + RLS).
   - Mots de passe gérés/chiffrés côté serveur (jamais dans le navigateur).
   - Chaque client ne voit que ses propres données (RLS).
   - Le rôle admin est vérifié côté serveur (non usurpable depuis la console).
   Voir supabase-schema.sql et SETUP.md.
   ==================================================================== */
(function () {
  "use strict";

  const ADMIN_USERNAME = "lautaro_castillo";
  const EMAIL_DOMAIN = "nordhaven-capital.com"; // e-mail synthétique pour l'auth (domaine accepté par Supabase)
  const TPL_KEY = "contract_template";

  /* ---------------- utils ---------------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const euro = (n) => (Number(n) || 0).toLocaleString("fr-FR", {
    style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = (n) => (Number(n) || 0).toLocaleString("fr-FR", { maximumFractionDigits: 2 }) + " %";
  const fmtDate = (iso) => {
    if (!iso) return "—";
    const s = String(iso);
    const d = new Date(s.length === 10 ? s + "T00:00:00" : s);
    return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
  };
  const fmtDateTime = (ts) => new Date(ts).toLocaleString("fr-FR",
    { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const todayISO = () => new Date().toISOString().slice(0, 10);
  const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  const emailFor = (u) => `${u.toLowerCase()}@${EMAIL_DOMAIN}`;
  function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, (m) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
  }
  let toastTimer = null;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 3000);
  }

  /* ---------------- Supabase client ---------------- */
  const CFG = window.NORDHAVEN_CONFIG || {};
  const CONFIGURED =
    CFG.SUPABASE_URL && !/VOTRE/.test(CFG.SUPABASE_URL) &&
    CFG.SUPABASE_ANON_KEY && !/VOTRE/.test(CFG.SUPABASE_ANON_KEY);
  let sb = null;
  if (CONFIGURED && window.supabase) {
    sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
  } else {
    $("#config-banner").hidden = false;
  }
  function requireConfig() {
    if (!sb) { toast("Configuration Supabase requise (voir SETUP.md)."); return false; }
    return true;
  }

  /* ---------------- état + caches ---------------- */
  let session = null; // {id, username, name, role}
  const DB = { contracts: [], devis: [], contacts: [], profiles: [] };

  const profileById = (id) => DB.profiles.find((p) => p.id === id);
  const clientName = (id) => profileById(id)?.full_name || profileById(id)?.username || "—";
  const usernameById = (id) => profileById(id)?.username || null;

  /* ---------------- normalisation (snake_case -> camelCase) ---------------- */
  const normContract = (r) => ({
    id: r.id, client: r.client_id, label: r.label, principal: Number(r.principal),
    rate: Number(r.rate), weeks: r.weeks, startDate: r.start_date, weekly: Number(r.weekly),
    schedule: (r.schedule || []).map((x) => ({
      n: x.n, dueDate: x.dueDate, amount: Number(x.amount), capital: Number(x.capital),
      interet: Number(x.interet), paid: !!x.paid, paidDate: x.paidDate || null })),
    document: r.document, signed: r.signed, signedDate: r.signed_date,
    archived: r.archived, archivedAt: r.archived_at, createdAt: r.created_at,
  });
  const denormSchedule = (rows) => rows; // déjà au bon format pour jsonb
  const normDevis = (r) => ({
    id: r.id, prenom: r.prenom, nom: r.nom, tel: r.tel, life: r.life, sujet: r.sujet,
    message: r.message, public: r.is_public, from: r.from_id, status: r.status,
    quote: r.quote, read: r.is_read, createdAt: r.created_at,
  });
  const normContact = (r) => ({
    id: r.id, prenom: r.prenom, nom: r.nom, numero: r.numero, sujet: r.sujet,
    message: r.message, from: r.from_id, read: r.is_read, createdAt: r.created_at,
  });

  /* ---------------- amortissement (hebdomadaire) ---------------- */
  function addDaysISO(y, m, d, add) {
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + add);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  }
  function buildSchedule(principal, weeklyRate, weeks, startISO) {
    principal = Number(principal);
    weeks = Math.max(1, Math.round(Number(weeks)));
    const r = Number(weeklyRate) / 100;
    let payment = r === 0 ? principal / weeks : (principal * r) / (1 - Math.pow(1 + r, -weeks));
    const rows = [];
    let balance = principal;
    const [sy, sm, sd] = startISO.split("-").map(Number);
    for (let n = 1; n <= weeks; n++) {
      const interet = balance * r;
      let capital = payment - interet;
      if (n === weeks) capital = balance;
      const amount = capital + interet;
      balance = Math.max(0, balance - capital);
      rows.push({ n, dueDate: addDaysISO(sy, sm, sd, (n - 1) * 7),
        amount: round2(amount), capital: round2(capital), interet: round2(interet),
        paid: false, paidDate: null });
    }
    return { payment: round2(payment), rows };
  }
  const cPeriods = (c) => c.weeks ?? c.schedule.length;
  const cPayment = (c) => c.weekly ?? 0;
  const cRate = (c) => c.rate ?? 0;
  const cPeriodWord = () => "semaines";

  function contractStats(c) {
    const total = c.schedule.reduce((s, r) => s + r.amount, 0);
    const totalInteret = c.schedule.reduce((s, r) => s + r.interet, 0);
    const paid = c.schedule.filter((r) => r.paid);
    const paidAmount = paid.reduce((s, r) => s + r.amount, 0);
    const n = c.schedule.length;
    const today = todayISO();
    const late = c.schedule.filter((r) => !r.paid && r.dueDate < today).length;
    return {
      total: round2(total), totalInteret: round2(totalInteret),
      paidAmount: round2(paidAmount), remaining: round2(total - paidAmount),
      paidCount: paid.length, count: n, late, nextDue: c.schedule.find((r) => !r.paid) || null,
      done: paid.length === n, progress: n ? paid.length / n : 0,
    };
  }
  function contractStatus(c, s) {
    s = s || contractStats(c);
    if (c.archived) return { key: "archived", label: "Archivé", cls: "arch" };
    if (!c.signed) return { key: "pending", label: "En attente de signature", cls: "pending" };
    if (s.done) return { key: "done", label: "Soldé", cls: "done" };
    if (s.late) return { key: "late", label: s.late + " en retard", cls: "late" };
    return { key: "active", label: "En cours", cls: "active" };
  }

  /* ============================================================
     ROUTAGE
     ============================================================ */
  const siteEl = $("#site"), authView = $("#auth-view"), appEl = $("#app");

  function showSite(page) {
    appEl.hidden = true; authView.hidden = true; siteEl.hidden = false;
    if (page) navigate(page);
    window.scrollTo(0, 0);
  }
  function showAuth() {
    siteEl.hidden = true; appEl.hidden = true; authView.hidden = false;
    $("#register-form").hidden = true; $("#login-form").hidden = false;
  }
  function navigate(page) {
    $$(".page").forEach((p) => (p.hidden = p.id !== "page-" + page));
    $$("#nav-links a").forEach((a) => a.classList.toggle("active", a.dataset.nav === page));
    $("#nav-links").classList.remove("open");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  $$("[data-nav]").forEach((el) => el.addEventListener("click", (e) => { e.preventDefault(); navigate(el.dataset.nav); }));
  $("#nav-burger").addEventListener("click", () => $("#nav-links").classList.toggle("open"));
  $("#open-espace").addEventListener("click", openEspace);
  $("#footer-espace").addEventListener("click", openEspace);
  function openEspace() { if (session) renderApp(); else showAuth(); }
  $("#auth-back").addEventListener("click", () => showSite());
  $("#goto-site").addEventListener("click", () => showSite("accueil"));

  /* ============================================================
     FORMULAIRES PUBLICS (contact + devis) — visiteur autorisé
     ============================================================ */
  $("#contact-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!requireConfig()) return;
    const payload = {
      prenom: $("#ct-prenom").value.trim(), nom: $("#ct-nom").value.trim(),
      numero: $("#ct-num").value.trim(), sujet: $("#ct-sujet").value.trim(),
      message: $("#ct-message").value.trim(), from_id: session ? session.id : null,
    };
    const { error } = await sb.from("contacts").insert(payload);
    if (error) return toast("Erreur à l'envoi : " + error.message);
    e.target.reset();
    toast("Message envoyé — merci, nous vous recontacterons.");
    if (session && session.role === "admin") refresh();
  });

  $("#devis-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!requireConfig()) return;
    const payload = {
      prenom: $("#d-prenom").value.trim(), nom: $("#d-nom").value.trim(),
      tel: $("#d-tel").value.trim(), life: $("#d-life").value.trim(),
      sujet: $("#d-sujet").value.trim(), message: $("#d-message").value.trim(),
      from_id: session ? session.id : null,
    };
    const { error } = await sb.from("devis").insert(payload);
    if (error) return toast("Erreur à l'envoi : " + error.message);
    e.target.reset();
    toast("Demande de devis envoyée — un conseiller vous rappellera.");
    if (session && session.role === "admin") refresh();
  });

  /* ============================================================
     AUTH (Supabase)
     ============================================================ */
  const loginForm = $("#login-form"), registerForm = $("#register-form");
  const USERNAME_RE = /^[a-zA-Z0-9]+_[a-zA-Z0-9]+$/;
  const showErr = (el, msg) => { el.textContent = msg; el.hidden = false; };

  $("#go-register").addEventListener("click", () => { loginForm.hidden = true; registerForm.hidden = false; });
  $("#go-login").addEventListener("click", () => { registerForm.hidden = true; loginForm.hidden = false; });

  registerForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!requireConfig()) return;
    const name = $("#reg-name").value.trim();
    const username = $("#reg-user").value.trim().toLowerCase();
    const pass = $("#reg-pass").value;
    const err = $("#reg-error"); err.hidden = true;
    if (!username || !pass || !name) return;
    if (!USERNAME_RE.test(username))
      return showErr(err, "L'identifiant doit être au format prenom_nom (lettres/chiffres séparés par un « _ »).");
    if (pass.length < 3) return showErr(err, "Mot de passe trop court.");

    const btn = registerForm.querySelector("button[type=submit]"); btn.disabled = true;
    try {
      const { data, error } = await sb.auth.signUp({
        email: emailFor(username), password: pass,
        options: { data: { username, full_name: name } },
      });
      if (error) {
        if (/already registered|exists/i.test(error.message)) return showErr(err, "Cet identifiant est déjà pris.");
        return showErr(err, error.message);
      }
      if (!data.session) {
        // confirmation e-mail probablement activée -> tenter une connexion directe
        const { error: e2 } = await sb.auth.signInWithPassword({ email: emailFor(username), password: pass });
        if (e2) return showErr(err, "Compte créé. Désactivez « Confirm email » dans Supabase, puis connectez-vous.");
      }
      await afterAuth();
    } finally { btn.disabled = false; }
  });

  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!requireConfig()) return;
    const username = $("#login-user").value.trim().toLowerCase();
    const pass = $("#login-pass").value;
    const err = $("#login-error"); err.hidden = true;
    const btn = loginForm.querySelector("button[type=submit]"); btn.disabled = true;
    try {
      const { error } = await sb.auth.signInWithPassword({ email: emailFor(username), password: pass });
      if (error) return showErr(err, "Identifiant ou mot de passe incorrect.");
      await afterAuth();
    } finally { btn.disabled = false; }
  });

  $("#logout-btn").addEventListener("click", async () => {
    if (sb) await sb.auth.signOut();
    session = null;
    DB.contracts = []; DB.devis = []; DB.contacts = []; DB.profiles = [];
    loginForm.reset(); registerForm.reset();
    showSite("accueil");
  });

  // Récupère le profil de l'utilisateur connecté, ouvre le portail.
  async function afterAuth() {
    const { data: ures } = await sb.auth.getUser();
    const user = ures?.user;
    if (!user) return;
    const { data: prof } = await sb.from("profiles").select("*").eq("id", user.id).single();
    if (!prof) { await sb.auth.signOut(); return showErr($("#login-error"), "Compte introuvable. Contactez l'administrateur."); }
    session = { id: prof.id, username: prof.username, name: prof.full_name || prof.username, role: prof.role };
    loginForm.reset(); registerForm.reset();
    await loadData();
    renderApp();
  }

  /* ============================================================
     CHARGEMENT DES DONNÉES (selon le rôle)
     ============================================================ */
  async function loadData() {
    if (!session || !sb) return;
    if (session.role === "admin") {
      const [c, d, m, p] = await Promise.all([
        sb.from("contracts").select("*").order("created_at", { ascending: false }),
        sb.from("devis").select("*").order("created_at", { ascending: false }),
        sb.from("contacts").select("*").order("created_at", { ascending: false }),
        sb.from("profiles").select("*").order("created_at", { ascending: false }),
      ]);
      DB.profiles = p.data || [];
      DB.contracts = (c.data || []).map(normContract);
      DB.devis = (d.data || []).map(normDevis);
      DB.contacts = (m.data || []).map(normContact);
    } else {
      const [c, d] = await Promise.all([
        sb.from("contracts").select("*").eq("client_id", session.id).order("created_at", { ascending: false }),
        sb.from("devis").select("*").eq("from_id", session.id).order("created_at", { ascending: false }),
      ]);
      DB.profiles = [{ id: session.id, username: session.username, full_name: session.name, role: "client" }];
      DB.contracts = (c.data || []).map(normContract);
      DB.devis = (d.data || []).map(normDevis);
      DB.contacts = [];
    }
  }
  async function refresh() {
    await loadData();
    renderClientSpace();
    if (session && session.role === "admin") renderAdmin();
  }

  /* ============================================================
     APP SHELL
     ============================================================ */
  function renderApp() {
    siteEl.hidden = true; authView.hidden = true; appEl.hidden = false;
    const isAdmin = session.role === "admin";
    $("#tab-admin").hidden = !isAdmin;
    $("#user-chip").innerHTML =
      `${escapeHtml(session.name)} <span class="role ${isAdmin ? "admin" : ""}">${isAdmin ? "Administrateur" : "Client"}</span>`;
    switchTab("dossiers");
    renderClientSpace();
    if (isAdmin) renderAdmin();
  }
  $$("#main-tabs .tab").forEach((tab) => tab.addEventListener("click", () => switchTab(tab.dataset.tab)));
  function switchTab(name) {
    $$("#main-tabs .tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    $("#view-dossiers").hidden = name !== "dossiers";
    $("#view-admin").hidden = name !== "admin";
    if (name === "dossiers") renderClientSpace();
    if (name === "admin") renderAdmin();
  }
  $$("#view-admin .subtab").forEach((st) => st.addEventListener("click", () => goToSub(st.dataset.sub)));
  function goToSub(sub) {
    $$("#view-admin .subtab").forEach((x) => x.classList.toggle("active", x.dataset.sub === sub));
    $("#sub-overview").hidden = sub !== "overview";
    $("#sub-devis").hidden = sub !== "devis";
    $("#sub-messages").hidden = sub !== "messages";
    $("#sub-clients").hidden = sub !== "clients";
    $("#sub-newcontract").hidden = sub !== "newcontract";
    $("#sub-template").hidden = sub !== "template";
    $("#sub-archives").hidden = sub !== "archives";
    if (sub === "newcontract") fillClientSelect();
    if (sub === "template") loadTemplateEditor();
    if (sub === "devis") markDevisRead();
    if (sub === "messages") markMessagesRead();
  }

  /* ============================================================
     ESPACE CLIENT
     ============================================================ */
  function renderClientSpace() {
    if (!session) return;
    $("#client-hello").textContent = "Bonjour " + session.name.split(" ")[0];
    const all = DB.contracts;
    const list = all.filter((c) => !c.archived);
    const archived = all.filter((c) => c.archived);

    let totEmprunte = 0, totRembourse = 0, totRestant = 0, totInteret = 0;
    list.forEach((c) => {
      const s = contractStats(c);
      totEmprunte += c.principal; totRembourse += s.paidAmount;
      totRestant += s.remaining; totInteret += s.totalInteret;
    });
    $("#client-sub").textContent = session.role === "admin"
      ? "Vue administrateur — tous les contrats clients" : "Vos contrats de prêt en cours";
    $("#client-summary").innerHTML = `
      ${summaryCard("Capital emprunté", euro(totEmprunte))}
      ${summaryCard("Déjà remboursé", euro(totRembourse), "green")}
      ${summaryCard("Reste à payer", euro(totRestant), "red")}
      ${summaryCard("Dont intérêts (coût)", euro(totInteret), "gold")}`;

    const dPanel = $("#client-devis-panel");
    if (session.role !== "admin") {
      dPanel.hidden = DB.devis.length === 0;
      $("#client-devis").innerHTML = DB.devis.map((d) => devisRow(d, false)).join("");
    } else dPanel.hidden = true;

    const wrap = $("#client-contracts");
    const isAdmin = session.role === "admin";
    let html = list.map((c) => contractCard(c, isAdmin)).join("");
    if (archived.length)
      html += `<div class="section-sep">Dossiers archivés</div>` + archived.map((c) => contractCard(c, isAdmin)).join("");
    wrap.innerHTML = html;
    $("#client-empty").hidden = list.length > 0 || archived.length > 0;
    bindContractCards(wrap);
  }
  const summaryCard = (label, value, cls = "") =>
    `<div class="summary-card ${cls}"><span class="label">${label}</span><span class="value">${value}</span></div>`;

  function contractCard(c, showClient) {
    const s = contractStats(c), st = contractStatus(c, s);
    const clientLine = showClient ? `<div class="cc-client">Client : ${escapeHtml(clientName(c.client))}</div>` : "";
    return `<div class="contract-card" data-id="${c.id}">
      <div class="cc-head"><div class="cc-title">${escapeHtml(c.label)}</div><span class="pill ${st.cls}">${st.label}</span></div>
      ${clientLine}
      <div class="cc-amount">${euro(c.principal)}</div>
      <div class="cc-amount-sub">Capital emprunté · ${pct(cRate(c))} / sem. sur ${cPeriods(c)} ${cPeriodWord(c)}</div>
      <div class="cc-row"><span>Échéance / sem.</span><span>${euro(cPayment(c))}</span></div>
      <div class="cc-row"><span>Déjà remboursé</span><span class="pos">${euro(s.paidAmount)}</span></div>
      <div class="cc-row"><span>Reste à payer</span><span class="neg">${euro(s.remaining)}</span></div>
      <div class="cc-row"><span>Coût total des intérêts</span><span>${euro(s.totalInteret)}</span></div>
      <div class="cc-row"><span>Prochaine échéance</span><span>${s.nextDue ? fmtDate(s.nextDue.dueDate) : "—"}</span></div>
      <div class="progress"><i style="width:${(s.progress * 100).toFixed(1)}%"></i></div>
      <div class="progress-label"><span>${s.paidCount} / ${s.count} échéances</span><span>${(s.progress * 100).toFixed(0)} %</span></div>
    </div>`;
  }
  function bindContractCards(root) {
    $$(".contract-card", root).forEach((card) => card.addEventListener("click", () => openContract(card.dataset.id)));
  }

  /* ============================================================
     MODALE CONTRAT
     ============================================================ */
  const contractModal = $("#contract-modal");
  $("#cm-close").addEventListener("click", () => (contractModal.hidden = true));
  contractModal.addEventListener("click", (e) => { if (e.target === contractModal) contractModal.hidden = true; });

  function openContract(id) {
    const c = DB.contracts.find((x) => x.id === id);
    if (!c) return;
    const s = contractStats(c);
    const isAdmin = session.role === "admin";
    const isOwner = session.id === c.client;
    const canPay = isAdmin && c.signed && !c.archived;

    $("#cm-title").textContent = c.label + " — " + clientName(c.client);

    let banner;
    if (c.archived) banner = `<div class="cm-banner arch">Dossier archivé le ${fmtDate(c.archivedAt)}.</div>`;
    else if (!c.signed) banner = `<div class="cm-banner pending">⏳ Dossier <strong>en attente</strong> : le contrat doit être signé par le client avant toute prise d'effet.</div>`;
    else banner = `<div class="cm-banner ok">✔ Contrat signé par le client le ${fmtDate(c.signedDate)}.</div>`;

    const doc = c.document
      ? `<div class="cm-doc"><span>📄 ${escapeHtml(c.document.name)}</span>
           <a class="btn btn-ghost btn-sm" href="${c.document.dataURL}" target="_blank" rel="noopener">Ouvrir</a>
           <a class="btn btn-ghost btn-sm" href="${c.document.dataURL}" download="${escapeHtml(c.document.name)}">Télécharger</a></div>`
      : `<div class="cm-doc"><span class="muted">Aucun document joint.</span></div>`;

    const rows = c.schedule.map((r) => {
      const late = !r.paid && r.dueDate < todayISO();
      const status = r.paid ? `<span class="sched-status pos">✔ Payé${r.paidDate ? " · " + fmtDate(r.paidDate) : ""}</span>`
        : late ? `<span class="sched-status neg">● En retard</span>` : `<span class="sched-status muted">○ À venir</span>`;
      const btn = canPay ? (r.paid ? `<button class="btn btn-ghost btn-sm" data-toggle="${r.n}">Annuler</button>`
        : `<button class="btn btn-success btn-sm" data-toggle="${r.n}">Marquer payé</button>`) : "";
      return `<tr class="${r.paid ? "paid" : ""}"><td>#${r.n}</td><td>${fmtDate(r.dueDate)}</td><td>${euro(r.amount)}</td>
        <td>${euro(r.capital)}</td><td>${euro(r.interet)}</td><td>${status}</td>${isAdmin ? `<td>${btn}</td>` : ""}</tr>`;
    }).join("");

    let leftActions = "", rightActions = "";
    if (isAdmin) {
      leftActions += `<button class="btn btn-danger" id="cm-delete">Supprimer ce contrat</button>`;
      if (c.archived) leftActions += `<button class="btn btn-ghost" id="cm-unarchive">Désarchiver</button>`;
      else if (s.done && c.signed) rightActions += `<button class="btn btn-primary" id="cm-archive">Archiver le dossier</button>`;
      else if (canPay) rightActions += `<button class="btn btn-success" id="cm-paynext">Encaisser l'échéance de la semaine</button>`;
    }
    if (isOwner && !c.signed && !c.archived)
      rightActions += `<button class="btn btn-primary" id="cm-sign">✍ Signer le contrat</button>`;
    const actions = (leftActions || rightActions)
      ? `<div class="modal-actions" style="justify-content:space-between"><div class="actions-group">${leftActions}</div><div class="actions-group">${rightActions}</div></div>` : "";

    $("#cm-body").innerHTML = `
      ${banner}${doc}
      <div class="cm-summary">
        ${cmCell("Capital emprunté", euro(c.principal))}${cmCell("Taux / semaine", pct(cRate(c)))}
        ${cmCell("Durée", cPeriods(c) + " " + cPeriodWord(c))}${cmCell("Échéance hebdo.", euro(cPayment(c)))}
        ${cmCell("Total à rembourser", euro(s.total))}${cmCell("Coût des intérêts", euro(s.totalInteret))}
        ${cmCell("Déjà remboursé", euro(s.paidAmount))}${cmCell("Reste à payer", euro(s.remaining))}
      </div>
      <div class="progress"><i style="width:${(s.progress * 100).toFixed(1)}%"></i></div>
      <div class="progress-label" style="margin-bottom:16px"><span>${s.paidCount} / ${s.count} échéances réglées</span><span>${(s.progress * 100).toFixed(0)} %</span></div>
      <div class="sched-wrap"><table class="schedule"><thead><tr><th>Sem.</th><th>Date</th><th>Échéance</th><th>Capital</th><th>Intérêts</th><th>Statut</th>${isAdmin ? "<th></th>" : ""}</tr></thead><tbody>${rows}</tbody></table></div>
      ${actions}`;

    if (canPay) {
      $$("#cm-body [data-toggle]").forEach((b) => b.addEventListener("click", () => togglePaid(id, Number(b.dataset.toggle))));
      const payNext = $("#cm-paynext"); if (payNext) payNext.addEventListener("click", () => payNextInstallment(id));
    }
    if (isAdmin) {
      $("#cm-delete").addEventListener("click", () => confirmDeleteContract(id));
      const arch = $("#cm-archive"); if (arch) arch.addEventListener("click", () => archiveContract(id, true));
      const unarch = $("#cm-unarchive"); if (unarch) unarch.addEventListener("click", () => archiveContract(id, false));
    }
    const sign = $("#cm-sign"); if (sign) sign.addEventListener("click", () => signContract(id));
    contractModal.hidden = false;
  }
  const cmCell = (label, value) => `<div class="cm-cell"><span class="label">${label}</span><span class="value">${value}</span></div>`;

  async function saveSchedule(id, schedule) {
    const { error } = await sb.from("contracts").update({ schedule: denormSchedule(schedule) }).eq("id", id);
    if (error) { toast("Erreur : " + error.message); return false; }
    return true;
  }
  async function togglePaid(id, n) {
    const c = DB.contracts.find((x) => x.id === id); if (!c) return;
    const row = c.schedule.find((r) => r.n === n); if (!row) return;
    row.paid = !row.paid; row.paidDate = row.paid ? todayISO() : null;
    if (!(await saveSchedule(id, c.schedule))) return;
    await refresh(); openContract(id);
    toast(row.paid ? `Échéance #${n} encaissée` : `Paiement #${n} annulé`);
  }
  async function payNextInstallment(id) {
    const c = DB.contracts.find((x) => x.id === id); if (!c) return;
    const next = c.schedule.find((r) => !r.paid); if (!next) return;
    next.paid = true; next.paidDate = todayISO();
    if (!(await saveSchedule(id, c.schedule))) return;
    await refresh(); openContract(id);
    toast(`Échéance semaine #${next.n} encaissée (${euro(next.amount)})`);
  }
  async function signContract(id) {
    const { error } = await sb.rpc("sign_contract", { p_id: id });
    if (error) return toast("Signature impossible : " + error.message);
    await refresh(); openContract(id);
    toast("Contrat signé ✔ — le dossier est désormais actif.");
  }
  async function archiveContract(id, archived) {
    const c = DB.contracts.find((x) => x.id === id); if (!c) return;
    if (archived && !contractStats(c).done) return toast("Le dossier ne peut être archivé qu'une fois toutes les échéances réglées.");
    const patch = archived ? { archived: true, archived_at: todayISO() } : { archived: false, archived_at: null };
    const { error } = await sb.from("contracts").update(patch).eq("id", id);
    if (error) return toast("Erreur : " + error.message);
    await refresh(); openContract(id);
    toast(archived ? "Dossier archivé." : "Dossier désarchivé.");
  }

  /* ============================================================
     ADMINISTRATION
     ============================================================ */
  function renderAdmin() {
    if (!session || session.role !== "admin") return;
    const contracts = DB.contracts.filter((c) => !c.archived);
    const archived = DB.contracts.filter((c) => c.archived);

    let principal = 0, encaisse = 0, du = 0, retards = 0, attente = 0;
    contracts.forEach((c) => {
      const s = contractStats(c);
      principal += c.principal; encaisse += s.paidAmount; du += s.remaining;
      retards += s.late; if (!c.signed) attente += 1;
    });
    const newDevis = DB.devis.filter((d) => !d.read).length;
    const newMsg = DB.contacts.filter((m) => !m.read).length;

    $("#admin-summary").innerHTML = `
      ${summaryCard("Contrats actifs", String(contracts.length))}
      ${summaryCard("En attente de signature", String(attente), attente ? "gold" : "")}
      ${summaryCard("Devis à traiter", String(DB.devis.filter((d) => d.status === "new").length), newDevis ? "gold" : "")}
      ${summaryCard("Capital prêté", euro(principal), "gold")}
      ${summaryCard("Encaissé à ce jour", euro(encaisse), "green")}
      ${summaryCard("Encours restant dû", euro(du), "red")}
      ${summaryCard("Échéances en retard", String(retards), retards ? "red" : "")}
      ${summaryCard("Messages reçus", String(DB.contacts.length))}`;

    setBadge("#badge-devis", newDevis);
    setBadge("#badge-msg", newMsg);

    const allWrap = $("#admin-all-contracts");
    if (!contracts.length) { allWrap.innerHTML = ""; $("#admin-empty").hidden = false; }
    else { $("#admin-empty").hidden = true; allWrap.innerHTML = contracts.map((c) => contractCard(c, true)).join(""); bindContractCards(allWrap); }

    const archWrap = $("#admin-archives");
    if (!archived.length) { archWrap.innerHTML = ""; $("#archives-empty").hidden = false; }
    else { $("#archives-empty").hidden = true; archWrap.innerHTML = archived.map((c) => contractCard(c, true)).join(""); bindContractCards(archWrap); }

    renderAdminDevis(); renderAdminMessages(); renderClientsList(); fillClientSelect();
  }
  function setBadge(sel, n) { const el = $(sel); if (!el) return; el.hidden = !n; el.textContent = n; }

  async function markDevisRead() {
    if (!DB.devis.some((d) => !d.read)) return;
    await sb.from("devis").update({ is_read: true }).eq("is_read", false);
    DB.devis.forEach((d) => (d.read = true)); setBadge("#badge-devis", 0);
  }
  async function markMessagesRead() {
    if (!DB.contacts.some((m) => !m.read)) return;
    await sb.from("contacts").update({ is_read: true }).eq("is_read", false);
    DB.contacts.forEach((m) => (m.read = true)); setBadge("#badge-msg", 0);
  }

  /* ---------------- devis (admin) ---------------- */
  function devisRow(d, admin) {
    const statusPill = d.status === "closed"
      ? `<span class="pill arch">Traité</span>` : `<span class="pill new">À rappeler</span>`;
    const lifeLine = d.life ? `<div class="lr-field"><b>Profil Life :</b> <a href="${escapeHtml(d.life)}" target="_blank" rel="noopener" class="link-btn">${escapeHtml(d.life)}</a></div>` : "";
    const who = d.from ? "@" + escapeHtml(usernameById(d.from) || "client") : "visiteur";
    const actions = admin ? `<div class="lr-actions">
        ${d.status !== "closed" ? `<button class="btn btn-success btn-sm" data-devis-close="${d.id}">Marquer traité</button>` : `<button class="btn btn-ghost btn-sm" data-devis-reopen="${d.id}">À rappeler</button>`}
        <button class="btn btn-danger btn-sm" data-devis-del="${d.id}">Supprimer</button></div>` : "";
    return `<div class="list-row ${admin && !d.read ? "unread" : ""}">
      <div class="lr-top"><span class="lr-title">${escapeHtml(d.sujet || "Demande de devis")}</span>
        <span class="actions-group">${statusPill}</span></div>
      <div class="lr-meta">${escapeHtml(d.prenom)} ${escapeHtml(d.nom)} · 📞 ${escapeHtml(d.tel || "—")} · ${fmtDateTime(d.createdAt)} · ${who}</div>
      ${lifeLine}${d.message ? `<div class="lr-msg">${escapeHtml(d.message)}</div>` : ""}${actions}</div>`;
  }
  function renderAdminDevis() {
    const wrap = $("#admin-devis");
    $("#admin-devis-empty").hidden = DB.devis.length > 0;
    wrap.innerHTML = DB.devis.map((d) => devisRow(d, true)).join("");
    $$("[data-devis-close]", wrap).forEach((b) => b.addEventListener("click", () => setDevisStatus(b.dataset.devisClose, "closed")));
    $$("[data-devis-reopen]", wrap).forEach((b) => b.addEventListener("click", () => setDevisStatus(b.dataset.devisReopen, "new")));
    $$("[data-devis-del]", wrap).forEach((b) => b.addEventListener("click", () => deleteDevis(b.dataset.devisDel)));
  }
  async function setDevisStatus(id, status) {
    const { error } = await sb.from("devis").update({ status }).eq("id", id);
    if (error) return toast("Erreur : " + error.message);
    await refresh(); toast("Demande mise à jour.");
  }
  function deleteDevis(id) {
    $("#confirm-title").textContent = "Supprimer la demande de devis";
    $("#confirm-text").textContent = "Cette demande de devis sera définitivement supprimée.";
    confirmAction = async () => {
      const { error } = await sb.from("devis").delete().eq("id", id);
      if (error) return toast("Erreur : " + error.message);
      await refresh(); toast("Devis supprimé.");
    };
    confirmModal.hidden = false;
  }

  /* ---------------- messages (admin) ---------------- */
  function renderAdminMessages() {
    const wrap = $("#admin-messages");
    $("#admin-messages-empty").hidden = DB.contacts.length > 0;
    wrap.innerHTML = DB.contacts.map((m) => `
      <div class="list-row ${!m.read ? "unread" : ""}">
        <div class="lr-top"><span class="lr-title">${escapeHtml(m.sujet || "(sans sujet)")}</span><span class="lr-meta">${fmtDateTime(m.createdAt)}</span></div>
        <div class="lr-meta">${escapeHtml(m.prenom)} ${escapeHtml(m.nom)} · 📞 ${escapeHtml(m.numero || "—")}${m.from ? " · @" + escapeHtml(usernameById(m.from) || "client") : " · visiteur"}</div>
        <div class="lr-msg">${escapeHtml(m.message)}</div>
        <div class="lr-actions"><button class="btn btn-danger btn-sm" data-msg-del="${m.id}">Supprimer</button></div></div>`).join("");
    $$("[data-msg-del]", wrap).forEach((b) => b.addEventListener("click", () => {
      $("#confirm-title").textContent = "Supprimer le message";
      $("#confirm-text").textContent = "Ce message sera définitivement supprimé.";
      confirmAction = async () => {
        const { error } = await sb.from("contacts").delete().eq("id", b.dataset.msgDel);
        if (error) return toast("Erreur : " + error.message);
        await refresh(); toast("Message supprimé.");
      };
      confirmModal.hidden = false;
    }));
  }

  /* ---------------- clients (admin) ---------------- */
  function renderClientsList() {
    const users = DB.profiles.filter((u) => u.role !== "admin");
    const wrap = $("#admin-clients");
    if (!users.length) { wrap.innerHTML = `<p class="empty">Aucun client inscrit pour le moment.</p>`; return; }
    wrap.innerHTML = users.map((u) => {
      const cs = DB.contracts.filter((c) => c.client === u.id);
      let restant = 0; cs.forEach((c) => (restant += contractStats(c).remaining));
      const initials = (u.full_name || u.username).split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
      return `<div class="client-row">
        <div class="client-avatar">${escapeHtml(initials || "?")}</div>
        <div class="client-info"><div class="name">${escapeHtml(u.full_name || u.username)}</div>
          <div class="meta">@${escapeHtml(u.username)} · ${cs.length} contrat(s)</div></div>
        <div class="client-stat"><div class="muted">Reste à payer</div><div class="big">${euro(restant)}</div></div>
        <button class="btn btn-danger btn-sm" data-del-client="${escapeHtml(u.id)}">Supprimer</button></div>`;
    }).join("");
    $$("#admin-clients [data-del-client]").forEach((b) => b.addEventListener("click", () => confirmDeleteClient(b.dataset.delClient)));
  }
  function confirmDeleteClient(id) {
    const u = profileById(id); if (!u) return;
    const nb = DB.contracts.filter((c) => c.client === id).length;
    $("#confirm-title").textContent = "Supprimer le compte client";
    $("#confirm-text").textContent = `Le profil de ${u.full_name || u.username} (@${u.username}) sera supprimé` + (nb ? `, ainsi que ses ${nb} contrat(s).` : ".");
    confirmAction = async () => {
      const { error } = await sb.from("profiles").delete().eq("id", id);
      if (error) return toast("Erreur : " + error.message);
      await refresh(); toast("Compte client supprimé.");
    };
    confirmModal.hidden = false;
  }
  function fillClientSelect() {
    const sel = $("#c-client"); if (!sel) return;
    const users = DB.profiles.filter((u) => u.role !== "admin");
    const current = sel.value;
    sel.innerHTML = `<option value="" disabled ${users.length ? "" : "selected"}>— choisir un client —</option>` +
      users.map((u) => `<option value="${escapeHtml(u.id)}">${escapeHtml(u.full_name || u.username)} (@${escapeHtml(u.username)})</option>`).join("");
    if (current) sel.value = current;
  }

  /* ---------------- nouveau contrat + modèle ---------------- */
  const contractForm = $("#contract-form");
  $("#c-start").value = todayISO();
  $("#c-simulate").addEventListener("click", renderPreview);
  ["c-principal", "c-rate", "c-weeks", "c-start"].forEach((id) => $("#" + id).addEventListener("input", renderPreview));

  const TPL_VARS = [
    ["{{reference}}", "Référence du dossier"], ["{{date_jour}}", "Date du jour"],
    ["{{client_nom}}", "Nom du client"], ["{{client_id}}", "Identifiant du client"],
    ["{{capital}}", "Capital emprunté"], ["{{taux}}", "Taux par semaine"],
    ["{{semaines}}", "Durée (semaines)"], ["{{echeance}}", "Échéance hebdomadaire"],
    ["{{total}}", "Total à rembourser"], ["{{interets}}", "Coût des intérêts"],
    ["{{date_premiere}}", "Date 1re échéance"],
  ];
  const DEFAULT_TEMPLATE =
`CONTRAT DE PRÊT — NORDHAVEN CAPITAL

Référence du dossier : {{reference}}
Date d'établissement : {{date_jour}}

ENTRE LES PARTIES
Le Prêteur : Nordhaven Capital, société de financement.
L'Emprunteur : {{client_nom}} (identifiant : {{client_id}}).

CONDITIONS DU PRÊT
- Capital emprunté : {{capital}}
- Taux d'intérêt par semaine : {{taux}}
- Durée : {{semaines}} semaines
- Échéance hebdomadaire : {{echeance}}
- 1re échéance : {{date_premiere}}
- Coût total des intérêts : {{interets}}
- Montant total à rembourser : {{total}}

ENGAGEMENTS
1. L'Emprunteur s'engage à rembourser le capital majoré des intérêts par échéances hebdomadaires aux dates de l'échéancier annexé.
2. Tout retard de paiement pourra entraîner des pénalités fixées par le Prêteur.
3. Le présent contrat ne prend effet qu'à compter de sa signature par l'Emprunteur. Tant qu'il n'est pas signé, le dossier demeure « en attente ».
4. Le remboursement anticipé total du capital restant dû est possible à tout moment.

Fait à ____________________, le {{date_jour}}.

Le Prêteur — Nordhaven Capital            L'Emprunteur (lu et approuvé, signature)`;

  let templateCache = null;
  async function getTemplate() {
    if (templateCache != null) return templateCache;
    const { data } = await sb.from("app_settings").select("value").eq("key", TPL_KEY).maybeSingle();
    templateCache = data?.value || DEFAULT_TEMPLATE;
    return templateCache;
  }
  async function setTemplate(t) {
    templateCache = t;
    const { error } = await sb.from("app_settings").upsert({ key: TPL_KEY, value: t });
    if (error) toast("Erreur : " + error.message);
  }
  const fillTemplate = (tpl, data) => tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in data ? data[k] : m));

  function docHtml(title, text) {
    return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>${escapeHtml(title)}</title><style>
body{font-family:Georgia,'Times New Roman',serif;max-width:780px;margin:0 auto;padding:48px;color:#1a1a1a;line-height:1.55;white-space:pre-wrap}
.noprint{margin-top:28px}@media print{.noprint{display:none}}
button{font-family:sans-serif;background:#111;color:#fff;border:none;padding:10px 18px;border-radius:6px;cursor:pointer}
</style></head><body>${escapeHtml(text)}<div class="noprint"><button onclick="window.print()">Imprimer / Enregistrer en PDF</button></div></body></html>`;
  }
  function contractMergeData(f) {
    const u = profileById(f.client);
    const { payment, rows } = buildSchedule(f.principal || 0, f.weeklyRate || 0, Math.max(1, f.weeks || 1), f.start || todayISO());
    const total = rows.reduce((s, r) => s + r.amount, 0);
    const interets = rows.reduce((s, r) => s + r.interet, 0);
    return {
      reference: "NH-" + Date.now().toString(36).toUpperCase(), date_jour: fmtDate(todayISO()),
      client_nom: u ? (u.full_name || u.username) : "—", client_id: u ? u.username : "—",
      capital: euro(f.principal || 0), taux: pct(f.weeklyRate || 0) + " / semaine",
      semaines: String(f.weeks || 0), echeance: euro(payment),
      total: euro(total), interets: euro(interets), date_premiere: fmtDate(f.start),
    };
  }
  $("#c-doc-gen").addEventListener("click", async () => {
    $("#c-doc-content").value = fillTemplate(await getTemplate(), contractMergeData(readForm()));
  });
  $("#c-doc-editmodel").addEventListener("click", () => goToSub("template"));

  async function loadTemplateEditor() {
    $("#tpl-editor").value = await getTemplate();
    $("#tpl-vars").innerHTML = TPL_VARS.map(([v, label]) => `<code class="tpl-var" title="${label}">${v}</code>`).join("");
  }
  $("#tpl-save").addEventListener("click", async () => { await setTemplate($("#tpl-editor").value); toast("Modèle enregistré."); });
  $("#tpl-reset").addEventListener("click", async () => { $("#tpl-editor").value = DEFAULT_TEMPLATE; await setTemplate(DEFAULT_TEMPLATE); toast("Modèle réinitialisé."); });

  function readForm() {
    return { client: $("#c-client").value, label: $("#c-label").value.trim(),
      principal: Number($("#c-principal").value), weeklyRate: Number($("#c-rate").value),
      weeks: Number($("#c-weeks").value), start: $("#c-start").value };
  }
  function renderPreview() {
    const f = readForm(), box = $("#c-preview");
    if (!(f.principal > 0) || !(f.weeks >= 1) || !f.start) { box.innerHTML = ""; return; }
    const { payment, rows } = buildSchedule(f.principal, f.weeklyRate, f.weeks, f.start);
    const total = rows.reduce((s, r) => s + r.amount, 0);
    const interets = rows.reduce((s, r) => s + r.interet, 0);
    box.innerHTML = `<div class="preview-grid">
      <div class="preview-cell"><span class="label">Échéance hebdo.</span><span class="value">${euro(payment)}</span></div>
      <div class="preview-cell"><span class="label">Total à rembourser</span><span class="value">${euro(total)}</span></div>
      <div class="preview-cell"><span class="label">Coût des intérêts</span><span class="value">${euro(interets)}</span></div>
      <div class="preview-cell"><span class="label">Dernière échéance</span><span class="value">${fmtDate(rows[rows.length - 1].dueDate)}</span></div></div>`;
  }

  contractForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!requireConfig()) return;
    const f = readForm();
    if (!f.client) return toast("Choisissez un client.");
    if (!(f.principal > 0)) return toast("Capital invalide.");
    if (!(f.weeks >= 1)) return toast("Durée invalide.");
    const text = $("#c-doc-content").value.trim();
    if (!text) return toast("Générez le document du contrat depuis le modèle avant de créer le dossier.");

    const { payment, rows } = buildSchedule(f.principal, f.weeklyRate, f.weeks, f.start);
    const docName = "Contrat - " + clientName(f.client) + " - " + todayISO() + ".html";
    const document_ = { name: docName, type: "text/html", text,
      dataURL: "data:text/html;charset=utf-8," + encodeURIComponent(docHtml(docName, text)), generated: true };
    const payload = {
      client_id: f.client, label: f.label || "Prêt", principal: round2(f.principal),
      rate: f.weeklyRate, weeks: f.weeks, start_date: f.start, weekly: payment,
      schedule: rows, document: document_, signed: false,
    };
    const btn = contractForm.querySelector("button[type=submit]"); btn.disabled = true;
    try {
      const { error } = await sb.from("contracts").insert(payload);
      if (error) return toast("Erreur : " + error.message);
      contractForm.reset();
      $("#c-start").value = todayISO(); $("#c-preview").innerHTML = ""; $("#c-doc-content").value = "";
      toast("Contrat créé pour " + clientName(f.client) + " — en attente de signature.");
      await refresh(); goToSub("overview");
    } finally { btn.disabled = false; }
  });

  /* ---------------- confirmation ---------------- */
  const confirmModal = $("#confirm-modal");
  let confirmAction = null;
  $("#confirm-cancel").addEventListener("click", () => (confirmModal.hidden = true));
  $("#confirm-ok").addEventListener("click", () => {
    const a = confirmAction;
    confirmModal.hidden = true; confirmAction = null;
    if (a) a();
  });
  function confirmDeleteContract(id) {
    const c = DB.contracts.find((x) => x.id === id); if (!c) return;
    $("#confirm-title").textContent = "Supprimer le contrat";
    $("#confirm-text").textContent = `Le contrat « ${c.label} » de ${clientName(c.client)} sera définitivement supprimé.`;
    confirmAction = async () => {
      const { error } = await sb.from("contracts").delete().eq("id", id);
      if (error) return toast("Erreur : " + error.message);
      contractModal.hidden = true; await refresh(); toast("Contrat supprimé.");
    };
    confirmModal.hidden = false;
  }

  /* ============================================================
     INIT
     ============================================================ */
  (async function init() {
    navigate("accueil");
    showSite();
    if (!sb) return;
    // restaure une session existante
    const { data } = await sb.auth.getSession();
    if (data?.session) {
      const { data: prof } = await sb.from("profiles").select("*").eq("id", data.session.user.id).single();
      if (prof) {
        session = { id: prof.id, username: prof.username, name: prof.full_name || prof.username, role: prof.role };
        await loadData();
        // on reste sur le site public ; l'utilisateur ouvre l'espace via le bouton
      }
    }
  })();
})();
