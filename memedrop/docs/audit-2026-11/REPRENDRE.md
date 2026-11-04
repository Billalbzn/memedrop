# Audit & optimisation de MemeDrop — où on en est, comment reprendre

Travail interrompu volontairement (crédits). Rien n'a été déployé ni publié.

## 1. Ce qui est fait

| Étape | État |
|---|---|
| Audit complet (bot, Electron main, renderer overlay, UIs réglages, Android natif, CI/docs) | ✅ fait — `brut/audit_*.json` |
| Vérification adverse (2 vérificateurs indépendants : sécurité + valeur) | ✅ bot, Electron main, Android natif — `verifie/*.txt` <br> ❌ renderer, réglages, CI/docs — `non-verifie/*.txt` (propositions brutes, à relire avec plus de prudence) |
| Bancs de test de non-régression + références sur le code d'origine | ✅ `bancs-de-test/` (voir § 4) |
| **Bot : implémentation** (commit `fix(bot): …` juste avant celui-ci) | ✅ codé selon `decisions-bot.md`, `node --check` OK, banc de test : 69 étapes diffèrent de la référence, **toutes attribuées à une décision** (`bot-implementation/final.compare.txt`) <br> ❌ revue adverse interrompue → **à relire/tester avant `fly deploy`** |
| **CI Android (point 1)** | ✅ l'étape « Publish to the android-latest release » ne tourne plus que sur `main` (le build reste sur les branches) |
| **Bot, revue adverse (point 2)** | ✅ faite le 2026-11-04 : rien de bloquant. Corrigé : blocages fusionnés quand un appareil rejoint un lien existant (un `/block` fait hors ligne n'est plus perdu), 2e `store.flush()` à l'arrêt, `store.json` illisible pour cause d'E/S = arrêt (au lieu de démarrer à vide puis l'écraser), cooldown `/dropgroup` rendu si personne n'est atteint, `reserveCooldown` n'écrase plus un marquage plus récent. Banc de test : identique avant/après ces corrections (sous Windows, les étapes SIGINT/SIGTERM diffèrent toujours de la référence : `kill()` y tue le process sans passer par le gestionnaire, idem sur le code d'origine). <br> ❓ En suspens (décision) : `/link` avec un code neuf ajoute un appareil sans prévenir les autres (détournement invisible) ; budget TTS global épuisable (≈ 4 IP × 30/min) et le préchauffage des drops y est soumis. <br> ❌ pas encore déployé |
| **Android (point 3)** | ✅ codé, **non compilé** (pas de SDK) : `onClosing` + heartbeat autonome, délai max de poignée de main, relance réseau/écran, `onRenderProcessGone` (overlay + réglages), WebView overlay protégée, relance après mise à jour (`MY_PACKAGE_REPLACED`), réglages en pause hors écran, Updater (try/catch, sondage 3 s en pause), contrôle d'injection du shim ; identité gardée sur `register_failed` (Android + Electron). Écartés (verdict rejet ou partagé) : WebView 90 s, cache Prefs, notification dédupliquée, R8, heartbeat opt-in, drops écran verrouillé, libération de l'activité après 10 min. |
| Electron, renderer, réglages | ❌ pas commencé |

Lecture des fichiers `verifie/*.txt` : `[accept/modify]` = verdict sécurité / valeur ; lignes `S:` / `V:` = raisons ; `S-AMEND` / `V-AMEND` = version corrigée du changement à appliquer ; `MISSED` = problème trouvé par un vérificateur.

## 2. Ce qu'il reste à faire, par priorité

1. **⚠️ CI Android d'abord** : `.github/workflows/android.yml` publie l'APK dans la release `android-latest` à chaque push **de n'importe quelle branche** touchant `memedrop/android/**` ou `memedrop/overlay/src/**` → le bouton « mise à jour » des téléphones le propose à tout le monde. Avant de pousser des changements Android/renderer sur une branche, ajouter `if: github.ref == 'refs/heads/main'` à l'étape « Publish to the android-latest release » (le build continue de tourner sur les branches = vérification de compilation gratuite). Détails : `non-verifie/ci-docs.txt` (android-apk-published-from-any-ref) et `verifie/android-native.txt` (ci-publishes-branch-builds).
2. **Bot** : relire le diff du commit `fix(bot)`, lancer le bot en local, puis `fly deploy` (vérifier que `LINK_SECRET` est bien défini : `fly secrets list`). À savoir :
   - 3 crashs à distance corrigés (URL HTTP invalide, message WebSocket `{"toString":1}`, réponse Discord rejetée).
   - Multi-appareils : PC + téléphone du même compte restent liés ensemble (avant, ils se déliaient mutuellement).
   - À l'arrêt, `terminate()` au lieu de `close()` : les APK actuels se reconnectent enfin après un redéploiement (le 1er déploiement est encore arrêté par l'ancien code → 1 reconnexion manuelle sur Android cette fois-là).
   - Ping 45 s (au lieu de 30), /link verrouillé 10 min après 5 codes faux, 3 drops différés max par personne.
   - Petit reste : les commentaires de `overlay/main.js:360` et `MemeDropService.kt:32` disent encore « ping toutes les 30 s ».
3. **Android** (`verifie/android-native.txt`) — le plus important : `onClosing` jamais géré (après un redémarrage du bot, le téléphone reste « Connecté » sans recevoir de drops), crash du renderer WebView qui tue tout le service, service non relancé après mise à jour, WebView gardée 90 s, Prefs reparsées à chaque appel… Côté client aussi (Electron + Android) : ne plus effacer l'identité sur `register_failed` (`verifie/bot.txt`, client-register-failed-wipes-identity). Pas de SDK ici → aucune compilation testée : le build CI de branche (une fois le point 1 fait) sert de vérification.
4. **Electron main** (`verifie/overlay-main.txt`) : retirer `forward: true` de `setIgnoreMouseEvents` (hook souris global bas niveau 24/7 sur des PC de jeu, inutile car le survol passe par le sondage du curseur), cache mémoire devant electron-store (~12 lectures disque + 1 écriture fsync par drop aujourd'hui), liste blanche + validation de `settings:set`, garde de navigation / fenêtres, timeout de handshake WS, raccourcis globaux DevTools Ctrl+Alt+S/M actifs en production, config.json corrompu = crash au lancement…
5. **Renderer overlay** (`non-verifie/overlay-renderer.txt` + `bancs-de-test/harness-notes-renderer.md`) : gros gain CPU mesuré — dès qu'un drop est affiché, le compositeur logiciel prend ~1 cœur à 7-29 fps à cause du `filter: drop-shadow` (flou 60 px) sur le `.drop` animé et du spotlight plein écran redessiné à chaque frame ; corrigés : ~94 ms → ~10-12 ms CPU par frame, 60 fps. Aussi : AudioContext jamais suspendu, médias jamais libérés, animations de sortie invisibles, bugs listés. **Un prototype de patch existe** : `prototypes/overlay-r/overlay-opt.js`, `overlay-opt.html`, `android-shim-opt.js` (non vérifié, à comparer avec `diff`).
6. **Réglages** (`non-verifie/settings-ui.txt`) : animations « pulse » du statut = 55-60 % d'un cœur tant que la fenêtre affiche « connexion… », innerHTML avec des chaînes du serveur, formateur de date recréé par ligne, re-rendu Android complet en arrière-plan.
7. **Docs / versions** : README encore sur Railway, docs d'auto-update Windows inexactes, `.env.example` (fait côté bot), passer `overlay/package.json` et `versionName` Android à 1.7.0 au moment de publier. Electron 33 est en fin de vie (montée de version à tester sur Windows).

## 3. Reprendre en local

```bash
git fetch origin claude/charming-goodall-c84gcl
git checkout claude/charming-goodall-c84gcl
```

Avec Claude Code, par exemple : « Lis `memedrop/docs/audit-2026-11/REPRENDRE.md`, puis fais le point 1 et le point 3 en suivant `verifie/android-native.txt` ». Une zone à la fois, en gardant le protocole WebSocket rétro-compatible (champs ajoutés seulement : de vieux overlays/APK restent en circulation) et en se souvenant que `overlay.js`/`overlay.html`/`styles.css` sont aussi embarqués dans l'APK.

## 4. Bancs de test (`bancs-de-test/`)

Écrits pour l'environnement cloud : ils chargent `playwright-core` depuis `/opt/node-tools/node_modules/` (à remplacer par ton propre chemin / `npm i -D playwright`). Chaque `harness-notes-*.md` donne les commandes, ce qui est couvert et les bugs observés sur le code d'origine.
- **bot** : `node bancs-de-test/bot-harness/run.js memedrop/bot sortie.json` puis `node bancs-de-test/bot-harness/compare.js bancs-de-test/bot-harness/baseline.json sortie.json` (~25 s, déterministe, discord.js/ws simulés).
- **renderer** : `run.js <dossier memedrop> <dossier-sortie>` puis `compare.js bancs-de-test/renderer-harness/baseline <dossier-sortie>` (comportement + perf, Chromium).
- **Electron main** : la référence (4 Mo) n'est pas commitée ; la régénérer sur le code d'origine (`git worktree add ../orig b66cf4b`) avec `run.js ../orig/memedrop/overlay baseline.json`.
