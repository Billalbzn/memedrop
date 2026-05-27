// overlay.js — renderer for the transparent overlay window.

const stage = document.getElementById('stage');

const popUrl = 'data:audio/wav;base64,UklGRoQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YWAAAAAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA';

const MAX_CONCURRENT = 6;
let active = 0;

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

function renderDrop({ media, caption, from, settings }) {
  if (active >= MAX_CONCURRENT) return;
  active++;

  const { x, y } = chooseSpot();

  // Zero-size anchor for centering — animations live on .drop
  const anchor = document.createElement('div');
  anchor.className = 'anchor';
  anchor.style.left = `${x}%`;
  anchor.style.top  = `${y}%`;

  const wrap = document.createElement('div');
  wrap.className = 'drop';
  wrap.style.opacity = String(settings?.opacity ?? 1);

  // Sender tag (small pill at the top)
  const tag = document.createElement('div');
  tag.className = 'tag';
  tag.textContent = `@${from?.username || 'someone'}`;
  wrap.appendChild(tag);

  // Caption ribbon — diagonal sash with gradient, like a meme stamp.
  // Only added if caption is non-empty.
  if (caption && String(caption).trim()) {
    const ribbon = document.createElement('div');
    ribbon.className = 'caption-ribbon';
    ribbon.textContent = String(caption).trim().slice(0, 80);
    // Subtle rotation per drop so it looks hand-placed
    const rot = -8 + Math.random() * 16; // -8° to +8°
    ribbon.style.setProperty('--rot', `${rot}deg`);
    wrap.appendChild(ribbon);
  }

  let lifetime = (settings?.duration ?? 4) * 1000;
  let el;

  if (media.kind === 'video') {
    el = document.createElement('video');
    el.src = media.url;
    el.autoplay = true;
    el.muted = false;
    el.volume = settings?.volume ?? 0.75;
    el.playsInline = true;
    el.loop = false;
    el.addEventListener('loadedmetadata', () => {
      const d = Math.min(12, el.duration || 0);
      if (d > 0) {
        lifetime = d * 1000 + 200;
        scheduleRemoval();
      }
    });
    el.addEventListener('ended', () => removeNow());
  } else if (media.kind === 'test') {
    el = document.createElement('div');
    el.innerHTML = `
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
    el.firstElementChild.style.borderRadius = '14px';
    el.firstElementChild.style.display = 'block';
  } else {
    // image / gif — handled the same way; the <img> tag plays GIFs natively
    el = document.createElement('img');
    el.src = media.url;
    el.alt = '';
    el.referrerPolicy = 'no-referrer';
    el.draggable = false;
  }

  wrap.appendChild(el);
  anchor.appendChild(wrap);
  stage.appendChild(anchor);

  if (settings?.soundOnArrival) playPop(settings.volume);

  let removalTimer = null;
  function scheduleRemoval() {
    if (removalTimer) clearTimeout(removalTimer);
    removalTimer = setTimeout(removeNow, lifetime);
  }
  function removeNow() {
    if (!anchor.isConnected) return;
    wrap.classList.add('leaving');
    setTimeout(() => {
      anchor.remove();
      active = Math.max(0, active - 1);
    }, 400);
  }

  if (media.kind !== 'video') scheduleRemoval();
}

window.memedrop.onDrop((payload) => {
  if (!payload || !payload.media) return;
  renderDrop(payload);
});
