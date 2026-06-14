# MemeDrop

> Drop a meme onto your friend's screen while they're playing. Free, self-hosted.

Two pieces:

- **`bot/`** → Discord bot + WebSocket hub. Hosted once on Railway, runs 24/7.
- **`overlay/`** → Electron app. Each friend installs the `.exe` on their PC.

The bot exposes `/drop @target`, `/dropall`, `/link`, `/unlink`, `/status`, `/who`, `/block`, `/unblock`, `/blocklist`. The overlay is a transparent click-through window that sits on top of the user's game, launches automatically at login, and re-connects to your bot on its own.

---

## Quick architecture

```
   ┌──────────────────┐         ┌─────────────────┐
   │  Friend A on     │  /drop  │   YOUR BOT      │
   │  Discord         ├────────▶│   on Railway    │
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

Everyone shares **one bot** on one Railway service. Each PC runs its own overlay app that connects to that bot.

---

## Part 1 — Deploy the bot on Railway (one time, ~5 min)

### 1.1 Create the Discord bot

1. Go to https://discord.com/developers/applications → **New Application** → name it "MemeDrop".
2. Left menu → **Bot** → **Reset Token** → copy and save the token.
3. Left menu → **OAuth2 → URL Generator**:
   - Scopes: ☑ `bot` + ☑ `applications.commands`
   - Bot Permissions: ☑ Send Messages + ☑ Use Slash Commands
4. Copy the generated URL, open it in your browser, invite the bot to your server.

### 1.2 Push the bot to Railway

1. Create a free account on https://railway.com.
2. Install the CLI: https://docs.railway.com/guides/cli (or use the web UI).
3. From inside the `bot/` folder:

   ```bash
   railway login
   railway init        # create a new project
   railway up          # deploys the current folder
   ```

   Or use the web UI: "New Project" → "Deploy from GitHub" → pick your fork.

4. In the Railway dashboard, open the service → **Variables** tab → add:
   - `DISCORD_TOKEN` = your bot token from step 1.1
   - `CLIENT_ID` = your application ID (visible on the bot's Discord dev page → General Info)
   - `LINK_SECRET` = a long random string, used to sign the tokens that let the
     overlay re-link automatically after a restart. Generate one with:
     ```bash
     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
     ```
     **Keep this stable** across redeploys. If it ever changes (or is left
     unset), every overlay needs to run `/link` again once.

5. Still in Railway → **Settings** tab → **Networking** → **Generate Domain**. You get something like `memedrop-bot.up.railway.app`. **Copy this domain**, you'll need it.

6. Register the slash commands once (from your machine, with `.env` filled in locally):

   ```bash
   npm install
   npm run deploy
   ```

The bot is now running 24/7 at `wss://memedrop-bot.up.railway.app`. Test from any Discord channel: type `/status` — bot should reply.

---

## Part 2 — Build the Windows installer

This is the `.exe` you'll share with friends.

### 2.1 First time: set the default server URL

Before building, the overlay needs to know which bot to connect to by default. The `main.js` already reads from a build-time env var:

```bash
# Windows PowerShell
cd overlay
$env:DEFAULT_SERVER = "wss://memedrop-bot.up.railway.app"  # YOUR Railway URL
npm install
npm run build:win
```

```bash
# macOS / Linux (if cross-building)
cd overlay
DEFAULT_SERVER="wss://memedrop-bot.up.railway.app" npm run build:win
```

This takes 1–3 minutes. When it's done, look in `overlay/dist/` — you'll have two files:

| File                              | What it is                                                          |
|-----------------------------------|---------------------------------------------------------------------|
| `MemeDrop-Setup-1.0.0.exe`        | Full installer (creates Start Menu + desktop shortcuts, can uninstall) |
| `MemeDrop-Portable-1.0.0.exe`     | Single-file portable, no install, just double-click to run          |

### 2.2 Share with friends

Upload one of those `.exe` files to a Google Drive / Discord channel / wherever. Friends download it, double-click, and that's it.

> **Heads up about SmartScreen**: because the `.exe` isn't code-signed (a $200/year cert), Windows will show a blue "Windows protected your PC" popup. Friends need to click "More info" → "Run anyway". Tell them this in advance, otherwise they'll think it's a virus. If you want zero friction, look into signing the binary later.

---

## Part 3 — How your friends use it

For each friend, once:

1. Run `MemeDrop-Setup.exe` (or `MemeDrop-Portable.exe`).
2. App opens. The header pill says **AWAITING LINK** and shows a 6-digit code.
3. On Discord, in the server where the bot lives, type `/link <code>`.
4. App pill turns green **LINKED**. They're done.

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

---

## Local development (no Railway)

If you just want to test on your own machine:

```bash
# Terminal 1
cd bot
cp .env.example .env   # fill DISCORD_TOKEN, CLIENT_ID, and optionally DEV_GUILD_IDS
npm install
npm run deploy
npm start              # listens on :8765

# Terminal 2
cd overlay
npm install
npm start
```

The overlay tries `wss://memedrop-bot.up.railway.app` by default — change the URL to `ws://localhost:8765` from the settings window's "Bot server URL" field on first launch.

---

## Known limitations

- **Fullscreen exclusive mode** hides the overlay (OS-level limit). Friends must play in **borderless** or **windowed**. Most modern games default to borderless.
- The overlay is click-through by design. To interact (close, drag), use the tray icon menu.
- This app does NOT inject into game processes, hook APIs, or read game memory. It's just a transparent OS window. That's safe with anti-cheats — but always check your game's ToS.
- Discord CDN URLs expire after ~24h. Drops are real-time, so this doesn't matter for normal use, but don't expect to "replay" old drops — including favorites saved with `/fav add`: if a favorite stops showing up after a day or so, just re-run `/fav add` to refresh its URL.
- The bot keeps pairings in memory. If it restarts (e.g. Railway redeploys), the overlay re-links itself automatically using a token saved locally — as long as `LINK_SECRET` stays the same across deploys. If `LINK_SECRET` changes (or was never set), everyone re-runs `/link` once.
- Favorites and groups (`/fav`, `/group`) are saved to `bot/data/store.json`. On Railway this disk is wiped on every redeploy — mount a persistent volume at `bot/data` (set `DATA_DIR` to its path if different) if you want favorites/groups to survive redeploys, not just restarts.

---

## Project layout

```
memedrop/
├── bot/
│   ├── index.js              # bot + HTTP/ws server
│   ├── deploy-commands.js    # slash command registration
│   ├── nixpacks.toml         # tells Railway to use Node 20 LTS
│   ├── railway.json          # Railway service config
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
        └── styles.css
```
