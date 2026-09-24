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
      stats: data.stats || {},
    };
  } catch {
    return { favorites: {}, groups: {}, stats: {} };
  }
}

// Écriture atomique (fichier temporaire + rename) : un crash ou un redeploy
// pendant l'écriture ne laisse jamais un store.json tronqué, qui ferait
// perdre tous les favoris/groupes/stats au prochain démarrage.
function writeNow(data) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error('[store] save failed:', e.message);
  }
}

let saveTimer = null;
let pendingData = null;
function save(data) {
  pendingData = data;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 500);
}

// Écrit immédiatement une sauvegarde en attente (appelé à l'arrêt du bot,
// sinon les 500 ms de debounce pouvaient perdre les derniers changements).
function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (!pendingData) return;
  const data = pendingData;
  pendingData = null;
  writeNow(data);
}

module.exports = { load, save, flush, DATA_FILE };
