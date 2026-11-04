# Mes pistes (lecture directe du code, avant audit)

## Bot (bot/index.js, store.js)
- B20 CRASH CONFIRMÉ : `new URL(req.url, 'http://localhost')` dans le handler HTTP lève sur `GET //[` → exception non rattrapée → process down (DoS distant, 1 requête). Fix : try/catch → 400. Prouvé avec scratchpad/urlcrash.js.
- B11 Filets de sécurité : `process.on('unhandledRejection')`, `client.on(Events.Error/ShardError)` (EventEmitter 'error' sans listener = crash).
- B1 TTS stampede : requêtes concurrentes identiques ratent toutes le cache → N fetch Google. Fix : Map des promesses en vol. (Le commentaire prétend « une seule requête » pour /dropall, faux en concurrent.)
- B2 Préchauffage TTS dans buildDropPayload (le serveur fetch pendant que le payload part) → latence TTS réduite côté overlay.
- B3 fetch upstream sans timeout → AbortSignal.timeout(8000).
- B4 Comparaison du token en temps constant (crypto.timingSafeEqual).
- B5 Awaits séquentiels : /who, /dropall (members.fetch par user), /dropgroup, /stats, buildBlockedSnapshot, react (user + channel) → Promise.all.
- B6 JSON.stringify une seule fois par drop (pas par destinataire).
- B7 Doublon livraison différée vs dispatchToTargets → helper deliver().
- B8 Maps jamais purgées : lastDropAt, lastDropAllAt ; intervals sans unref (recentDrops).
- B9 persistStore reconstruit tout l'objet à chaque bumpStats → sérialisation paresseuse au flush.
- B10 Rate limit TTS par IP : XFF[0] spoofable derrière Fly → Fly-Client-IP, sinon dernier XFF, sinon remoteAddress.
- B12 Brute force des codes /link (6 chiffres) → limiter les échecs par user.

## Overlay main (main.js)
- M1 electron-store 8 / conf 10 : chaque get() relit + parse le fichier ; chaque set() réécrit tout. currentDropSettings = 8 lectures/drop, settings:get = 15, settings:set = 1 écriture PAR clé. Fix : cache mémoire / store.store une fois, store.set(objet).
- M2 Broadcasts (connection-state, history-update, update-state) envoyés aussi à l'overlay qui n'écoute pas → cibler settingsWin.
- M3 settings:set accepte n'importe quelle clé (linkIdentity…) → liste blanche + validation de type.
- M4 Durcissement : setWindowOpenHandler deny, will-navigate preventDefault.
- M5 Reconnexion sans jitter → tempête de reconnexions au redeploy du bot.
- M6 Cursor poll : getBounds à chaque tick (16 ms) → cache des bounds.

## Renderer (overlay.js/html)
- R1 Spotlight : rAF qui mesure le drop en mouvement (bob) via getBoundingClientRect et réécrit 4 variables CSS d'un radial-gradient PLEIN ÉCRAN à chaque frame → repaint plein écran 60 fps en rendu logiciel (HW accel coupée). Fix : mesurer la mise en page (anchor offset + offsetWidth/Height), n'écrire que si ça change.
- R1b `.drop` : filter drop-shadow x2 (flou 60 px) + animation bob infinie → re-filtrage logiciel chaque frame ? À mesurer (box-shadow sur .media-box équivalent visuel ?).
- R2 Médias jamais libérés : video/audio pause() sans removeAttribute('src') + load() → décodeur/buffer gardés jusqu'au GC.
- R6 AudioContext du « pop » créé une fois et jamais suspendu → thread audio actif en permanence après le 1er drop (CPU au repos). Fix : suspend() après le pop, resume() au suivant.
- R3 Shim Android : setInterval(120 ms) permanent même sans drop.
- R5 Pluie : 38 appendChild + 38 timers → fragment + 1 timer.

## UIs réglages
- S1 settings.js : renderHistory toutes les 60 s même fenêtre cachée.
- S2 app.js Android : onNativeState toutes les 30 s + à chaque Hub.changed → JSON complet (historique inclus) + re-render complet, même app en arrière-plan.
- S4 innerHTML avec chaînes serveur (code, IDs) → textContent.

## Android natif
- A1 Prefs.settings()/history() reparsent le JSON à chaque appel (notification, ticker 30 s, chaque drop, stateJson).
- A2 Regex recompilée à chaque toMinutes().
- A3 Notification reconstruite + re-postée à chaque setState même texte identique.
- A4 Reconnexion sans jitter.
- A5 MainActivity : pas de web.onPause()/onResume() → timers JS tournent en arrière-plan ; pushState même activité en pause.
- A6 Updater : Hub.changed toutes les 500 ms pendant le téléchargement même si la progression ne bouge pas.

## CI / docs
- C1 windows.yml : cache npm (setup-node cache), npm ci si lock à jour.
- C2 android.yml : filtre de chemins trop large (settings.js/html ne vont pas dans l'APK).
- C3 Versions : overlay 1.5.1 vs Android 1.6.0 → bump pour livrer les optimisations via l'auto-update.
