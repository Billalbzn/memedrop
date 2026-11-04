// overlay.js — renderer for the transparent overlay window.

const stage = document.getElementById('stage');

// ── Drag & drop des médias ────────────────────────────────────────────
//
// Architecture à deux phases :
//
//  Phase 1 — Détection de survol (main process, 16 ms)
//    Le main process sonde screen.getCursorScreenPoint() et envoie la
//    position via IPC "overlay:cursor". Le renderer utilise ces coords
//    pour trouver quel drop est sous le curseur sans jamais bloquer le
//    jeu (setIgnoreMouseEvents reste true).
//
//  Phase 2 — Drag (DOM events)
//    Dès qu'un drop est détecté, on bascule en setIgnoreMouseEvents(false)
//    pour capturer la souris. Les événements DOM (mousemove / mousedown /
//    mouseup) prennent le relais pour le déplacement. Au mouseup ou dès
//    que le curseur quitte le drop, on revient en mode pass-through.
//
// dragState   : null | { anchor, drop, ox, oy }
// hoveredDrop : null | { anchor, drop }
// inCapture   : bool — true = overlay capture la souris
// visualActive: nombre de drops avec .anchor visibles à l'écran

let dragState    = null;
let hoveredDrop  = null;
let inCapture    = false;
let visualActive = 0;

// Marges de détection autour du drop, pour couvrir les contrôles qui
// dépassent du cadre : la croix de fermeture (top:-10px / right:-10px) et
// la barre de réactions (sous le drop) — sans ça, le curseur n'est jamais
// considéré "sur le drop" quand il est dessus et le clic passe au jeu.
const HOVER_MARGIN        = 14;
const HOVER_MARGIN_BOTTOM = 40;   // barre de réactions en dessous

// Renvoie le drop dont le bounding-rect (élargi des marges) contient
// (x, y), ou null.
function findDropAt(x, y) {
  // Du plus récent (peint au-dessus) au plus ancien : avec deux drops qui se
  // chevauchent, c'est celui qu'on voit qui est survolé et déplacé.
  for (let i = stage.children.length - 1; i >= 0; i--) {
    const anchor = stage.children[i];
    const drop = anchor.querySelector('.drop');
    if (!drop || drop.classList.contains('leaving') || drop.classList.contains('closing')) continue;
    const r = drop.getBoundingClientRect();
    if (x >= r.left - HOVER_MARGIN && x <= r.right + HOVER_MARGIN &&
        y >= r.top - HOVER_MARGIN && y <= r.bottom + HOVER_MARGIN_BOTTOM) {
      return { anchor, drop };
    }
  }
  return null;
}

// Passe en mode capture : l'overlay reçoit les événements souris.
function enterCapture(hit) {
  if (inCapture) return;
  inCapture = true;
  hoveredDrop = hit;
  hit.drop.style.cursor = 'grab';
  hit.drop.classList.add('hover');
  window.memedrop.setIgnoreMouse(false);
}

// Revient en mode pass-through : les clics retournent au jeu.
function exitCapture() {
  if (!inCapture || dragState) return;
  inCapture = false;
  if (hoveredDrop) {
    hoveredDrop.drop.style.cursor = '';
    hoveredDrop.drop.classList.remove('hover');
    hoveredDrop = null;
  }
  window.memedrop.setIgnoreMouse(true);
}

// Phase 1 — position du curseur envoyée par le main process (~60 fps)
window.memedrop.onCursor((pos) => {
  if (inCapture) return;          // DOM events gèrent déjà la position
  const hit = findDropAt(pos.x, pos.y);
  if (hit) enterCapture(hit);
});

// Phase 2 — DOM events actifs une fois en mode capture

document.addEventListener('mousemove', (e) => {
  if (!inCapture) return;

  if (dragState) {
    // Déplacer l'anchor pendant le drag (en % de la fenêtre)
    const nx = Math.max(0, Math.min(window.innerWidth,  e.clientX - dragState.ox));
    const ny = Math.max(0, Math.min(window.innerHeight, e.clientY - dragState.oy));
    dragState.anchor.style.left = `${nx / window.innerWidth  * 100}%`;
    dragState.anchor.style.top  = `${ny / window.innerHeight * 100}%`;
    if (spotlightStack.length) updateSpotlight();
    return;
  }

  // Vérifier si le curseur est encore sur un drop
  const hit = findDropAt(e.clientX, e.clientY);
  if (!hit) {
    exitCapture();
  } else if (hit.drop !== hoveredDrop?.drop) {   // findDropAt renvoie un nouvel objet à chaque appel
    if (hoveredDrop) hoveredDrop.drop.classList.remove('hover');
    hoveredDrop = hit;
    hit.drop.style.cursor = 'grab';
    hit.drop.classList.add('hover');
  }
});

document.addEventListener('mousedown', (e) => {
  if (!hoveredDrop || e.button !== 0) return;
  e.preventDefault();

  const { anchor, drop } = hoveredDrop;
  // Offset curseur ↔ centre de l'anchor au moment du clic
  const ax = parseFloat(anchor.style.left) / 100 * window.innerWidth;
  const ay = parseFloat(anchor.style.top)  / 100 * window.innerHeight;

  dragState = { anchor, drop, ox: e.clientX - ax, oy: e.clientY - ay };
  drop.style.cursor = 'grabbing';
  drop.style.animationPlayState = 'paused';   // suspend le bob pendant le drag
});

document.addEventListener('mouseup', () => {
  if (!dragState) return;
  dragState.drop.style.cursor = 'grab';
  dragState.drop.style.animationPlayState = '';   // reprend le bob
  dragState = null;
  // Le prochain mousemove appellera exitCapture si on n'est plus sur un drop
});

// ── Son d'arrivée généré via Web Audio API ────────────────────────────
// L'ancien WAV base64 était trop court (~1 ms) et inaudible.
// On synthétise un "pop" descendant avec un oscillateur + enveloppe gain.
// Un seul AudioContext partagé : en créer un par pop finit par épuiser les
// contextes audio de Chromium quand les drops s'enchaînent.
let popCtx = null;
let popIdleTimer = null;
function playPop(volume) {
  try {
    if (!popCtx || popCtx.state === 'closed') {
      popCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    const ctx  = popCtx;
    clearTimeout(popIdleTimer);
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    const t = ctx.currentTime;
    osc.frequency.setValueAtTime(680, t);
    osc.frequency.exponentialRampToValueAtTime(160, t + 0.13);
    const v = Math.max(0.001, Math.min(1, (volume ?? 0.5) * 1.1));
    gain.gain.setValueAtTime(v, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    osc.start(t);
    osc.stop(t + 0.16);
    osc.addEventListener('ended', () => { osc.disconnect(); gain.disconnect(); });
    // Un AudioContext 'running' fait tourner le thread audio en continu, même
    // muet (la page vit 24 h/24) : on le met en pause une fois le pop joué.
    popIdleTimer = setTimeout(() => { popCtx?.suspend().catch(() => {}); }, 1000);
  } catch {}
}

// Opacité réglable des drops. Elle est posée sur .anchor (pour les drops
// visuels) et via --op sur les enfants des toasts : les animations d'entrée
// (fill-mode forwards) écrasaient toute opacité inline mise sur .drop ou
// .audio-toast, si bien que le curseur "Opacité" n'avait aucun effet.
function clampOpacity(v) {
  return Math.max(0.2, Math.min(1, Number(v ?? 1) || 1));
}

// Contrôle externe des drops (utilisé par l'app Android, où le toucher est
// géré nativement) : chaque .anchor porte un data-key unique.
let dropKeySeq = 0;
const dropControls = new Map();   // key -> { close() }
// Garde le drop entièrement à l'écran (croix et avatar compris) : sur un
// écran étroit, un mème placé près du bord débordait et sa croix devenait
// inaccessible.
const FIT_PAD_X = 20;
const FIT_PAD_TOP = 48;      // avatar + croix au-dessus du média
const FIT_PAD_BOTTOM = 20;
function clampCenter(drop, cx, cy) {
  const hw = (drop?.offsetWidth  || 0) / 2;
  const hh = (drop?.offsetHeight || 0) / 2;
  const clamp = (v, lo, hi) => (lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, v)));
  return {
    x: clamp(cx, hw + FIT_PAD_X, window.innerWidth - hw - FIT_PAD_X),
    y: clamp(cy, hh + FIT_PAD_TOP, window.innerHeight - hh - FIT_PAD_BOTTOM),
  };
}

window.__mdDropCtl = {
  // Place le centre du drop en (cx, cy), en px CSS, sans sortir de l'écran
  move(key, cx, cy) {
    const anchor = stage.querySelector(`.anchor[data-key="${key}"]`);
    if (!anchor) return;
    const { x, y } = clampCenter(anchor.querySelector('.drop'), cx, cy);
    anchor.style.left = `${x / window.innerWidth * 100}%`;
    anchor.style.top  = `${y / window.innerHeight * 100}%`;
    if (spotlightStack.length) updateSpotlight();
  },
  // Recale le drop s'il déborde (appelé une fois sa taille connue)
  fit(key) {
    const anchor = stage.querySelector(`.anchor[data-key="${key}"]`);
    if (anchor) this.move(key, anchor.offsetLeft, anchor.offsetTop);
  },
  close(key) { dropControls.get(String(key))?.close(); },
};

const MAX_CONCURRENT = 6;
const VIDEO_HARD_CAP_SECONDS = 30;
const AUDIO_HARD_CAP_SECONDS = 10;
let active = 0;

// ── File d'attente ────────────────────────────────────────────────────
// Au-delà de MAX_CONCURRENT drops simultanés, les suivants étaient jetés
// en silence. On les met désormais en file et on les joue dès qu'une place
// se libère. MAX_QUEUE évite l'empilement infini en cas de spam.
const MAX_QUEUE = 12;
const dropQueue = [];

function drainQueue() {
  while (dropQueue.length && active < MAX_CONCURRENT) {
    renderDrop(dropQueue.shift());
  }
}

// Décrémente le compteur de drops actifs + notifie + vide la file.
function releaseSlot() {
  active = Math.max(0, active - 1);
  notifyIfIdle();
  drainQueue();
}

const livePlayables = new Set();
// Separate set for audio drops so the "Music volume" slider can target them
// independently of the "Video volume" slider.
const liveAudios = new Set();

// Active drops with metadata. Used by the live settings update so we can
// react to "Image duration" / "Video max duration" changes mid-play.
//   { kind: 'image'|'video', startedAt: number, video: HTMLVideoElement|null,
//     anchor: HTMLElement, removeNow: () => void, scheduleRemoval: (ms) => void }
const liveDrops = new Set();

// Libère tout de suite décodeur, tampon et connexion : un élément seulement
// mis en pause les garde jusqu'au passage du GC (une vidéo fermée continuait
// à se télécharger). removeAttribute + load(), pas src = '' (qui lève 'error').
function releaseMedia(m) {
  if (!m) return;
  try { m.pause(); m.removeAttribute('src'); m.load(); } catch {}
}

// Apply volume to a video/audio element using `muted` when 0.
// HTML5 media elements behave inconsistently with `volume = 0` across
// browsers / Electron versions — explicitly setting `muted` is reliable.
function applyVolume(p, vol) {
  const v = Math.max(0, Math.min(1, vol));
  try {
    if (v === 0) {
      p.muted = true;
      p.volume = 0;
    } else {
      p.muted = false;
      p.volume = v;
    }
  } catch {}
}

// Tire une position (en %) hors de la zone d'exclusion configurée.
// Rejection sampling borné : si la zone couvre presque tout, on garde le
// dernier tirage plutôt que de boucler indéfiniment.
function chooseSpot(avoidZone) {
  const marginX = 14;
  const marginY = 20;
  const rand = () => ({
    x: marginX + Math.random() * (100 - marginX * 2),
    y: marginY + Math.random() * (100 - marginY * 2),
  });
  const inZone = (p) => {
    switch (avoidZone) {
      case 'center': return p.x > 28 && p.x < 72 && p.y > 28 && p.y < 72;
      case 'top':    return p.y < 45;
      case 'bottom': return p.y > 55;
      default:       return false;
    }
  };
  let p = rand();
  for (let i = 0; i < 24 && inZone(p); i++) p = rand();
  return p;
}

// ── Synthèse vocale (drops TTS) ───────────────────────────────────────
// L'audio est généré côté serveur (endpoint /tts du bot Railway) et fourni
// via payload.ttsUrl : le speechSynthesis du renderer Electron est muet sur
// la plupart des PC (Chromium n'embarque aucune voix). La synthèse locale ne
// sert plus que de secours si l'URL manque ou si la lecture échoue.
function speakTTS(text, ttsUrl, settings) {
  const vol = Math.max(0, Math.min(1, settings?.volume ?? 0.75));
  let spoke = false;
  const speakLocal = () => {
    if (spoke) return;   // évite la double lecture (error + play().catch)
    spoke = true;
    try {
      const u = new SpeechSynthesisUtterance(String(text).slice(0, 200));
      u.lang = 'fr-FR';
      u.rate = 1.05;
      u.volume = vol;
      speechSynthesis.speak(u);
    } catch {}
  };
  if (!ttsUrl) return speakLocal();
  try {
    const a = document.createElement('audio');
    a.src = ttsUrl;
    applyVolume(a, vol);
    a.preload = 'auto';
    a.addEventListener('error', speakLocal);
    a.addEventListener('ended', () => releaseMedia(a), { once: true });
    a.play().catch(speakLocal);
  } catch {
    speakLocal();
  }
}

// Toast pour un drop TTS sans média : avatar + texte lu, en haut au centre.
// Ne compte pas dans `active` (discret, hors des slots de drops visuels).
function showTtsToast({ tts, from, settings }) {
  const toast = document.createElement('div');
  toast.className = 'audio-toast';
  toast.style.setProperty('--op', String(clampOpacity(settings?.opacity)));
  toast.appendChild(buildAvatarBubble(from));
  const cap = document.createElement('div');
  cap.className = 'audio-caption';
  cap.textContent = `🗣️ ${String(tts).trim().slice(0, 120)}`;
  toast.appendChild(cap);
  document.body.appendChild(toast);
  // Durée ~ lecture : 60 ms par caractère, entre 3 et 12 s
  const ms = Math.max(3000, Math.min(12000, String(tts).length * 60));
  setTimeout(() => {
    toast.classList.add('leaving');
    setTimeout(() => toast.remove(), 300);
  }, ms);
}

function notifyIfIdle() {
  if (active === 0 && window.memedrop && window.memedrop.stageEmpty) {
    window.memedrop.stageEmpty();
  }
}

// Démarre / arrête le sondage du curseur selon le nombre de drops visuels.
function onVisualDropAdded() {
  visualActive++;
  if (visualActive === 1) window.memedrop.watchCursor?.();
}
function onVisualDropRemoved() {
  visualActive = Math.max(0, visualActive - 1);
  if (visualActive === 0) {
    window.memedrop.unwatchCursor?.();
    exitCapture();
  }
}

// ── Spotlight ─────────────────────────────────────────────────────────
// Voile sombre sur tout l'écran avec un trou centré sur le drop actif.
// Chaque drop actif pousse son anchor dans spotlightStack.
// Mis à jour sur événement (chargement du média via ResizeObserver, drag,
// déplacement Android, resize) et non plus à chaque image : la boucle rAF
// forçait une mise en page et redessinait le dégradé plein écran en continu
// à cause du flottement. Le trou suit donc la position de repos du drop.
const spotlightEl   = document.getElementById('spotlight');
const spotlightStack = []; // anchors actifs, du plus récent au plus ancien
let   spotlightKey   = '';
const spotlightRO = typeof ResizeObserver === 'function'
  ? new ResizeObserver(() => updateSpotlight()) : null;

function updateSpotlight() {
  const anchor = spotlightStack.find(a => a.isConnected);
  if (!anchor) { spotlightEl.style.opacity = '0'; spotlightKey = ''; return; }
  const drop = anchor.querySelector('.drop');
  if (!drop) return;
  // Géométrie de mise en page (hors transform d'entrée / de flottement)
  const cx = anchor.offsetLeft, cy = anchor.offsetTop;
  const rx = drop.offsetWidth / 2 + 70, ry = drop.offsetHeight / 2 + 70;
  const key = `${cx}|${cy}|${rx}|${ry}`;
  if (key === spotlightKey) return;
  spotlightKey = key;
  spotlightEl.style.setProperty('--cx', `${cx}px`);
  spotlightEl.style.setProperty('--cy', `${cy}px`);
  spotlightEl.style.setProperty('--rx', `${rx}px`);
  spotlightEl.style.setProperty('--ry', `${ry}px`);
}

function showSpotlight(anchor) {
  spotlightStack.unshift(anchor);
  const drop = anchor.querySelector('.drop');
  if (drop) spotlightRO?.observe(drop);
  updateSpotlight();
  spotlightEl.style.opacity = '1';
}

function hideSpotlight(anchor) {
  const idx = spotlightStack.indexOf(anchor);
  if (idx < 0) return;
  spotlightStack.splice(idx, 1);
  const drop = anchor.querySelector('.drop');
  if (drop) spotlightRO?.unobserve(drop);
  updateSpotlight();   // passe au drop suivant, ou éteint le voile
}

window.addEventListener('resize', () => { if (spotlightStack.length) updateSpotlight(); });

// ── Pluie d'émojis ────────────────────────────────────────────────────
// Crée N particules tombant depuis le haut avec vitesse, taille et dérive
// aléatoires. Les éléments se retirent automatiquement après la chute.
// `emojis` peut être une chaîne unique (rétro-compat) ou un tableau —
// chaque particule choisit un emoji au hasard parmi ceux fournis.
// Pluies simultanées max (anti-spam : 38 calques animés chacune, et les pluies
// échappent à MAX_CONCURRENT / MAX_QUEUE). Au-delà, la pluie est sautée mais le
// drop lui-même s'affiche.
const MAX_RAINS = 4;
let liveRains = 0;
function renderRain(emojis) {
  if (!emojis) return;
  const pool = Array.isArray(emojis) ? emojis : [emojis];
  if (pool.length === 0) return;
  if (liveRains >= MAX_RAINS) return;
  liveRains++;
  const batch = [];
  let end = 0;
  const COUNT = 38;
  for (let i = 0; i < COUNT; i++) {
    const el = document.createElement('div');
    el.className   = 'rain-emoji';
    el.textContent = pool[Math.floor(Math.random() * pool.length)];

    const x     = Math.random() * 98;                     // % horizontal
    const delay = Math.random() * 2200;                   // ms
    const dur   = 1600 + Math.random() * 1400;            // ms fall duration
    const size  = 22 + Math.random() * 30;                // px
    const sway  = ((Math.random() - 0.5) * 80).toFixed(1); // px derive X
    const rot   = ((Math.random() - 0.5) * 540).toFixed(1) + 'deg'; // rotation finale

    el.style.cssText = `
      left: ${x}%;
      font-size: ${size}px;
      animation-delay: ${delay}ms;
      animation-duration: ${dur}ms;
      --sway: ${sway}px;
      --rot: ${rot};
    `;
    document.body.appendChild(el);
    batch.push(el);
    end = Math.max(end, delay + dur);
  }
  setTimeout(() => { for (const e of batch) e.remove(); liveRains--; }, end + 100);
}

// ── Ajustement du texte (caption) à la largeur du média ──────────────
// La taille CSS par défaut est relative à l'écran (vw) : sur une image
// portrait étroite le texte devenait énorme et débordait. On recalcule donc
// la taille d'après la largeur affichée du média une fois celui-ci chargé,
// avec un contour proportionné.
function fitCaption(bar, mediaEl) {
  if (!bar || !mediaEl) return;
  const apply = () => {
    // Vidéo sans métadonnées : sa largeur est celle du cadre par défaut
    // (300 px), pas celle de la vidéo -> on attend 'loadedmetadata'.
    if (mediaEl.tagName === 'VIDEO' && mediaEl.readyState < 1) return false;
    // Largeur de mise en page : getBoundingClientRect incluait le transform de
    // l'animation d'entrée (scale .6, zoom x3.2, tornade x.05) si le média
    // était déjà chargé (cache, replay).
    const w = mediaEl.offsetWidth;
    if (!w) return false;
    const size = Math.max(13, Math.min(40, Math.round(w * 0.09)));
    bar.style.fontSize = `${size}px`;
    bar.style.webkitTextStroke = `${size >= 26 ? 2 : 1.5}px #000`;
    return true;
  };
  if (apply()) return;
  // Média pas encore chargé / pas encore dans le DOM : on réessaie quand il
  // est prêt ('load' pour <img>, 'loadedmetadata' pour <video>). Le rAF
  // couvre le cas d'une image déjà en cache dont 'load' est déjà passé.
  mediaEl.addEventListener('load', apply, { once: true });
  mediaEl.addEventListener('loadedmetadata', apply, { once: true });
  requestAnimationFrame(() => { if (!apply()) requestAnimationFrame(apply); });
}

function makeInitialFallback(name) {
  const initial = (name || '?').trim().charAt(0).toUpperCase() || '?';
  const div = document.createElement('div');
  div.style.cssText = `
    width:100%;height:100%;border-radius:50%;
    background:linear-gradient(135deg,#ff5e8a,#ffb45e);
    display:flex;align-items:center;justify-content:center;
    color:#fff;font-weight:800;font-size:24px;font-family:system-ui,sans-serif;
  `;
  div.textContent = initial;
  return div;
}

function buildAvatarBubble(from) {
  const bubble = document.createElement('div');
  bubble.className = 'avatar-bubble';
  if (from?.username) bubble.setAttribute('data-username', from.username);
  if (from?.avatar) {
    const av = document.createElement('img');
    av.src = from.avatar;
    av.alt = '';
    av.referrerPolicy = 'no-referrer';
    av.draggable = false;
    av.addEventListener('error', () => av.replaceWith(makeInitialFallback(from.username)));
    bubble.appendChild(av);
  } else {
    bubble.appendChild(makeInitialFallback(from?.username));
  }
  return bubble;
}

// ──────────────────────────────────────────────────────────────────────────
// Audio drops — minimal top-center toast: just avatar bubble + (optional)
// caption underneath. No card, no background. Plays the audio at the same
// time. Designed to barely interrupt the game.
// ──────────────────────────────────────────────────────────────────────────
function playAudioDrop({ media, caption, from, settings }) {
  // Le plafond MAX_CONCURRENT est géré en amont par renderDrop (file d'attente).
  active++;

  const toast = document.createElement('div');
  toast.className = 'audio-toast';
  toast.style.setProperty('--op', String(clampOpacity(settings?.opacity)));

  toast.appendChild(buildAvatarBubble(from));

  if (caption && String(caption).trim()) {
    const cap = document.createElement('div');
    cap.className = 'audio-caption';
    cap.textContent = String(caption).trim().slice(0, 80);
    toast.appendChild(cap);
  }

  document.body.appendChild(toast);

  // Now the actual audio
  const a = document.createElement('audio');
  a.src = media.url;
  // Music drops use the dedicated music volume slider (falls back to general
  // volume for old payloads that don't include musicVolume).
  const musicVol = settings?.musicVolume ?? settings?.volume ?? 0.75;
  applyVolume(a, musicVol);
  a.preload = 'auto';
  liveAudios.add(a);

  let removed = false;
  let deadline = null;
  function cleanup() {
    if (removed) return;
    removed = true;
    clearTimeout(deadline);
    releaseMedia(a);
    liveAudios.delete(a);
    if (toast.isConnected) {
      toast.classList.add('leaving');
      setTimeout(() => {
        toast.remove();
        releaseSlot();
      }, 300);
    } else {
      releaseSlot();
    }
  }

  a.addEventListener('timeupdate', () => {
    if (a.currentTime >= AUDIO_HARD_CAP_SECONDS) cleanup();
  });
  a.addEventListener('ended', cleanup);
  a.addEventListener('error', cleanup);
  a.play().catch(() => cleanup());
  // Filet de sécurité : lien qui ne répond jamais / réseau coupé -> ni 'ended'
  // ni 'error' : le toast et le slot restaient bloqués (les vidéos ont 15 s).
  deadline = setTimeout(cleanup, (AUDIO_HARD_CAP_SECONDS + 15) * 1000);

  if (settings?.soundOnArrival) playPop(settings.volume);
}

let shakeTimer = null;

function renderDrop(payload) {
  const { media, caption, from, settings, music, rain, tts, ttsUrl, effect, dropId } = payload;

  // Plafond atteint → file d'attente (uniquement pour les drops qui
  // consomment un slot, c.-à-d. ceux avec média). Le check vient AVANT le
  // TTS pour ne pas le lire deux fois (à l'empilement puis au défilement).
  if (media && active >= MAX_CONCURRENT) {
    if (dropQueue.length < MAX_QUEUE) dropQueue.push(payload);
    return;
  }

  // Texte lu à voix haute — peut accompagner un média ou venir seul
  if (tts) speakTTS(tts, ttsUrl, settings);

  // Drop sans média visuel : pluie et/ou TTS + son
  if (!media) {
    if (rain) renderRain(rain);
    if (tts) showTtsToast({ tts, from, settings });
    if (settings?.soundOnArrival) playPop(settings.volume);
    return;
  }

  if (media.kind === 'audio') {
    playAudioDrop({ media, caption, from, settings });
    return;
  }

  active++;

  const { x, y } = chooseSpot(settings?.avoidZone);

  const anchor = document.createElement('div');
  anchor.className = 'anchor';
  const dropKey = String(++dropKeySeq);
  anchor.dataset.key = dropKey;
  anchor.style.left = `${x}%`;
  anchor.style.top  = `${y}%`;
  anchor.style.opacity = String(clampOpacity(settings?.opacity));

  const wrap = document.createElement('div');
  wrap.className = 'drop';

  // Effet d'apparition spécial. 'shake' secoue tout l'écran en plus de
  // l'animation d'entrée normale ; les autres remplacent l'animation d'entrée.
  if (effect === 'shake') {
    // Relance la secousse si une autre est en cours (sinon la 2e était
    // coupée par le minuteur de la 1re, ou perdue)
    document.body.classList.remove('fx-shake');
    void document.body.offsetWidth;
    document.body.classList.add('fx-shake');
    clearTimeout(shakeTimer);
    shakeTimer = setTimeout(() => document.body.classList.remove('fx-shake'), 700);
  } else if (effect === 'zoom' || effect === 'tornade' || effect === 'glitch') {
    wrap.classList.add(`fx-${effect}`);
  }

  if (from) wrap.appendChild(buildAvatarBubble(from));

  // Bouton fermer — visible au survol, permet de virer un drop gênant tout
  // de suite sans attendre sa durée de vie.
  const closeBtn = document.createElement('button');
  closeBtn.className = 'drop-close';
  closeBtn.type = 'button';
  closeBtn.title = 'Fermer';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (isVideo && el) { try { el.pause(); } catch {} }
    removeNow({ smooth: true });
  });
  wrap.appendChild(closeBtn);

  // Barre de réactions — le receveur peut réagir d'un emoji, relayé par le
  // bot dans le canal Discord d'où venait le /drop. Une seule réaction.
  if (dropId && from) {
    const REACTION_EMOJIS = ['😂', '💀', '🔥', '😭', '🖕'];
    const bar = document.createElement('div');
    bar.className = 'react-bar';
    for (const emoji of REACTION_EMOJIS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'react-btn';
      btn.textContent = emoji;
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (bar.classList.contains('reacted')) return;
        bar.classList.add('reacted');
        btn.classList.add('chosen');
        window.memedrop.reactDrop?.(dropId, emoji);
      });
      bar.appendChild(btn);
    }
    wrap.appendChild(bar);
  }

  const mediaBox = document.createElement('div');
  mediaBox.className = 'media-box';

  // Two distinct caps now:
  //  - imageMaxSec : how long an image/GIF stays on screen
  //  - videoMaxSec : the ceiling for videos (clipped at this many seconds)
  // Both are bounded by VIDEO_HARD_CAP_SECONDS for safety.
  const imageMaxSec = Math.max(1, Math.min(VIDEO_HARD_CAP_SECONDS,
                                            Number(settings?.duration) || 4));
  // `let` : rescheduleFor le met à jour si la durée max change en direct
  let videoMaxSec = Math.max(1, Math.min(VIDEO_HARD_CAP_SECONDS,
                                          Number(settings?.videoDuration) || 30));
  let lifetime = imageMaxSec * 1000;
  let el;
  let isVideo = false;
  let videoLoadTimer = null;

  if (media.kind === 'video') {
    isVideo = true;
    el = document.createElement('video');
    el.src = media.url;
    el.autoplay = true;
    // Critical for Chromium autoplay policy: even with `el.autoplay`, the
    // element may refuse to honor the volume property until certain events
    // have fired. We apply it both before the source loads and again on
    // every "ready to play" event to be bulletproof.
    // _mdVol = volume courant, suivi par les réglages en direct : réappliquer
    // le volume initial défaisait un changement fait pendant la lecture
    // ('canplay' revient après chaque mise en mémoire tampon).
    el._mdVol = settings?.volume ?? 0.75;
    const reapplyVol = () => applyVolume(el, el._mdVol);
    reapplyVol();
    el.playsInline = true;
    el.loop = false;
    el.dataset.kind = 'video';   // marker for live-update routing
    livePlayables.add(el);

    el.addEventListener('loadedmetadata', () => {
      // Re-apply volume — some Chromium builds reset it after metadata loads
      reapplyVol();
      const natural = el.duration || 0;
      const effective = Math.min(natural, videoMaxSec);
      if (effective > 0) {
        lifetime = effective * 1000 + 300;
        scheduleRemoval();
      }
    });
    el.addEventListener('canplay', reapplyVol);
    el.addEventListener('play',    reapplyVol);
    el.addEventListener('timeupdate', () => {
      if (el.currentTime >= videoMaxSec) {
        try { el.pause(); } catch {}
        removeNow();
      }
    });
    el.addEventListener('ended', () => removeNow());
    // Lien expiré / format illisible : sans ça, 'loadedmetadata' ne venait
    // jamais, aucun retrait n'était planifié et un cadre noir restait à
    // l'écran pour toujours (en occupant un slot).
    el.addEventListener('error', () => removeNow({ smooth: true }));
    videoLoadTimer = setTimeout(() => {
      if (!(el.duration > 0)) removeNow({ smooth: true });
    }, 15_000);
    mediaBox.appendChild(el);
    // Taille connue -> drop (croix comprise) entièrement à l'écran, comme sur
    // Android : un grand mème près d'un bord débordait, croix inaccessible.
    el.addEventListener('loadedmetadata', () => window.__mdDropCtl.fit(dropKey), { once: true });
  } else if (media.kind === 'test') {
    const holder = document.createElement('div');
    holder.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 320 320">
        <defs>
          <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%"   stop-color="#ff5e8a"/>
            <stop offset="100%" stop-color="#ffb45e"/>
          </linearGradient>
        </defs>
        <rect width="320" height="320" rx="22" fill="url(#g)"/>
        <text x="50%" y="48%" text-anchor="middle" font-family="system-ui" font-size="48"
              font-weight="800" fill="#fff">TEST</text>
        <text x="50%" y="62%" text-anchor="middle" font-family="system-ui" font-size="20"
              fill="rgba(255,255,255,.85)">MemeDrop overlay</text>
      </svg>`;
    holder.firstElementChild.style.borderRadius = '14px';
    holder.firstElementChild.style.display = 'block';
    mediaBox.appendChild(holder);
  } else {
    el = document.createElement('img');
    el.src = media.url;
    // Image introuvable (lien Discord expiré…) : on retire le cadre vide
    // tout de suite plutôt que d'afficher une icône cassée.
    el.addEventListener('error', () => removeNow({ smooth: true }));
    el.alt = '';
    el.referrerPolicy = 'no-referrer';
    el.draggable = false;
    mediaBox.appendChild(el);
    el.addEventListener('load', () => window.__mdDropCtl.fit(dropKey), { once: true });
  }

  let captionBar = null;
  if (caption && String(caption).trim()) {
    captionBar = document.createElement('div');
    captionBar.className = 'caption-bar';
    captionBar.textContent = String(caption).trim().slice(0, 80);
    mediaBox.appendChild(captionBar);
  }

  // Barre de vie : se vide pendant la durée d'affichage restante.
  const lifeBar = document.createElement('div');
  lifeBar.className = 'life-bar';
  mediaBox.appendChild(lifeBar);

  wrap.appendChild(mediaBox);
  anchor.appendChild(wrap);
  stage.appendChild(anchor);
  // Une fois dans le DOM, la largeur du média est mesurable (ou le sera à
  // son chargement) : on adapte la taille du texte à cette largeur.
  if (captionBar && el) fitCaption(captionBar, el);
  onVisualDropAdded();   // démarre le sondage curseur si c'est le 1er drop visuel
  if (settings?.spotlightOnDrop) showSpotlight(anchor);
  if (rain) renderRain(rain);

  if (settings?.soundOnArrival) playPop(settings.volume);

  // ── Musique accompagnant une image/GIF ──────────────────────────────
  // Quand le payload contient un champ `music`, on joue l'audio en même
  // temps que l'image. Le volume suit le curseur "Volume musique".
  let musicAudio = null;
  if (music?.url && (media.kind === 'image' || media.kind === 'gif')) {
    musicAudio = document.createElement('audio');
    musicAudio.src = music.url;
    const musicVol = settings?.musicVolume ?? settings?.volume ?? 0.75;
    applyVolume(musicAudio, musicVol);
    musicAudio.preload = 'auto';
    musicAudio.dataset.kind = 'music';
    liveAudios.add(musicAudio);
    musicAudio.addEventListener('error', () => liveAudios.delete(musicAudio));
    musicAudio.play().catch(() => liveAudios.delete(musicAudio));
  }

  // Métadonnées du drop, utilisées par le gestionnaire de mise à jour en direct.
  const dropMeta = {
    kind: isVideo ? 'video' : 'image',
    startedAt: Date.now(),
    video: isVideo ? el : null,
    anchor,
    removeNow: null,
    rescheduleFor: null,
  };

  let removalTimer = null;
  let removed = false;

  // Anime la barre de vie de `fraction` (0..1) jusqu'à 0 en `ms`.
  function runLifeBar(ms, fraction = 1) {
    lifeBar.style.transition = 'none';
    lifeBar.style.transform = `scaleX(${Math.max(0, Math.min(1, fraction))})`;
    void lifeBar.offsetWidth;   // force le reflow avant de relancer la transition
    lifeBar.style.transition = `transform ${Math.max(0, ms)}ms linear`;
    lifeBar.style.transform = 'scaleX(0)';
  }

  function scheduleRemoval() {
    if (removalTimer) clearTimeout(removalTimer);
    if (videoLoadTimer) { clearTimeout(videoLoadTimer); videoLoadTimer = null; }
    dropMeta.startedAt = Date.now();
    removalTimer = setTimeout(removeNow, lifetime);
    runLifeBar(lifetime);
  }

  // `smooth: true` (fermeture manuelle via la croix) → fondu doux, plus
  // rapide que l'animation "drop-out" habituelle (qui simule une chute en
  // fin de vie).
  function removeNow({ smooth = false } = {}) {
    if (removed || !anchor.isConnected) return;
    removed = true;
    if (removalTimer) clearTimeout(removalTimer);
    if (videoLoadTimer) clearTimeout(videoLoadTimer);
    if (isVideo) { try { el.pause(); } catch {} livePlayables.delete(el); }
    // Drop retiré pendant qu'on le fait glisser : on relâche la capture,
    // sinon l'overlay plein écran continuait à intercepter la souris.
    if (dragState?.anchor === anchor) dragState = null;
    // Le drag avait mis les animations en pause : la sortie resterait figée
    wrap.style.animationPlayState = '';
    if (hoveredDrop?.anchor === anchor) exitCapture();
    // Stoppe la musique liée à cette image si elle joue encore
    if (musicAudio) {
      releaseMedia(musicAudio);
      liveAudios.delete(musicAudio);
    }
    liveDrops.delete(dropMeta);
    dropControls.delete(dropKey);
    wrap.classList.add(smooth ? 'closing' : 'leaving');
    setTimeout(() => {
      anchor.remove();
      // Après l'animation de sortie, pour garder la dernière image visible
      if (isVideo) releaseMedia(el);
      hideSpotlight(anchor);
      onVisualDropRemoved();   // arrête le sondage + exitCapture si plus aucun drop
      releaseSlot();
    }, smooth ? 220 : 400);
  }

  // Adjust the remaining lifetime based on a new cap (in seconds).
  // For videos: cap = min(natural duration, newCapSec)
  // For images: cap = newCapSec
  // Then compares to elapsed time and either stops now or reschedules.
  function rescheduleFor(newCapSec) {
    if (removed) return;
    // Le contrôle 'timeupdate' utilise aussi ce plafond
    if (dropMeta.kind === 'video') videoMaxSec = newCapSec;
    const elapsedMs = Date.now() - dropMeta.startedAt;
    let newCapMs;
    if (dropMeta.kind === 'video' && dropMeta.video) {
      const natural = (dropMeta.video.duration || 0) * 1000;
      newCapMs = Math.min(
        natural > 0 ? natural : Infinity,
        newCapSec * 1000
      );
    } else {
      newCapMs = newCapSec * 1000;
    }
    lifetime = newCapMs;
    if (elapsedMs >= newCapMs) {
      // Already exceeded the new cap — stop right now
      if (dropMeta.video) { try { dropMeta.video.pause(); } catch {} }
      removeNow();
    } else {
      if (removalTimer) clearTimeout(removalTimer);
      removalTimer = setTimeout(removeNow, newCapMs - elapsedMs);
      runLifeBar(newCapMs - elapsedMs, (newCapMs - elapsedMs) / newCapMs);
    }
  }

  dropMeta.removeNow = removeNow;
  dropControls.set(dropKey, {
    close() {
      if (isVideo && el) { try { el.pause(); } catch {} }
      removeNow({ smooth: true });
    },
  });
  dropMeta.rescheduleFor = rescheduleFor;
  liveDrops.add(dropMeta);

  if (!isVideo) scheduleRemoval();
}

window.memedrop.onDrop((payload) => {
  if (!payload) return;
  // Pluie vide : rien à montrer (sinon le pop sonnait sur un écran vide)
  if (Array.isArray(payload.rain) && payload.rain.length === 0) payload.rain = null;
  if (!payload.media && !payload.rain && !payload.tts) return; // rien à afficher
  renderDrop(payload);
});

if (window.memedrop.onSettingsUpdate) {
  window.memedrop.onSettingsUpdate((settings) => {
    if (!settings || typeof settings !== 'object') return;
    // Les drops en file jouent avec les réglages à jour (Windows n'envoie que
    // les clés modifiées, Android le jeu complet : la fusion marche pour les deux)
    for (const q of dropQueue) q.settings = { ...q.settings, ...settings };
    // Video volume slider → only affects currently-playing videos
    if (typeof settings?.volume === 'number') {
      for (const p of livePlayables) { p._mdVol = settings.volume; applyVolume(p, settings.volume); }
    }
    // Music volume slider → only affects currently-playing audio drops
    if (typeof settings?.musicVolume === 'number') {
      for (const a of liveAudios) applyVolume(a, settings.musicVolume);
    }
    // Image duration → reschedule images currently on screen
    if (typeof settings?.duration === 'number') {
      for (const d of liveDrops) {
        if (d.kind === 'image' && d.rescheduleFor) d.rescheduleFor(settings.duration);
      }
    }
    // Video max duration → reschedule videos currently on screen
    if (typeof settings?.videoDuration === 'number') {
      for (const d of liveDrops) {
        if (d.kind === 'video' && d.rescheduleFor) d.rescheduleFor(settings.videoDuration);
      }
    }
    if (typeof settings?.opacity === 'number') {
      const op = String(clampOpacity(settings.opacity));
      document.querySelectorAll('.anchor').forEach(a => { a.style.opacity = op; });
      document.querySelectorAll('.audio-toast').forEach(t => t.style.setProperty('--op', op));
    }
    // Spotlight toggle : si désactivé en direct, on éteint immédiatement
    // (on vide aussi la pile : sinon un drop plus ancien pouvait rallumer le voile)
    if (typeof settings?.spotlightOnDrop === 'boolean' && !settings.spotlightOnDrop) {
      spotlightStack.length = 0;
      spotlightRO?.disconnect();
      updateSpotlight();
    }
    // Thème — change les couleurs d'accent (bulle avatar) à la volée
    if (typeof settings?.theme === 'string') {
      document.documentElement.dataset.theme = settings.theme;
    }
  });
}

// Applique le thème choisi au chargement de l'overlay
window.memedrop.getSettings().then((s) => {
  if (s?.theme) document.documentElement.dataset.theme = s.theme;
}).catch(() => {});
