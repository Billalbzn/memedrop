# MemeDrop — Guide pour les potes 🎯

Tu vas installer MemeDrop. Une fois lancé, n'importe qui sur le Discord pourra te balancer des memes en plein écran pendant que tu joues. **Et toi tu pourras faire pareil avec eux.** ☠️

## Installation (1 minute)

1. **Télécharge** le fichier `MemeDrop-Setup-x.y.z.exe` depuis https://github.com/Billalbzn/memedrop/releases/latest (sur Android : `MemeDrop.apk`, voir le README principal)
2. **Double-clique** dessus
3. Windows va afficher un écran bleu **"Windows a protégé votre PC"** — c'est normal, l'app n'est pas signée (on est pas Microsoft 😅). Clique sur :
   - **"Informations complémentaires"** (petit lien)
   - puis **"Exécuter quand même"**
4. Suis l'installeur (clique Suivant, Suivant, Installer)
5. MemeDrop s'ouvre automatiquement

## Premier lancement

L'app affiche un **code à 6 chiffres** (genre `593536`).

Sur ton Discord, dans n'importe quel salon où le bot **MemeDrop** est présent, tape :

```
/link
```

→ Discord te propose la commande
→ Sélectionne-la
→ Tape le code à 6 chiffres dans le champ
→ Entrée

Le bot te répond `✅ Linked on …` et dans l'app le voyant passe au **vert « connecté »**.

**C'est bon, tu es opérationnel.** 🎯

## Pour droper un meme sur un pote

```
/drop target:@pseudo  media:[glisse une image]
```

Quelques règles :
- Le pote doit avoir lancé l'app et fait `/link` aussi
- Formats supportés : PNG, JPG, GIF, WEBP, MP4, WEBM, MP3
- Taille max : 25 MB
- Un drop maximum toutes les 2 secondes par personne

## Options de /drop pour trigger encore plus fort

| Option | Effet |
|--------|-------|
| `caption:` | Texte façon meme en surimpression |
| `musique:` | MP3 ou MP4 (seul le son est joué) en même temps qu'une photo/GIF |
| `pluie:` | Jusqu'à 5 emojis qui pleuvent sur l'écran (🔥💀🤣) |
| `tts:` | **Texte lu à voix haute** par le PC de la cible 🗣️ |
| `effet:` | Apparition spéciale : 💥 zoom, 🌪️ tornade, 👾 glitch, 📳 shake (secoue l'écran) |
| `delai:` | Le drop part dans N minutes — effet surprise garanti ⏳ |

## Réagir à un drop reçu

Passe la souris sur le drop → une barre d'emojis apparaît en dessous (😂 💀 🔥 😭 🖕). Clique : ta réaction est postée **dans le salon Discord d'où venait le drop**. L'envoyeur saura que tu as souffert.

## Commandes utiles

| Commande | Effet |
|----------|-------|
| `/status` | Vérifier si ton overlay est connecté |
| `/who` | Lister qui peut se faire droper actuellement |
| `/stats` | Tes compteurs + top droppeurs / top victimes 🏆 |
| `/fav add` / `/dropfav` | Enregistrer un meme favori et le renvoyer en 2 s |
| `/group set` / `/dropgroup` | Créer un groupe de cibles et arroser tout le monde |
| `/block @qui` | Bloquer un relou (il ne peut plus te droper) |
| `/unlink` | Te débrancher (les gens ne peuvent plus te droper) |

## Dans les réglages de l'app

- **Heures calmes** : mute automatique sur un créneau (ex. 22h–8h)
- **Zone d'exclusion** : les drops évitent le centre / haut / bas de ton écran
- **Historique** : bouton **revoir** pour rejouer un drop reçu (< 24 h)
- **Mises à jour** : quand une nouvelle version sort, une carte « Mise à jour disponible » apparaît ici → **Télécharger** → **Installer & redémarrer** (rien ne s'installe tout seul)

## ⚠️ À savoir avant de jouer

- **Fullscreen exclusif → l'overlay n'apparaît pas.** Passe en **borderless** dans les paramètres graphiques de ton jeu. La plupart des jeux modernes (LoL, Valorant, Fortnite...) sont en borderless par défaut.
- L'app reste dans la **barre des tâches Windows** (icône M coral à côté de l'horloge). Clic droit pour quitter, clic pour ouvrir les réglages.
- **Aucune injection dans le jeu**, aucun risque d'anti-cheat. C'est juste une fenêtre transparente Windows par-dessus le jeu.

## Coupe le bordel quand t'en as marre

- Clic droit sur l'icône M dans la barre des tâches → **Quitter**
- Ou tape `/unlink` dans Discord (les drops ne passeront plus mais l'app continue de tourner)

Have fun et abuse pas trop 😈
