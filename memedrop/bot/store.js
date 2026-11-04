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
  const empty = { favorites: {}, groups: {}, stats: {} };
  let raw;
  try {
    raw = fs.readFileSync(DATA_FILE, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.log(`[store] aucun store.json dans ${DATA_DIR} — démarrage à vide`);
      return empty;
    }
    // EACCES, EIO, EISDIR… (volume en cours de montage, disque malade) : le
    // fichier est peut-être intact. Démarrer à vide le ferait écraser par la
    // première sauvegarde ; on sort et l'hébergeur relance le process.
    console.error(`[store] lecture de ${DATA_FILE} impossible (${e.code || e.message}) — arrêt`);
    process.exit(1);
  }
  try {
    const data = JSON.parse(raw);
    const out = {
      favorites: data.favorites || {},
      groups: data.groups || {},
      stats: data.stats || {},
    };
    // Un store vide après un déploiement (volume non monté…) se voit ici
    const nFav = Object.values(out.favorites).reduce((n, l) => n + (Array.isArray(l) ? l.length : 0), 0);
    const nGrp = Object.values(out.groups).reduce((n, g) => n + Object.keys(g || {}).length, 0);
    console.log(`[store] ${DATA_FILE} : ${nFav} favoris, ${nGrp} groupes`);
    return out;
  } catch (e) {
    // Lu mais inexploitable (JSON cassé par une édition à la main, `null`…) :
    // on le met de côté au lieu de laisser la prochaine sauvegarde l'écraser.
    const aside = `${DATA_FILE}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(DATA_FILE, aside);
    } catch (re) {
      console.error(`[store] store.json illisible et impossible à mettre de côté (${re.message}) — arrêt`);
      process.exit(1);
    }
    console.error(`[store] store.json illisible (${e.message}), renommé en ${aside}`);
    return empty;
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
// `data` : l'objet à écrire, ou une fonction qui le construit au moment de
// l'écriture (un seul instantané pour une rafale de changements).
// Écrit au plus 500 ms après le PREMIER changement : relancer le minuteur à
// chaque appel pouvait repousser l'écriture indéfiniment.
function save(data) {
  pendingData = data;
  if (!saveTimer) saveTimer = setTimeout(flush, 500);
}

// Écrit immédiatement une sauvegarde en attente (appelé à l'arrêt du bot,
// sinon les 500 ms de debounce pouvaient perdre les derniers changements).
function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (!pendingData) return;
  const data = typeof pendingData === 'function' ? pendingData() : pendingData;
  pendingData = null;
  writeNow(data);
}

module.exports = { load, save, flush, DATA_FILE };
