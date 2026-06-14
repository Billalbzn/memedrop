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

// Marge de détection autour du drop, pour couvrir le bouton fermer qui
// dépasse du cadre (top:-10px / right:-10px, 26px de large) — sans ça, le
// curseur n'est jamais considéré "sur le drop" quand il est sur la croix et
// le clic passe au travers vers le jeu.
const HOVER_MARGIN = 14;

// Renvoie le drop dont le bounding-rect (élargi de HOVER_MARGIN) contient
// (x, y), ou null.
function findDropAt(x, y) {
  for (const anchor of stage.querySelectorAll('.anchor')) {
    const drop = anchor.querySelector('.drop');
    if (!drop || drop.classList.contains('leaving') || drop.classList.contains('closing')) continue;
    const r = drop.getBoundingClientRect();
    if (x >= r.left - HOVER_MARGIN && x <= r.right + HOVER_MARGIN &&
        y >= r.top - HOVER_MARGIN && y <= r.bottom + HOVER_MARGIN) {
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
    return;
  }

  // Vérifier si le curseur est encore sur un drop
  const hit = findDropAt(e.clientX, e.clientY);
  if (!hit) {
    exitCapture();
  } else if (hit !== hoveredDrop) {
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
function playPop(volume) {
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
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
    osc.addEventListener('ended', () => ctx.close().catch(() => {}));
  } catch {}
}

const MAX_CONCURRENT = 6;
const VIDEO_HARD_CAP_SECONDS = 30;
const AUDIO_HARD_CAP_SECONDS = 10;
let active = 0;

const livePlayables = new Set();
// Separate set for audio drops so the "Music volume" slider can target them
// independently of the "Video volume" slider.
const liveAudios = new Set();

// Active drops with metadata. Used by the live settings update so we can
// react to "Image duration" / "Video max duration" changes mid-play.
//   { kind: 'image'|'video', startedAt: number, video: HTMLVideoElement|null,
//     anchor: HTMLElement, removeNow: () => void, scheduleRemoval: (ms) => void }
const liveDrops = new Set();

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
    console.log('[volume] applied', v, '→ muted=', p.muted, 'volume=', p.volume, 'on', p.tagName, p.dataset.kind || '');
  } catch (e) {
    console.error('[volume] applyVolume failed:', e);
  }
}

function chooseSpot() {
  const marginX = 14;
  const marginY = 20;
  const x = marginX + Math.random() * (100 - marginX * 2);
  const y = marginY + Math.random() * (100 - marginY * 2);
  return { x, y };
}

function playPop(volume) {
  try {
    const a = new Audio(popUrl);
    applyVolume(a, volume ?? 0.5);
    a.play().catch(() => {});
  } catch {}
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
// Un rAF met à jour la position en continu (fonctionne aussi pendant le drag).
const spotlightEl   = document.getElementById('spotlight');
const spotlightStack = []; // anchors actifs, du plus récent au plus ancien
let   spotlightRAF   = null;

function tickSpotlight() {
  const anchor = spotlightStack.find(a => a.isConnected);
  if (!anchor) {
    spotlightEl.style.opacity = '0';
    spotlightRAF = null;
    return;
  }
  const drop = anchor.querySelector('.drop');
  if (drop) {
    const r  = drop.getBoundingClientRect();
    const cx = r.left + r.width  / 2;
    const cy = r.top  + r.height / 2;
    const rx = r.width  / 2 + 70;
    const ry = r.height / 2 + 70;
    spotlightEl.style.setProperty('--cx', `${cx}px`);
    spotlightEl.style.setProperty('--cy', `${cy}px`);
    spotlightEl.style.setProperty('--rx', `${rx}px`);
    spotlightEl.style.setProperty('--ry', `${ry}px`);
  }
  spotlightRAF = requestAnimationFrame(tickSpotlight);
}

function showSpotlight(anchor) {
  spotlightStack.unshift(anchor);
  spotlightEl.style.opacity = '1';
  if (!spotlightRAF) spotlightRAF = requestAnimationFrame(tickSpotlight);
}

function hideSpotlight(anchor) {
  const idx = spotlightStack.indexOf(anchor);
  if (idx >= 0) spotlightStack.splice(idx, 1);
  if (spotlightStack.filter(a => a.isConnected).length === 0) {
    spotlightEl.style.opacity = '0';
    if (spotlightRAF) { cancelAnimationFrame(spotlightRAF); spotlightRAF = null; }
  }
}

// ── Pluie d'émojis ────────────────────────────────────────────────────
// Crée N particules tombant depuis le haut avec vitesse, taille et dérive
// aléatoires. Les éléments se retirent automatiquement après la chute.
// `emojis` peut être une chaîne unique (rétro-compat) ou un tableau —
// chaque particule choisit un emoji au hasard parmi ceux fournis.
function renderRain(emojis) {
  if (!emojis) return;
  const pool = Array.isArray(emojis) ? emojis : [emojis];
  if (pool.length === 0) return;
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
    setTimeout(() => el.remove(), delay + dur + 100);
  }
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
  if (active >= MAX_CONCURRENT) return;
  active++;

  const toast = document.createElement('div');
  toast.className = 'audio-toast';
  toast.style.opacity = String(settings?.opacity ?? 1);

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
  function cleanup() {
    if (removed) return;
    removed = true;
    try { a.pause(); } catch {}
    liveAudios.delete(a);
    if (toast.isConnected) {
      toast.classList.add('leaving');
      setTimeout(() => {
        toast.remove();
        active = Math.max(0, active - 1);
        notifyIfIdle();
      }, 300);
    } else {
      active = Math.max(0, active - 1);
      notifyIfIdle();
    }
  }

  a.addEventListener('timeupdate', () => {
    if (a.currentTime >= AUDIO_HARD_CAP_SECONDS) cleanup();
  });
  a.addEventListener('ended', cleanup);
  a.addEventListener('error', cleanup);
  a.play().catch(() => cleanup());

  if (settings?.soundOnArrival) playPop(settings.volume);
}

function renderDrop({ media, caption, from, settings, music, rain }) {
  // Drop pluie seule — pas de média visuel, juste les émojis + son
  if (!media) {
    if (rain) renderRain(rain);
    if (settings?.soundOnArrival) playPop(settings.volume);
    return;
  }

  if (media.kind === 'audio') {
    playAudioDrop({ media, caption, from, settings });
    return;
  }

  if (active >= MAX_CONCURRENT) return;
  active++;

  const { x, y } = chooseSpot();

  const anchor = document.createElement('div');
  anchor.className = 'anchor';
  anchor.style.left = `${x}%`;
  anchor.style.top  = `${y}%`;

  const wrap = document.createElement('div');
  wrap.className = 'drop';
  wrap.style.opacity = String(settings?.opacity ?? 1);

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

  const mediaBox = document.createElement('div');
  mediaBox.className = 'media-box';

  // Two distinct caps now:
  //  - imageMaxSec : how long an image/GIF stays on screen
  //  - videoMaxSec : the ceiling for videos (clipped at this many seconds)
  // Both are bounded by VIDEO_HARD_CAP_SECONDS for safety.
  const imageMaxSec = Math.max(1, Math.min(VIDEO_HARD_CAP_SECONDS,
                                            Number(settings?.duration) || 4));
  const videoMaxSec = Math.max(1, Math.min(VIDEO_HARD_CAP_SECONDS,
                                            Number(settings?.videoDuration) || 30));
  let lifetime = imageMaxSec * 1000;
  let el;
  let isVideo = false;

  if (media.kind === 'video') {
    isVideo = true;
    el = document.createElement('video');
    el.src = media.url;
    el.autoplay = true;
    // Critical for Chromium autoplay policy: even with `el.autoplay`, the
    // element may refuse to honor the volume property until certain events
    // have fired. We apply it both before the source loads and again on
    // every "ready to play" event to be bulletproof.
    const initialVideoVol = settings?.volume ?? 0.75;
    applyVolume(el, initialVideoVol);
    el.playsInline = true;
    el.loop = false;
    el.dataset.kind = 'video';   // marker for live-update routing
    livePlayables.add(el);

    el.addEventListener('loadedmetadata', () => {
      // Re-apply volume — some Chromium builds reset it after metadata loads
      applyVolume(el, initialVideoVol);
      const natural = el.duration || 0;
      const effective = Math.min(natural, videoMaxSec);
      if (effective > 0) {
        lifetime = effective * 1000 + 300;
        scheduleRemoval();
      }
    });
    el.addEventListener('canplay', () => applyVolume(el, initialVideoVol));
    el.addEventListener('play',    () => applyVolume(el, initialVideoVol));
    el.addEventListener('timeupdate', () => {
      if (el.currentTime >= videoMaxSec) {
        try { el.pause(); } catch {}
        removeNow();
      }
    });
    el.addEventListener('ended', () => removeNow());
    mediaBox.appendChild(el);
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
    el.alt = '';
    el.referrerPolicy = 'no-referrer';
    el.draggable = false;
    mediaBox.appendChild(el);
  }

  if (caption && String(caption).trim()) {
    const bar = document.createElement('div');
    bar.className = 'caption-bar';
    bar.textContent = String(caption).trim().slice(0, 80);
    mediaBox.appendChild(bar);
  }

  wrap.appendChild(mediaBox);
  anchor.appendChild(wrap);
  stage.appendChild(anchor);
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

  function scheduleRemoval() {
    if (removalTimer) clearTimeout(removalTimer);
    removalTimer = setTimeout(removeNow, lifetime);
  }

  // `smooth: true` (fermeture manuelle via la croix) → fondu doux, plus
  // rapide que l'animation "drop-out" habituelle (qui simule une chute en
  // fin de vie).
  function removeNow({ smooth = false } = {}) {
    if (removed || !anchor.isConnected) return;
    removed = true;
    if (isVideo) livePlayables.delete(el);
    // Stoppe la musique liée à cette image si elle joue encore
    if (musicAudio) {
      try { musicAudio.pause(); } catch {}
      liveAudios.delete(musicAudio);
    }
    liveDrops.delete(dropMeta);
    wrap.classList.add(smooth ? 'closing' : 'leaving');
    setTimeout(() => {
      anchor.remove();
      hideSpotlight(anchor);
      onVisualDropRemoved();   // arrête le sondage + exitCapture si plus aucun drop
      active = Math.max(0, active - 1);
      notifyIfIdle();
    }, smooth ? 220 : 400);
  }

  // Adjust the remaining lifetime based on a new cap (in seconds).
  // For videos: cap = min(natural duration, newCapSec)
  // For images: cap = newCapSec
  // Then compares to elapsed time and either stops now or reschedules.
  function rescheduleFor(newCapSec) {
    if (removed) return;
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
    }
  }

  dropMeta.removeNow = removeNow;
  dropMeta.rescheduleFor = rescheduleFor;
  liveDrops.add(dropMeta);

  if (!isVideo) scheduleRemoval();
}

window.memedrop.onDrop((payload) => {
  if (!payload) return;
  if (!payload.media && !payload.rain) return; // rien à afficher
  renderDrop(payload);
});

if (window.memedrop.onSettingsUpdate) {
  window.memedrop.onSettingsUpdate((settings) => {
    console.log('[settings-update] received:', settings, 'liveVideos=', livePlayables.size, 'liveAudios=', liveAudios.size, 'liveDrops=', liveDrops.size);
    // Video volume slider → only affects currently-playing videos
    if (typeof settings?.volume === 'number') {
      for (const p of livePlayables) applyVolume(p, settings.volume);
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
      const op = String(Math.max(0.2, Math.min(1, settings.opacity)));
      document.querySelectorAll('.drop, .audio-toast').forEach(d => { d.style.opacity = op; });
    }
    // Spotlight toggle : si désactivé en direct, on éteint immédiatement
    if (typeof settings?.spotlightOnDrop === 'boolean' && !settings.spotlightOnDrop) {
      spotlightEl.style.opacity = '0';
      if (spotlightRAF) { cancelAnimationFrame(spotlightRAF); spotlightRAF = null; }
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
