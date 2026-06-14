// store.js — persistance JSON simple pour les favoris et groupes cibles.
//
// Les liens (userLinks) eux-mêmes n'ont pas besoin d'être persistés ici :
// l'overlay rejoue son identité via `register` (voir index.js) et survit
// donc déjà aux redémarrages/redeploys tant que LINK_SECRET est stable.
// En revanche, favoris et groupes n'ont aucune copie côté client — sans ce
// fichier ils seraient perdus à chaque redémarrage du bot.
//
// Sur Railway, le système de fichiers est éphémère entre deux déploiements :
// pour que ce fichier survive aux redeploys, monte un volume persistant sur
// le dossier `data/` (sinon les favoris/groupes survivent seulement aux
// simples restarts du process, pas aux redeploys).
const fs = require('fs');
const path = require('path');

const DATA_DIR  = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');

function load() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const data = JSON.parse(raw);
    return {
      favorites: data.favorites || {},
      groups: data.groups || {},
    };
  } catch {
    return { favorites: {}, groups: {} };
  }
}

let saveTimer = null;
function save(data) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error('[store] save failed:', e.message);
    }
  }, 500);
}

module.exports = { load, save, DATA_FILE };
