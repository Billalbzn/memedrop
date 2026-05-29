// overlay.js — renderer for the transparent overlay window.

const stage = document.getElementById('stage');

const popUrl = 'data:audio/wav;base64,UklGRoQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YWAAAAAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA';

const MAX_CONCURRENT = 6;
const VIDEO_HARD_CAP_SECONDS = 30;
const AUDIO_HARD_CAP_SECONDS = 10;
let active = 0;

const livePlayables = new Set();
// Separate set for audio drops so the "Music volume" slider can target them
// independently of the "Video volume" slider.
const liveAudios = new Set();

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

function renderDrop({ media, caption, from, settings }) {
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

  if (settings?.soundOnArrival) playPop(settings.volume);

  let removalTimer = null;
  let removed = false;
  function scheduleRemoval() {
    if (removalTimer) clearTimeout(removalTimer);
    removalTimer = setTimeout(removeNow, lifetime);
  }
  function removeNow() {
    if (removed || !anchor.isConnected) return;
    removed = true;
    if (isVideo) livePlayables.delete(el);
    wrap.classList.add('leaving');
    setTimeout(() => {
      anchor.remove();
      active = Math.max(0, active - 1);
      notifyIfIdle();
    }, 400);
  }

  if (!isVideo) scheduleRemoval();
}

window.memedrop.onDrop((payload) => {
  if (!payload || !payload.media) return;
  renderDrop(payload);
});

if (window.memedrop.onSettingsUpdate) {
  window.memedrop.onSettingsUpdate((settings) => {
    // Video volume slider → only affects currently-playing videos
    if (typeof settings?.volume === 'number') {
      for (const p of livePlayables) applyVolume(p, settings.volume);
    }
    // Music volume slider → only affects currently-playing audio drops
    if (typeof settings?.musicVolume === 'number') {
      for (const a of liveAudios) applyVolume(a, settings.musicVolume);
    }
    if (typeof settings?.opacity === 'number') {
      const op = String(Math.max(0.2, Math.min(1, settings.opacity)));
      document.querySelectorAll('.drop, .audio-toast').forEach(d => { d.style.opacity = op; });
    }
  });
}
