// overlay.js — renderer for the transparent overlay window.

const stage = document.getElementById('stage');

const popUrl = 'data:audio/wav;base64,UklGRoQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YWAAAAAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA';

const MAX_CONCURRENT = 6;
const VIDEO_HARD_CAP_SECONDS = 30;
const AUDIO_HARD_CAP_SECONDS = 10;   // chad-mode audio drops are short by design
let active = 0;

// Track live audio + video elements so we can apply live volume changes
const livePlayables = new Set();

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
    a.volume = Math.max(0, Math.min(1, volume ?? 0.5));
    a.play().catch(() => {});
  } catch {}
}

function notifyIfIdle() {
  if (active === 0 && window.memedrop && window.memedrop.stageEmpty) {
    window.memedrop.stageEmpty();
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Audio drops are CHAD MODE: pure ear-attack, nothing on screen.
// We bypass the whole stage rendering and just play the file.
// ──────────────────────────────────────────────────────────────────────────
function playAudioDrop({ media, settings }) {
  if (active >= MAX_CONCURRENT) return;
  active++;

  const a = document.createElement('audio');
  a.src = media.url;
  a.volume = settings?.volume ?? 0.75;
  a.preload = 'auto';
  livePlayables.add(a);

  let removed = false;
  function cleanup() {
    if (removed) return;
    removed = true;
    try { a.pause(); } catch {}
    livePlayables.delete(a);
    active = Math.max(0, active - 1);
    notifyIfIdle();
  }

  a.addEventListener('timeupdate', () => {
    if (a.currentTime >= AUDIO_HARD_CAP_SECONDS) cleanup();
  });
  a.addEventListener('ended', cleanup);
  a.addEventListener('error', cleanup);

  a.play().catch(() => cleanup());
}

function renderDrop({ media, caption, from, settings }) {
  // Audio = invisible chad-mode drop
  if (media.kind === 'audio') {
    playAudioDrop({ media, settings });
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

  // Avatar bubble — replaces the old text tag with a circular profile pic
  if (from) {
    const bubble = document.createElement('div');
    bubble.className = 'avatar-bubble';
    bubble.setAttribute('data-username', from.username || 'someone');

    if (from.avatar) {
      const av = document.createElement('img');
      av.src = from.avatar;
      av.alt = '';
      av.referrerPolicy = 'no-referrer';
      av.draggable = false;
      // Fallback if Discord CDN hiccups
      av.addEventListener('error', () => {
        av.replaceWith(makeInitialFallback(from.username));
      });
      bubble.appendChild(av);
    } else {
      bubble.appendChild(makeInitialFallback(from.username));
    }

    wrap.appendChild(bubble);
  }

  const mediaBox = document.createElement('div');
  mediaBox.className = 'media-box';

  const userMaxSec = Math.max(1, Math.min(VIDEO_HARD_CAP_SECONDS, Number(settings?.duration) || 4));
  let lifetime = userMaxSec * 1000;
  let el;
  let isVideo = false;

  if (media.kind === 'video') {
    isVideo = true;
    el = document.createElement('video');
    el.src = media.url;
    el.autoplay = true;
    el.muted = false;
    el.volume = settings?.volume ?? 0.75;
    el.playsInline = true;
    el.loop = false;
    livePlayables.add(el);

    el.addEventListener('loadedmetadata', () => {
      const natural = el.duration || 0;
      const effective = Math.min(natural, VIDEO_HARD_CAP_SECONDS, userMaxSec);
      if (effective > 0) {
        lifetime = effective * 1000 + 300;
        scheduleRemoval();
      }
    });
    el.addEventListener('timeupdate', () => {
      if (el.currentTime >= Math.min(VIDEO_HARD_CAP_SECONDS, userMaxSec)) {
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

// Fallback when avatar fails to load — first letter on a coral gradient
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

window.memedrop.onDrop((payload) => {
  if (!payload || !payload.media) return;
  renderDrop(payload);
});

if (window.memedrop.onSettingsUpdate) {
  window.memedrop.onSettingsUpdate((settings) => {
    if (typeof settings?.volume === 'number') {
      const vol = Math.max(0, Math.min(1, settings.volume));
      for (const p of livePlayables) {
        try { p.volume = vol; } catch {}
      }
    }
    if (typeof settings?.opacity === 'number') {
      const op = String(Math.max(0.2, Math.min(1, settings.opacity)));
      document.querySelectorAll('.drop').forEach(d => { d.style.opacity = op; });
    }
  });
}
