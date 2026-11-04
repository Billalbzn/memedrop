# MemeDrop — technical guide

> Drop a meme onto your friend's screen while they're playing. Free, self-hosted.
> Looking for the user-facing overview? See the [main README](../README.md).

Three pieces:

- **`bot/`** → Discord bot + WebSocket hub. Hosted once on Fly.io, runs 24/7.
- **`overlay/`** → Electron app. Each friend installs the `.exe` on their PC.
- **`android/`** → Kotlin app for Android 8+. Same bot protocol, same drop renderer.

The bot exposes `/drop @target`, `/dropall`, `/link`, `/unlink`, `/status`, `/who`, `/block`, `/unblock`, `/blocklist`, `/fav`, `/dropfav`, `/group`, `/dropgroup` and `/stats`. The overlay is a transparent click-through window that sits on top of the user's game, launches automatically at login, and re-connects to your bot on its own.

---

## Quick architecture

```
   ┌──────────────────┐         ┌─────────────────┐
   │  Friend A on     │  /drop  │   YOUR BOT      │
   │  Discord         ├────────▶│   on Fly.io     │
   └──────────────────┘         └────────┬────────┘
                                         │ WSS
                          ┌──────────────┴───────────────┐
                          ▼                              ▼
                ┌──────────────────┐          ┌──────────────────┐
                │  Friend B's PC   │          │  Friend C's PC   │
                │  MemeDrop.exe    │          │  MemeDrop.exe    │
                │  shows meme      │          │  shows meme      │
                └──────────────────┘          └──────────────────┘
```

Everyone shares **one bot** on one Fly.io app (a single machine). Each PC or phone runs its own app that connects to that bot.

---

## Part 1 — Deploy the bot on Fly.io (one time, ~10 min)

### 1.1 Create the Discord bot

1. Go to https://discord.com/developers/applications → **New Application** → name it "MemeDrop".
2. Left menu → **Bot** → **Reset Token** → copy and save the token.
3. Left menu → **OAuth2 → URL Generator**:
   - Scopes: ☑ `bot` + ☑ `applications.commands`
   - Bot Permissions: ☑ Send Messages + ☑ Use Slash Commands
4. Copy the generated URL, open it in your browser, invite the bot to your server.

### 1.2 Deploy the bot on Fly.io

1. Create an account on https://fly.io and install `flyctl` (https://fly.io/docs/flyctl/install/), then `fly auth login`.
2. From inside the `bot/` folder, create the app without deploying yet:

   ```bash
   fly launch --no-deploy     # pick a name, e.g. memedrop-bot → wss://memedrop-bot.fly.dev
   ```

   It writes a `fly.toml` (and a `Dockerfile` for Node). Before deploying, check in `fly.toml`:
   - `internal_port` matches the port the bot listens on: `PORT` if set, otherwise
     `WS_PORT`, otherwise **8765**;
   - `auto_stop_machines = 'off'` and `min_machines_running = 1`: a stopped machine
     means the bot is offline on Discord and every app is disconnected;
   - a `[mounts]` section with `source = 'memedrop_data'` and `destination = '/data'`,
     plus `DATA_DIR = '/data'` under `[env]` (see step 4).

3. Set the secrets (never in `fly.toml`):

   ```bash
   fly secrets set DISCORD_TOKEN=... CLIENT_ID=... LINK_SECRET=...
   ```

   - `DISCORD_TOKEN` = your bot token from step 1.1
   - `CLIENT_ID` = your application ID (Discord dev page → General Info)
   - `LINK_SECRET` = a long random string, used to sign the tokens that let the
     apps re-link automatically after a restart. Generate one with:
     ```bash
     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
     ```
     **Keep this stable** across redeploys. If it ever changes, every app needs
     to run `/link` again once. On Fly the bot refuses to start without it.

4. Create the volume that keeps favorites, groups and stats (`store.json`) across deploys:

   ```bash
   fly volumes create memedrop_data --size 1
   ```

5. Deploy, with **exactly one machine** (two would split the connected apps between
   them and answer each Discord command twice):

   ```bash
   fly deploy
   fly scale count 1
   ```

6. Register the slash commands once (from your machine, with `.env` filled in locally):

   ```bash
   npm install
   npm run deploy
   ```

The bot is now running 24/7 at `wss://<your-app>.fly.dev`. Test from any Discord channel: type `/status` — bot should reply.

The official bot's config is committed as `bot/fly.toml` + `bot/Dockerfile` (app `memedrop-bot`, Paris, volume `memedrop_data` on `/app/data`): from `bot/`, a plain `fly deploy` redeploys it. The container registers the slash commands at every start. Optional: `fly secrets set KLIPY_API_KEY=...` enables the `gif` search option of `/drop`, `/dropall` and `/dropgroup`.

---

## Part 2 — Build the Windows installer

This is the `.exe` you'll share with friends.

### 2.1 First time: set the default server URL

Before building, the overlay needs to know which bot to connect to by default. Edit the `DEFAULT_SERVER` constant near the top of `overlay/main.js` (your bot's `wss://` URL) — and the one in `android/app/src/main/java/com/memedrop/app/Prefs.kt` for the APK — then build:

```bash
cd overlay
npm install
npm run build:win
```

The `DEFAULT_SERVER` environment variable is only read by `npm start` (dev runs); the packaged app ignores it.

This takes 1–3 minutes. When it's done, look in `overlay/dist/` — you'll have two files:

| File                              | What it is                                                          |
|-----------------------------------|---------------------------------------------------------------------|
| `MemeDrop-Setup-x.y.z.exe`        | Full installer (creates Start Menu + desktop shortcuts, can uninstall) |
| `MemeDrop-Portable-x.y.z.exe`     | Single-file portable, no install, just double-click to run          |

Official releases are built by the **Windows release** workflow instead (see `RELEASE.md`).

### 2.2 Share with friends

Point friends to the latest GitHub release (or upload one of those `.exe` files anywhere). Friends download it, double-click, and that's it.

Installed apps check for a new release every 30 minutes but **don't install it on their own**: the settings window shows « Mise à jour disponible » → *Télécharger* → *Installer & redémarrer*.

> **Heads up about SmartScreen**: because the `.exe` isn't code-signed (a $200/year cert), Windows will show a blue "Windows protected your PC" popup. Friends need to click "More info" → "Run anyway". Tell them this in advance, otherwise they'll think it's a virus. If you want zero friction, look into signing the binary later.

---

## Part 2b — The Android APK

The Android app lives in `android/`. It is a small native Kotlin app:

- a **foreground service** (`MemeDropService.kt`) keeps the WebSocket to the bot,
  with the same protocol as the Windows overlay (pairing code, `/link`,
  zero-touch re-link, heartbeat);
- drops are drawn in a transparent, non-touchable window above other apps
  (`OverlayController.kt`) that loads **the very same `overlay/src/overlay.html`
  + `overlay.js`** as Windows. The Gradle task `syncWebAssets` copies them into the
  APK at build time and injects `assets/android-shim.js`, which replaces the
  Electron `window.memedrop` API. So any change to the drop rendering applies to both;
- the settings screen is a WebView (`assets/app.html` / `app.js`) talking to the
  service through a JavaScript bridge, styled with the shared `overlay/src/styles.css`.

### Getting the APK

You don't need Android Studio: the **Android APK** GitHub Actions workflow
(`.github/workflows/android.yml`) builds it on every branch push touching `android/`
or the shared renderer files (`overlay/src/overlay.js`, `overlay.html`, `styles.css`).
Only builds of `main` are published as `MemeDrop.apk` in the
**`android-latest`** pre-release (the one phones update from); on other branches
the APK is only attached to the run as the `MemeDrop-apk` artifact. Being a
pre-release, it does not interfere with the Windows auto-updater, which only
reads the latest stable release.

To build locally instead (JDK 17 + Android SDK + Gradle 8.9):

```bash
cd android
gradle assembleRelease
# → app/build/outputs/apk/release/app-release.apk
```

### Signing key

Official APKs are signed with a **private key that is never committed**. The CI
reads it from two repository secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | the `.p12` keystore, base64-encoded (`base64 -w0 memedrop-release.p12`) |
| `ANDROID_KEYSTORE_PASSWORD` | its password (key alias: `memedrop`) |

Every official build uses this same key, so updates install over the previous
version. **Keep a backup of the `.p12` and its password**: if you lose them, no
future APK can update existing installs (everyone would have to uninstall).
Local builds without these variables are signed with the Android debug key.

> The old public key (`memedrop-shared.keystore`, up to v1.5.3) was removed:
> apps installed before v1.6.0 must be **uninstalled once** before installing
> the new APK (different signature).

### Android limitations

- The full-screen drop window never catches touches and is slightly transparent
  (78 % opacity): Android 12+ blocks touches that pass through a more opaque
  overlay from another app. To move / close a meme, `OverlayController` places a
  small invisible touchable window exactly over each drop (positions reported by
  `android-shim.js`): drag to move, tap the ✕ to close. No reactions on mobile yet.
- The app updates itself: it reads `version.json` from the `android-latest` release
  and offers to download + install the new APK.
- Some manufacturers (Xiaomi, Huawei, Samsung…) kill background apps
  aggressively: allow "no battery optimization" in the app and, if needed,
  enable autostart in the phone settings.

---

## Part 3 — How your friends use it

For each friend, once:

1. Run `MemeDrop-Setup.exe` (or `MemeDrop-Portable.exe`) — or install `MemeDrop.apk` on Android.
2. App opens. The header pill says **en attente** and shows a 6-digit code.
3. On Discord, in the server where the bot lives, type `/link <code>`.
4. App pill turns green **connecté**. They're done.

The app starts automatically with Windows from now on (tray icon only — no
window) and reconnects to the bot on its own. To pause incoming drops without
quitting the app, open the tray menu or the settings window and use the
"connecté au bot" toggle or "mode tranquille".

Now anyone in the server can target them:

```
/drop target:@friend  media:[drag&drop image]
```

Boom — meme on their screen. Add a `pluie` option (up to 5 emojis, e.g. `🔥💀🤣`)
to make them rain down the screen too.

### Useful commands

| Command             | What it does                                             |
|---------------------|----------------------------------------------------------|
| `/link <code>`      | Pair this Discord account with your running overlay      |
| `/unlink`           | Cut the link                                             |
| `/status`           | Is your overlay connected?                               |
| `/who`              | List everyone in this server with a live overlay         |
| `/drop @who <file>` | Send a meme to that person's screen (2s cooldown)        |
| `/dropall <file>`   | Send a meme to everyone reachable in this server (15s cooldown) |
| `/block @who`       | Stop receiving drops from someone                        |
| `/unblock @who`     | Allow drops from them again                              |
| `/blocklist`        | List who you've blocked                                  |
| `/fav add <name> <file>` | Save a media as a favorite (max 10)                  |
| `/fav list` / `/fav remove <name>` | List or delete your favorites             |
| `/dropfav <name> @who` | Re-send a saved favorite (2s cooldown)                |
| `/group set <name> @who...` | Create/replace a named target group (max 5 members, 10 groups) |
| `/group list` / `/group delete <name>` | List or delete your groups          |
| `/dropgroup <name> <file>` | Send a meme to everyone in a group (2s cooldown)   |
| `/stats`            | Your sent/received counters + leaderboard              |

`/drop`, `/dropall` and `/dropgroup` also accept `tts` (text read aloud),
`effet` (zoom / tornade / glitch / shake) and — for `/drop` only — `delai`
(delayed drop, 1–60 min). Commands only work inside a server, not in DMs.

> ⏱️ If you're on cooldown, `/drop`, `/dropall`, `/dropfav` and `/dropgroup` now reply with the exact time left.

### On the overlay side

- **Mode tranquille** (tray icon or settings): mute incoming drops for 30 min,
  2 h, or until you turn it back on. Muted drops are still saved to your
  **history** (settings window) so you don't miss anything.
- **Pause connection** (settings window): fully disconnect from the bot —
  nobody can reach you — without closing the app. Flip it back on anytime.
- Hover a drop and click the **✕** that appears in the corner to dismiss it
  early.
- **Theme** (settings window, audio & display section): pick a color skin for
  the avatar bubble — Classique, Néon, Feu, or Mono.
- **Quiet hours**: automatic daily mute window (e.g. 22:00 → 08:00).
- **Avoid zone**: keep drops away from the center, top or bottom of the screen.
- The settings window is split into tabs: **Accueil**, **Calme**, **Historique**, **Réglages**.

---

## Local development

If you just want to test on your own machine:

```bash
# Terminal 1
cd bot
cp .env.example .env   # fill DISCORD_TOKEN, CLIENT_ID, LINK_SECRET, PUBLIC_BASE_URL=http://localhost:8765
npm install
npm run deploy
npm start              # listens on :8765

# Terminal 2
cd overlay
npm install
DEFAULT_SERVER=ws://localhost:8765 npm start   # only applies to a fresh config
```

Or change the URL to `ws://localhost:8765` in the settings window's "Bot server URL" field. Without `PUBLIC_BASE_URL`, the local bot hands out TTS links pointing at the production bot.

> ⚠️ Use a **separate Discord application** (its own token) for local tests: two bots running with the same token both answer every command.
>
> `npm start` uses the same settings file as the installed app (same `config.json`, same link). Quit the installed app first.

---

## Known limitations

- **Fullscreen exclusive mode** hides the overlay (OS-level limit). Friends must play in **borderless** or **windowed**. Most modern games default to borderless.
- The overlay is click-through by design: drops can be dragged and closed with their ✕, the rest of the window lets clicks through to the game.
- This app does NOT inject into game processes, hook APIs, or read game memory. It's just a transparent OS window. That's safe with anti-cheats — but always check your game's ToS.
- Discord CDN URLs expire after ~24h. Drops are real-time, so this doesn't matter for normal use, but don't expect to "replay" old drops — including favorites saved with `/fav add`: if a favorite stops showing up after a day or so, just re-run `/fav add` to refresh its URL.
- The bot keeps pairings in memory. If it restarts (e.g. a Fly deploy), the apps re-link themselves automatically using a token saved locally — as long as `LINK_SECRET` stays the same across deploys. If `LINK_SECRET` changes, everyone re-runs `/link` once.
- Favorites, groups and stats (`/fav`, `/group`, `/stats`) are saved to `store.json` in `DATA_DIR` (default `bot/data/`). A Fly machine's disk is reset on every deploy: mount a volume and point `DATA_DIR` at it (Part 1.2), or they only survive restarts.

---

## Project layout

```
.github/workflows/android.yml # builds the APK, publishes it from main
.github/workflows/windows.yml # builds + publishes the Windows release
memedrop/
├── bot/
│   ├── index.js              # bot + HTTP/ws server (+ /tts)
│   ├── store.js              # favorites / groups / stats persistence
│   ├── deploy-commands.js    # slash command registration
│   ├── fly.toml              # Fly.io app config (one machine, volume on /app/data)
│   ├── Dockerfile            # image built by `fly deploy` (registers commands, then starts the bot)
│   ├── package.json
│   └── .env.example
└── overlay/
    ├── main.js               # Electron main + ws client
    ├── preload.js
    ├── package.json          # electron-builder config baked in
    ├── assets/
    │   ├── icon.ico          # Windows icon (multi-resolution)
    │   ├── icon.png
    │   └── icon.svg          # source
    └── src/
        ├── overlay.html
        ├── overlay.js
        ├── settings.html
        ├── settings.js
        └── styles.css            # shared with the Android settings screen
└── android/
    ├── settings.gradle.kts / build.gradle.kts
    └── app/
        ├── build.gradle.kts      # syncWebAssets: copies overlay/src into the APK
        └── src/main/
            ├── AndroidManifest.xml
            ├── assets/           # app.html, app.js, android-shim.js
            └── java/com/memedrop/app/
                ├── MainActivity.kt       # settings screen + JS bridge
                ├── MemeDropService.kt    # WebSocket + notification
                ├── OverlayController.kt  # window drawn over other apps
                ├── Prefs.kt / Hub.kt     # settings + shared state
                ├── Updater.kt            # in-app APK update (android-latest)
                └── BootReceiver.kt       # start at boot / after an update
```
