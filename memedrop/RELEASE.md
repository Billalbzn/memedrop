# Comment publier une mise à jour MemeDrop

Les deux applis sont compilées et publiées par GitHub Actions : pas de token à
créer, rien à compiler sur ton PC.

## ⚠️ Le renderer est partagé

`overlay/src/overlay.js`, `overlay.html` et `styles.css` sont embarqués **aussi
dans l'APK Android**. Une modification de ces fichiers part donc sur les
téléphones dès qu'elle arrive sur `main` (voir Android ci-dessous), alors que les
PC ne la reçoivent qu'avec la prochaine release Windows.

## 🤖 Android — automatique à chaque merge sur `main`

1. Dans `android/app/build.gradle.kts`, augmente `versionName` (ex. `"1.6.0"` →
   `"1.7.0"`) : c'est le numéro affiché dans l'app.
2. Merge sur `main`. Le workflow **Android APK** compile l'APK et le publie dans la
   release **`android-latest`** ; les téléphones le proposent au prochain lancement
   de l'app (bouton *télécharger & installer*).

Sur les autres branches, le même workflow compile l'APK (vérification gratuite) et le
joint au run comme artefact `MemeDrop-apk`, **sans** le publier.

> Ne renomme pas `.github/workflows/android.yml` : `versionCode` vient du numéro de run
> du workflow, qui repartirait à 1, et les APK suivants ne s'installeraient plus
> par-dessus les anciens.

## 🪟 Windows — à la demande

1. Dans `overlay/package.json`, augmente `"version"` (ex. `"1.5.1"` → `"1.7.0"`).
   Elle doit toujours augmenter : le workflow refuse de republier une version
   déjà publiée.
2. Merge sur `main`.
3. Lance la release, au choix :
   - onglet **Actions** → **Windows release** → **Run workflow** (branche `main`) ;
   - ou pousse un tag identique à la version :
     ```bash
     git tag v1.7.0
     git push origin v1.7.0
     ```
4. Le workflow compile l'installeur, crée la release `v1.7.0` et la publie comme
   « latest ».

Les PC équipés vérifient toutes les 30 minutes. L'app **n'installe rien toute seule** :
dans les réglages apparaît « Mise à jour disponible » → **Télécharger** →
**Installer & redémarrer**.

## Ce que voient les potes

```
┌─────────────────────────────────────┐
│ NOUVEAUTÉ                           │
│ Mise à jour disponible — v1.7.0     │
│ Clique pour la télécharger…         │
│                  [ Télécharger ]    │
└─────────────────────────────────────┘
```

Après **Télécharger** → barre de progression → **Installer & redémarrer** → l'app
redémarre sur la nouvelle version.

## En dépannage : build Windows local

Seulement si GitHub Actions est indisponible.

1. Crée un token **fine-grained** (https://github.com/settings/personal-access-tokens) :
   dépôt `Billalbzn/memedrop` uniquement, permission **Contents : Read and write**,
   avec une date d'expiration. Pas de token « classic » `repo` sans expiration.
2. Dans `memedrop/overlay` :
   ```powershell
   Get-Process -Name "*memedrop*" -ErrorAction SilentlyContinue | Stop-Process -Force
   $env:GH_TOKEN = "github_pat_..."
   npm run release:win
   ```
3. electron-builder crée une release **brouillon** : publie-la à la main sur
   https://github.com/Billalbzn/memedrop/releases (bouton **Publish release**).
