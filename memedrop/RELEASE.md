# Comment publier une mise à jour MemeDrop

Avec le nouveau système, tes potes n'ont **plus jamais besoin de retélécharger l'exe manuellement**. Quand tu publies une nouvelle version sur GitHub Releases, leur app la détecte au prochain lancement et propose le bouton "Installer & redémarrer".

## Setup initial (UNE SEULE FOIS)

### 1. Rendre ton repo public

Va sur https://github.com/Billalbzn/memedrop/settings → tout en bas → **"Change repository visibility"** → choisis **Public**.

Pourquoi : electron-updater a besoin d'accéder à `https://github.com/Billalbzn/memedrop/releases/latest/...` sans authentification. Avec un repo privé, il faudrait un token GitHub embarqué dans l'app, ce qui est mauvaise pratique.

### 2. Créer un Personal Access Token (pour publier)

Va sur https://github.com/settings/tokens → **"Generate new token (classic)"** :
- Nom : `memedrop-release`
- Expiration : `No expiration` (ou ce que tu veux)
- Scopes : coche **`repo`** uniquement
- Génère et **copie le token** (commence par `ghp_...`).

⚠️ Tu ne pourras PAS le revoir, garde-le bien.

## À chaque nouvelle version

### 1. Bump la version dans `package.json`

Ouvre `overlay/package.json` et incrémente la version :
```json
"version": "1.1.0"  →  "1.1.1"  (ou 1.2.0, 2.0.0, etc.)
```

⚠️ **Important** : la version doit toujours augmenter. Tu peux pas re-release une `1.1.0` après avoir release une `1.1.0`.

### 2. Build + publish en une commande

```powershell
cd C:\Users\tsumu\Downloads\memedrop\memedrop\overlay
Get-Process -Name "*memedrop*" -ErrorAction SilentlyContinue | Stop-Process -Force
$env:GH_TOKEN = "ghp_TON_TOKEN_ICI"
$env:DEFAULT_SERVER = "wss://memedrop-production-3106.up.railway.app"
npm run release:win
```

Ça va :
- Builder le `.exe` et l'installeur NSIS
- Générer le fichier `latest.yml` (signatures + checksums)
- Créer une release **brouillon** sur GitHub avec tous les fichiers uploadés

### 3. Publier la release sur GitHub

Va sur https://github.com/Billalbzn/memedrop/releases → tu vois ta release en **draft** → clique → **"Publish release"** (bouton vert en bas).

C'est fait. Tes potes vont recevoir la notif de mise à jour dans les minutes qui suivent.

### Alternative manuelle (sans token)

Si tu préfères pas utiliser de token :

```powershell
npm run build:win
```

Puis va sur https://github.com/Billalbzn/memedrop/releases → **"Draft a new release"** → tag `v1.1.1` → drag-drop manuellement ces 3 fichiers depuis `dist/` :
- `MemeDrop-Setup-1.1.1.exe`
- `MemeDrop-Setup-1.1.1.exe.blockmap`
- `latest.yml`

Puis **"Publish release"**.

## Première fois — comment passer tes potes sur l'auto-update

Tes potes utilisent encore l'**ancienne v1.0.0 sans electron-updater**. Donc le premier .exe avec auto-update doit être **distribué manuellement une dernière fois** (via gofile ou autre).

Étapes :
1. Build la v1.1.0 (déjà fait)
2. Upload `MemeDrop-Portable-1.1.0.exe` sur gofile et donne le lien à tes potes **une dernière fois**
3. À partir de là, toutes les versions futures (1.1.1, 1.2.0, etc.) passeront en auto-update sans rien faire de leur côté

## Comment voir ce que les potes voient

Quand une MAJ est dispo, ils verront en haut des réglages :

```
┌─────────────────────────────────────┐
│ NOUVEAUTÉ                           │
│ Mise à jour disponible — v1.1.1    │
│ Cliquez pour la télécharger…       │
│                  [ Télécharger ]    │
└─────────────────────────────────────┘
```

Après clic sur Télécharger → progress bar → "Installer & redémarrer" → l'app redémarre toute seule sur la nouvelle version.
