-- ============================================================================
--  NORDHAVEN CAPITAL — Schéma Supabase (PostgreSQL)
--  À exécuter dans Supabase : Dashboard > SQL Editor > New query > Run.
--  Sécurité : mots de passe gérés par Supabase Auth (bcrypt, côté serveur).
--  RLS (Row Level Security) : un client ne voit QUE ses propres données ;
--  le rôle admin est vérifié côté serveur, impossible à usurper depuis le navigateur.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) PROFILS  (1 ligne par compte ; lié à auth.users)
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  username    text unique not null,
  full_name   text not null default '',
  role        text not null default 'client' check (role in ('client','admin')),
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2) CONTRATS DE PRÊT
-- ---------------------------------------------------------------------------
create table if not exists public.contracts (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references public.profiles(id) on delete cascade,
  label        text not null default 'Prêt',
  principal    numeric not null,
  rate         numeric not null default 0,   -- taux par semaine (%)
  weeks        integer not null,
  start_date   date not null,
  weekly       numeric not null,             -- échéance hebdomadaire
  schedule     jsonb not null,               -- échéancier complet
  document     jsonb,                         -- {name,type,text,dataURL}
  signed       boolean not null default false,
  signed_date  date,
  archived     boolean not null default false,
  archived_at  date,
  created_at   timestamptz not null default now()
);
create index if not exists contracts_client_idx on public.contracts(client_id);

-- ---------------------------------------------------------------------------
-- 3) DEMANDES DE DEVIS  (public OU privé ; visiteur anonyme autorisé)
-- ---------------------------------------------------------------------------
create table if not exists public.devis (
  id          uuid primary key default gen_random_uuid(),
  prenom      text not null default '',
  nom         text not null default '',
  tel         text not null default '',
  life        text not null default '',
  sujet       text not null default '',
  message     text not null default '',
  is_public   boolean not null default false,
  from_id     uuid references public.profiles(id) on delete set null,
  status      text not null default 'new' check (status in ('new','quoted','closed')),
  quote       text not null default '',
  is_read     boolean not null default false,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 4) MESSAGES DE CONTACT  (visiteur anonyme autorisé)
-- ---------------------------------------------------------------------------
create table if not exists public.contacts (
  id          uuid primary key default gen_random_uuid(),
  prenom      text not null default '',
  nom         text not null default '',
  numero      text not null default '',
  sujet       text not null default '',
  message     text not null default '',
  from_id     uuid references public.profiles(id) on delete set null,
  is_read     boolean not null default false,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 5) RÉGLAGES  (clé/valeur ; ex : modèle de contrat) — admin uniquement
-- ---------------------------------------------------------------------------
create table if not exists public.app_settings (
  key   text primary key,
  value text not null default ''
);

-- ============================================================================
--  FONCTIONS
-- ============================================================================

-- Vrai si l'appelant est administrateur (vérifié côté serveur).
create or replace function public.is_admin()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- À l'inscription : crée le profil depuis les métadonnées, force l'admin réservé.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  uname text := lower(coalesce(new.raw_user_meta_data->>'username',''));
begin
  insert into public.profiles (id, username, full_name, role)
  values (
    new.id,
    uname,
    coalesce(new.raw_user_meta_data->>'full_name',''),
    case when uname = 'lautaro_castillo' then 'admin' else 'client' end
  );
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Signature d'un contrat par son titulaire (et lui seul).
create or replace function public.sign_contract(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.contracts
     set signed = true, signed_date = current_date
   where id = p_id and client_id = auth.uid() and signed = false and archived = false;
  if not found then
    raise exception 'Contrat introuvable, déjà signé, ou non autorisé.';
  end if;
end; $$;

-- ============================================================================
--  RLS — activation + politiques
-- ============================================================================
alter table public.profiles     enable row level security;
alter table public.contracts    enable row level security;
alter table public.devis        enable row level security;
alter table public.contacts     enable row level security;
alter table public.app_settings enable row level security;

-- ---- profiles ----
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select
  using (id = auth.uid() or public.is_admin());
drop policy if exists profiles_delete on public.profiles;
create policy profiles_delete on public.profiles for delete
  using (public.is_admin());
-- (l'insertion est faite par le trigger en SECURITY DEFINER ; pas de policy insert nécessaire)

-- ---- contracts ----
drop policy if exists contracts_select on public.contracts;
create policy contracts_select on public.contracts for select
  using (client_id = auth.uid() or public.is_admin());
drop policy if exists contracts_insert on public.contracts;
create policy contracts_insert on public.contracts for insert
  with check (public.is_admin());
drop policy if exists contracts_update on public.contracts;
create policy contracts_update on public.contracts for update
  using (public.is_admin());
drop policy if exists contracts_delete on public.contracts;
create policy contracts_delete on public.contracts for delete
  using (public.is_admin());

-- ---- devis ----
drop policy if exists devis_select on public.devis;
create policy devis_select on public.devis for select
  using (is_public = true or from_id = auth.uid() or public.is_admin());
drop policy if exists devis_insert on public.devis;
create policy devis_insert on public.devis for insert
  with check (from_id is null or from_id = auth.uid());
drop policy if exists devis_update on public.devis;
create policy devis_update on public.devis for update
  using (public.is_admin());
drop policy if exists devis_delete on public.devis;
create policy devis_delete on public.devis for delete
  using (public.is_admin());

-- ---- contacts ----
drop policy if exists contacts_select on public.contacts;
create policy contacts_select on public.contacts for select
  using (public.is_admin());
drop policy if exists contacts_insert on public.contacts;
create policy contacts_insert on public.contacts for insert
  with check (from_id is null or from_id = auth.uid());
drop policy if exists contacts_delete on public.contacts;
create policy contacts_delete on public.contacts for delete
  using (public.is_admin());

-- ---- app_settings ----
drop policy if exists settings_select on public.app_settings;
create policy settings_select on public.app_settings for select
  using (public.is_admin());
drop policy if exists settings_write on public.app_settings;
create policy settings_write on public.app_settings for all
  using (public.is_admin()) with check (public.is_admin());

-- ============================================================================
--  GRANTS  (RLS gouverne les lignes ; ces grants donnent l'accès aux tables)
-- ============================================================================
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on
  public.profiles, public.contracts, public.devis, public.contacts, public.app_settings
  to authenticated;
-- Visiteur anonyme : déposer un devis / un message, lire les devis publics.
grant insert on public.devis, public.contacts to anon;
grant select on public.devis to anon;
grant execute on function public.is_admin() to anon, authenticated;
grant execute on function public.sign_contract(uuid) to authenticated;

-- ============================================================================
--  Terminé. Pensez ensuite à :
--   - Authentication > Providers > Email : activer, et DÉSACTIVER "Confirm email"
--     (les comptes utilisent un identifiant prenom_nom, pas un vrai e-mail).
--   - Copier Project URL + clé anon (Settings > API) dans config.js du site.
-- ============================================================================
