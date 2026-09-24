<div align="center">

<img src="memedrop/overlay/assets/icon.png" width="96" alt="MemeDrop" />

# MemeDrop

**Balance un mème sur l'écran de tes potes. Pendant qu'ils jouent.**

Tu tapes `/drop @pote` sur Discord → ton mème apparaît en plein milieu de son écran, par-dessus son jeu.<br/>
Sur **Windows** et sur **Android**. Gratuit, auto-hébergé.

[**⬇️ Windows (.exe)**](https://github.com/Billalbzn/memedrop/releases/latest) &nbsp;·&nbsp;
[**⬇️ Android (.apk)**](https://github.com/Billalbzn/memedrop/releases/tag/android-latest) &nbsp;·&nbsp;
[Guide d'installation](#-installation) &nbsp;·&nbsp;
[Commandes](#-les-commandes)

</div>

---

## ✨ Ce que ça fait

| | |
|---|---|
| 🖼️ **Images, GIF, vidéos, sons** | Tout ce que tu joins à `/drop` s'affiche sur l'écran de la cible, avec ton avatar et une légende façon mème. |
| 🎯 **Jusqu'à 5 cibles** | `/drop`, `/dropall` pour tout le serveur, ou des **groupes** enregistrés (`/dropgroup`). |
| 🌧️ **Pluie d'emojis** | `pluie:🔥💀🤣` fait pleuvoir jusqu'à 5 emojis sur tout l'écran. |
| 🗣️ **Texte lu à voix haute** | `tts:ton texte` est lu sur le PC ou le téléphone de la cible. |
| 💥 **Effets d'entrée** | `zoom`, `tornade`, `glitch` ou `shake` (tout l'écran tremble). |
| 🎵 **Photo + musique** | Une image avec un MP3/MP4 en fond sonore. |
| ⏳ **Drop différé** | `delai:10` : le mème tombe dans 10 minutes, par surprise. |
| ⭐ **Favoris** | Enregistre tes meilleurs mèmes et renvoie-les en une commande. |
| ✋ **Déplacer / fermer** | Fais glisser un mème pour le pousser ailleurs, ou ferme-le avec sa ✕ (souris sur PC, doigt sur téléphone). |
| 😂 **Réactions** (Windows) | La victime peut réagir d'un emoji — la réaction est postée sur Discord. |
| 📊 **Classement** | `/stats` : qui droppe le plus, qui en prend le plus. |

### Et pour ne pas devenir fou

- 🔇 **Mode tranquille** — 30 min, 2 h ou jusqu'à réactivation. Les drops sont notés, pas affichés.
- 🌙 **Heures calmes** — mute automatique chaque nuit (ex. 22:00 → 08:00).
- 🚫 **Bloquer quelqu'un** — `/block @relou`.
- 🎯 **Zone d'exclusion** — les drops évitent le centre (ton viseur), le haut ou le bas de l'écran.
- 🗂️ **Historique** — revois les derniers drops reçus, même ceux arrivés pendant le mode tranquille.
- ✋ **Aucune triche** — l'app est une simple fenêtre transparente : pas d'injection dans le jeu, pas de lecture mémoire.

---

## 📥 Installation

### 🪟 Windows

1. Télécharge **`MemeDrop-Setup-x.y.z.exe`** depuis la [dernière release](https://github.com/Billalbzn/memedrop/releases/latest).
2. Windows affiche « Windows a protégé votre PC » (l'app n'est pas signée) → **Informations complémentaires** → **Exécuter quand même**.
3. L'app s'ouvre et affiche un **code à 6 chiffres**.

MemeDrop se lance ensuite tout seul au démarrage (icône dans la barre des tâches) et **se met à jour automatiquement**.

> Joue en **plein écran fenêtré / sans bordure** : le plein écran exclusif cache toute fenêtre par-dessus le jeu (limite de Windows).

### 🤖 Android (8.0 et plus)

1. Sur ton téléphone, télécharge **`MemeDrop.apk`** depuis la [release Android](https://github.com/Billalbzn/memedrop/releases/tag/android-latest).
2. Ouvre-le. Android demande d'autoriser l'installation depuis ton navigateur → **Autoriser** → **Installer**.
3. Ouvre MemeDrop et accorde les autorisations proposées :
   - **Affichage par-dessus les autres applis** — indispensable ;
   - **Notifications** — état de la connexion + mode tranquille en un geste ;
   - **Pas d'économie de batterie** — recommandé, sinon Android coupe la connexion en veille.
4. L'app affiche un **code à 6 chiffres**.

> Fais glisser un mème pour le déplacer, touche sa ✕ pour le fermer. Le reste de l'écran reste jouable normalement.
> Mises à jour : l'app te propose elle-même les nouvelles versions (bouton **télécharger & installer**).

### 🔗 Relier l'app à ton compte Discord (une seule fois)

Sur ton serveur Discord, tape :

```
/link 123456
```

(avec ton code). Le voyant passe au vert **connecté** — c'est fini. Tu restes lié même après un redémarrage.<br/>
Pour être joignable depuis **un autre serveur**, refais `/link` là-bas avec le code affiché dans l'app.

---

## 💬 Les commandes

| Commande | Ce qu'elle fait |
|---|---|
| `/drop @pote media:…` | Envoie un mème (jusqu'à 5 cibles avec `target2`…`target5`) |
| `/dropall media:…` | À tout le monde de ce serveur qui a l'app |
| `/dropgroup nom media:…` | À un groupe enregistré |
| `/dropfav nom @pote` | Renvoie un favori |
| `/fav add` · `list` · `remove` | Gère tes favoris (10 max) |
| `/group set` · `list` · `delete` | Gère tes groupes de cibles |
| `/link code` · `/unlink` | Relie / délie ton app |
| `/status` · `/who` | Ton état · qui est joignable ici |
| `/block` · `/unblock` · `/blocklist` | Gère les personnes bloquées |
| `/stats` | Tes stats + le classement |

**Options de `/drop`** : `caption` (texte), `pluie` (emojis), `tts` (texte lu), `effet`, `musique` (MP3/MP4 avec une photo), `delai` (1 à 60 min).

```
/drop target:@kalel media:chat.gif caption:quand le build passe pluie:🎉🔥 effet:shake
```

Formats acceptés : PNG, JPG, GIF, WEBP, MP4, WEBM, MP3 — 25 Mo max.

---

## 🛠️ Héberger ton propre MemeDrop

MemeDrop tourne avec **un bot Discord** (hébergé une fois, par ex. sur Fly.io) et **une app par personne** (Windows ou Android) qui s'y connecte.

```
  Discord ──/drop──▶  Bot MemeDrop (Fly.io)  ──WebSocket──▶  PC Windows / téléphone Android
```

Tout est expliqué dans le **[guide technique](memedrop/README.md)** : création du bot Discord, déploiement, compilation du `.exe` et de l'APK, publication des mises à jour.

| Dossier | Contenu |
|---|---|
| [`memedrop/bot`](memedrop/bot) | Bot Discord + serveur WebSocket (Node.js) |
| [`memedrop/overlay`](memedrop/overlay) | App Windows (Electron) |
| [`memedrop/android`](memedrop/android) | App Android (Kotlin) — réutilise le rendu de l'app Windows |

---

<div align="center">
<sub>Fait pour troller ses potes avec amour. Utilise-le avec des gens d'accord pour se faire dropper 😈</sub>
</div>
