# Nordhaven Capital — Mise en ligne sécurisée

Le site utilise **Supabase** (authentification + base de données) pour que la connexion
soit réellement sécurisée :

- Les mots de passe sont **chiffrés côté serveur** (bcrypt) par Supabase — ils ne sont
  **jamais** stockés dans le navigateur et sont **introuvables** via les outils développeur.
- Grâce aux règles **RLS** (Row Level Security), **chaque client ne peut lire que ses propres
  contrats**. Impossible de se déclarer administrateur depuis la console.
- Le compte **`lautaro_castillo`** est automatiquement administrateur (forcé côté serveur).

---

## 1. Créer le projet Supabase

1. Va sur https://supabase.com → **New project** (note bien le mot de passe de la base).
2. Attends que le projet soit prêt (~2 min).

## 2. Créer les tables et la sécurité

1. Dans Supabase : menu **SQL Editor** → **New query**.
2. Copie-colle **tout** le contenu de [`supabase-schema.sql`](supabase-schema.sql).
3. Clique **Run**. Tu dois voir « Success ».

## 3. Activer la connexion par mot de passe

1. Menu **Authentication** → **Providers** → **Email** : active-le.
2. **Désactive « Confirm email »** (les comptes utilisent un identifiant `prenom_nom`,
   pas une vraie adresse e-mail, donc aucune confirmation n'est possible).
   - Selon la version : *Authentication → Sign In / Providers → Email → décocher
     « Confirm email »*, ou *Authentication → Settings → « Enable email confirmations » = OFF*.

## 4. Brancher le site sur ton projet

1. Dans Supabase : **Settings → API**.
2. Copie **Project URL** et la clé **anon public**.
3. Ouvre [`config.js`](config.js) et remplace les deux valeurs :

   ```js
   window.NORDHAVEN_CONFIG = {
     SUPABASE_URL: "https://xxxxxxxx.supabase.co",
     SUPABASE_ANON_KEY: "eyJhbGciOi....(longue clé)",
   };
   ```

   > La clé **anon** est publique par conception : pas de risque à la laisser dans le code.
   > N'utilise **jamais** la clé *service_role* ici.

## 5. Créer le compte administrateur

1. Ouvre le site → **Espace client** → **Créer un compte**.
2. Identifiant : **`lautaro_castillo`**, ton nom, ton mot de passe.
   → Ce compte devient automatiquement **administrateur**.

## 6. Mettre en ligne sur GitHub Pages

1. Crée un dépôt GitHub et pousse le **contenu** du dossier `NordHaven`
   (`index.html`, `styles.css`, `app.js`, `config.js`, `assets/`).
2. Dépôt → **Settings → Pages** → *Branch: main* / *folder: root* → **Save**.
3. Le site sera servi sur `https://<ton-pseudo>.github.io/<repo>/`.

> ⚠️ Si tu mets le dépôt en **public**, ton `config.js` (URL + clé anon) sera visible —
> c'est **normal et sans danger** : la sécurité vient des règles RLS, pas du secret de la clé.

---

## Notes

- **Supprimer un client** : l'admin supprime le *profil* et ses contrats. Le compte
  d'authentification (e-mail) subsiste dans Supabase ; pour l'effacer totalement, va dans
  **Authentication → Users** et supprime-le manuellement (nécessite l'accès au dashboard).
- **Sauvegarde** : tes données vivent dans Supabase (plus dans le navigateur), donc elles
  sont partagées entre tous les appareils et tous les utilisateurs.
- Tant que `config.js` n'est pas renseigné, le site affiche un bandeau d'avertissement et
  les formulaires/connexion sont désactivés.
