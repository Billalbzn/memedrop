# G1 — Bot (bot/index.js, bot/store.js, bot/.env.example) : décisions d'arbitrage

Source détaillée de chaque proposition (preuves, pseudo-diffs, avis des deux vérificateurs) :
`/tmp/claude-0/-home-user-memedrop/065ca17e-4939-5472-b348-276c03e80469/scratchpad/audit-results/bot-merged.txt`
(lignes « S: » = vérificateur sécurité, « V: » = vérificateur valeur, « -AMEND » = changement corrigé).
Bugs observés par le banc de test : section « observed_bugs » de
`/tmp/claude-0/-home-user-memedrop/065ca17e-4939-5472-b348-276c03e80469/scratchpad/harness-notes-bot.md`.

Fichiers autorisés : bot/index.js, bot/store.js, bot/.env.example. Rien d'autre (README, clients Electron/Android
et CI sont traités par d'autres équipes). Pas de nouvelle dépendance. Commentaires en français, style existant.
Protocole WebSocket : uniquement additif ; les overlays/APK déjà installés doivent continuer à marcher.

## À FAIRE (dans cet ordre de priorité)

### Crashs (priorité absolue)
1. **http-malformed-url-crash** : try/catch autour de `new URL(req.url, …)` → 400. 
2. **ws-message-string-coercion-crash / ws-message-handler-throw-crash** : helper `str(v)` (string → tel quel, number → String, sinon '') utilisé partout où le code fait `String(<valeur client>)` dans le handler 'message' (userId, username, token, guildId, userId d'unblock, dropId, emoji…). Corps du handler déplacé dans `async function onWsMessage(ws, raw)` appelé avec `.catch(e => console.error(...))`.
3. **interaction-reply-rejection-crash** : corps du listener InteractionCreate déplacé dans `async function onInteraction(interaction)` appelé avec `.catch(...)` (les 33 `return interaction.reply(...)` restent tels quels). `client.on(Events.Error, …)` et `client.on(Events.ShardError, …)` qui loguent. `.catch(() => {})` (ou log) sur tous les appels fire-and-forget de fonctions async (pushLinksUpdate dans GuildUpdate, handleTts(req,u,res), etc.).
4. Filets de sécurité process : `process.on('unhandledRejection', e => console.error(...))` (log, on continue) ; `process.on('uncaughtException', e => { console.error; try { store.flush() } catch {} ; process.exit(1) })`. ET `client.login(...).catch(e => { console.error(...); process.exit(1) })` pour qu'un login raté ne laisse pas un bot à moitié vivant.

### Robustesse / protocole
5. **bot-shutdown-close-frames** : à l'arrêt, `ws.terminate()` au lieu de `ws.close()` (avec le commentaire expliquant les APK ≤ 1.6.0).
6. **multi-device-mutual-unlink** : refonte multi-appareils, en suivant **S-AMEND** (le lien vivant reste la source de vérité : on ne fusionne JAMAIS les listes envoyées par un client dans un lien vivant), combiné avec la garde post-await de **V-AMEND** (`const cur = userLinks.get(uid); if (!cur || !cur.sockets.has(ws) || wsMeta.get(ws)?.userId !== uid) return;` — vérifier l'état courant, pas l'objet capturé). Détails :
   - `userLinks: userId → { sockets: Set<ws>, scope, guildIds, blockedUsers }` ; helpers `openSockets(link)` / `hasOpen(link)` et `sendToUser(userId, obj)` (un seul JSON.stringify, envoi à chaque socket OPEN).
   - Remplacer chaque usage de `link.ws` (grep) : isReachable, canDrop, pushLinksUpdate, register, close, les deux chemins de /link, /unlink, unlink_guild, /status, /who, /dropall, drop différé, dispatchToTargets.
   - register avec un lien qui a déjà une socket ouverte : `sockets.add(ws)`, on garde scope/guildIds/blockedUsers du lien vivant, `wsMeta(ws) = {code:null, userId}`, 'linked' avec le snapshot vivant à ws (le client le ré-enregistre), puis code d'extension. Sinon création du lien depuis l'identité comme aujourd'hui. Plus jamais 'unlinked' reason 'replaced' ici.
   - /link avec un code frais alors que l'utilisateur est déjà lié : `sockets.add(ws)`, `guildIds.add(guildId courant)` (si scope non global), 'linked' à ws, links_update aux autres sockets.
   - Une socket déjà liée à un AUTRE utilisateur qui fait register/link (bug harness « one socket can hold two identities ») : la détacher d'abord de l'ancien lien (comme close), puis continuer.
   - issueExtensionCode(userId) : supprime les anciens codes de l'utilisateur, un seul nouveau code envoyé à toutes ses sockets ouvertes.
   - /unlink et unlink_guild qui vide la liste : 'unlinked' + reissuePairingCode sur CHAQUE socket, puis suppression du lien et des codes d'extension.
   - close : `sockets.delete(ws)` ; lien + codes d'extension supprimés seulement quand il ne reste aucune socket.
7. **ws-unbounded-rest-amplification** : 
   - validation sans String() : `const SNOWFLAKE = /^\d{17,20}$/` ; `sid(v)` = v si string qui matche, sinon null ; `ids(a, max)` ; userId invalide → register_failed ; `guildIds` ≤ 200, `blockedUsers` ≤ 100 (ATTENTION : vérifier que le banc de test n'utilise pas d'IDs hors format snowflake pour des utilisateurs légitimes ; si c'est le cas, c'est une différence attendue à signaler, pas une raison d'élargir la regex).
   - budget par socket juste après `ws.isAlive = true` : 30 messages / 10 s, au-delà messages ignorés.
   - buildBlockedSnapshot : cache discord.js d'abord ; au plus 10 fetch REST par snapshot ; échecs 404 mémorisés dans une Map bornée (≤ 1000, on supprime le plus ancien) ; le reste affiche l'ID brut.
   - Ne plus attendre de snapshot avant une réponse non différée : /block, /unblock, chemin d'extension de /link → `interaction.reply(...)` d'abord, puis `pushLinksUpdate(uid).catch(...)`. Chemin nouveau lien de /link : poser userLinks/wsMeta, envoyer la réponse sans l'attendre (`.catch` log), puis `await buildLinksSnapshot`, 'linked', puis issueExtensionCode (ordre attendu par les clients).
   - Comparaison du token en temps constant (`crypto.timingSafeEqual`, longueurs vérifiées avant), token lu avec `typeof === 'string'`.
8. **tts-ratelimit-xff-spoofable** (S-AMEND) : `clientIp(req)` = `fly-client-ip` SEULEMENT si `process.env.FLY_APP_NAME`, sinon dernier saut de X-Forwarded-For, sinon `req.socket.remoteAddress` ; clé de rate-limit `ipKey()` qui regroupe l'IPv6 par /64 (et retire `::ffff:`). Budget global d'appels Google (fenêtre fixe 60 s, 120 fetch/min, au-delà → 503 'tts busy') vérifié uniquement là où un NOUVEAU fetch Google démarre (dans getTtsAudio). Pas de signature d'URL.
9. **tts-stampede-no-timeout** : `ttsInflight` (single-flight), `AbortSignal.timeout(8000)`, cache LRU inchangé ; handleTts : cache ou requête déjà en vol → pas de rate-limit ; sinon rate-limit puis fetch ; erreur → 502 comme aujourd'hui. Préchauffage : quand un drop avec tts est livré à ≥ 1 overlay, `getTtsAudio('fr', <exactement la même clé que celle que handleTts calculera pour ttsUrl>).catch(() => {})` — vérifier que la clé (trim + clip) est identique des deux côtés. Corriger le commentaire 20-21.
10. **tts-slice-splits-surrogate** : helper `clip(str, max)` (pas de demi-paire de substitution) aux 4 endroits (54, 589, 618, 1052 ou équivalents).
11. **unused-guildmessages-intent** : `intents: [GatewayIntentBits.Guilds]` seulement. PAS de makeCache/Options.
12. **empty-server-list-before-ready** : sur ClientReady, `pushLinksUpdate(uid).catch(...)` pour chaque utilisateur lié ; GuildUpdate ne pousse que si nom ou icône ont changé.
13. **duplicated-drop-delivery** (S-AMEND) : un seul `deliverDrop(senderId, guildId, channelId, targets, payload)` (stringify une fois, sendToUser, bumpStats sans persist par destinataire puis un persistStore, registerDropForReactions avec la liste des destinataires livrés, préchauffage TTS) utilisé par dispatchToTargets, le timer différé et /dropall ; /dropall : si personne n'a été livré au moment de l'envoi → le message « personne de joignable » existant.
14. **cooldown-check-mark-race** : réserver le cooldown avant les await dans /dropall et /dropgroup, restaurer si rien n'est envoyé.
15. **delayed-drop-cooldown-bypass** : au plus 3 drops différés en attente par expéditeur (message « ⏳ Tu as déjà 3 drops programmés — attends qu'ils partent. »), vérifié AVANT markCooldown, décrémenté en tête du callback.
16. **link-code-bruteforce** (S-AMEND) : linkFails/linkLocked/noteLinkFail (5 échecs / 10 min), purge dans le balayage 5 min existant. PAS de rotation des codes.
17. **store-debounce-and-corrupt-load** : save() à délai max 500 ms depuis le PREMIER changement (pas de ré-armement), save accepte une fonction qui construit l'objet (persistStore passe un builder), load() renomme un store.json illisible en `store.json.corrupt-<ts>` (sauf ENOENT) + log informatif de ce qui a été chargé (`[store] … : N favoris, M groupes` ou « aucun store.json — démarrage à vide »).
18. **heartbeat** : ping applicatif toutes les **45 s** (au lieu de 30) avec le commentaire « < 75 s : délai codé en dur dans les overlays/APK installés ». Garder le ping JSON.
19. **prod-config-silent-failures** (version douce) : PAS de process.exit si LINK_SECRET manque ; garder l'avertissement mais en `console.error` plus explicite quand FLY_APP_NAME est défini. .env.example : ajouter `DATA_DIR=` (point de montage du volume Fly, ex. /data) et `PUBLIC_BASE_URL=` (optionnel) avec une ligne de commentaire chacun ; préciser que PORT vient de l'hébergeur et que les secrets passent par `fly secrets set`.
20. Bugs du banc de test à corriger aussi :
    - cooldown affiché « 0s » : arrondir au supérieur (Math.ceil) dans formatCooldown.
    - /blocklist sans limite de longueur : tronquer la liste pour rester < 2000 caractères (« … et N autres »).
    - réactions acceptées d'un non-destinataire : n'accepter `react` que d'un utilisateur à qui le drop a été livré (registerDropForReactions garde l'ensemble des destinataires).

## NE PAS FAIRE
- Promise.all sur les fetch REST (discord.js sérialise par route, lookups cache-first : aucun gain).
- unref des timers, purge des Maps de cooldown (bornées par le nombre d'utilisateurs).
- Signature HMAC de ttsUrl, rotation des codes d'appairage, fly.toml écrit à la main, process.exit sans LINK_SECRET.
- Toute modification de deploy-commands.js, des textes de commandes, ou des messages existants autres que ceux listés.
