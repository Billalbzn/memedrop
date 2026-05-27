# MemeDrop — Guide pour les potes 🎯

Tu vas installer MemeDrop. Une fois lancé, n'importe qui sur le Discord pourra te balancer des memes en plein écran pendant que tu joues. **Et toi tu pourras faire pareil avec eux.** ☠️

## Installation (1 minute)

1. **Télécharge** le fichier `MemeDrop-Setup.exe` (lien fourni par kalel95190)
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

Le bot te répond `✅ Linked!` et dans l'app le voyant passe au **vert "LINKED"**.

**C'est bon, tu es opérationnel.** 🎯

## Pour droper un meme sur un pote

```
/drop target:@pseudo  media:[glisse une image]
```

Quelques règles :
- Le pote doit avoir lancé l'app et fait `/link` aussi
- Formats supportés : PNG, JPG, GIF, WEBP, MP4, WEBM
- Taille max : 25 MB
- Un drop maximum toutes les 2 secondes par personne

## Commandes utiles

| Commande | Effet |
|----------|-------|
| `/status` | Vérifier si ton overlay est connecté |
| `/who` | Lister qui peut se faire droper actuellement |
| `/unlink` | Te débrancher (les gens ne peuvent plus te droper) |

## ⚠️ À savoir avant de jouer

- **Fullscreen exclusif → l'overlay n'apparaît pas.** Passe en **borderless** dans les paramètres graphiques de ton jeu. La plupart des jeux modernes (LoL, Valorant, Fortnite...) sont en borderless par défaut.
- L'app reste dans la **barre des tâches Windows** (icône M coral à côté de l'horloge). Clic droit pour quitter, clic pour ouvrir les réglages.
- **Aucune injection dans le jeu**, aucun risque d'anti-cheat. C'est juste une fenêtre transparente Windows par-dessus le jeu.

## Coupe le bordel quand t'en as marre

- Clic droit sur l'icône M dans la barre des tâches → **Quit**
- Ou tape `/unlink` dans Discord (les drops ne passeront plus mais l'app continue de tourner)

Have fun et abuse pas trop 😈
