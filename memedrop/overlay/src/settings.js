// settings.js — renderer logic for the settings window
const $ = (sel) => document.querySelector(sel);

// ── Connection pill ─────────────────────────────────────────────────────────
const pill        = $('#conn-pill');
const pillLabel   = pill.querySelector('.label');
const pairingCard = $('#pairing-card');
const linkedCard  = $('#linked-card');
const pairingCode = $('#pairing-code');
const linkedUser  = $('#linked-user');

function applyConnState(state) {
  pill.className = 'pill';
  pairingCard.classList.add('hidden');
  linkedCard.classList.add('hidden');

  switch (state.status) {
    case 'connecting':
      pill.classList.add('pill--connecting');
      pillLabel.textContent = 'connecting';
      break;
    case 'awaiting_link':
      pill.classList.add('pill--awaiting');
      pillLabel.textContent = 'awaiting link';
      pairingCard.classList.remove('hidden');
      pairingCode.textContent = state.code || '------';
      break;
    case 'linked':
      pill.classList.add('pill--linked');
      pillLabel.textContent = 'linked';
      linkedCard.classList.remove('hidden');
      linkedUser.textContent = state.user?.username || '—';
      break;
    case 'connected':
      pill.classList.add('pill--connecting');
      pillLabel.textContent = 'connected';
      break;
    case 'disconnected':
    default:
      pill.classList.add('pill--down');
      pillLabel.textContent = 'offline';
      break;
  }
}

window.memedrop.onConnection(applyConnState);
window.memedrop.getConnection().then(applyConnState);

// ── Copy pairing code ───────────────────────────────────────────────────────
$('#copy-code').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(pairingCode.textContent);
    const btn = $('#copy-code');
    const original = btn.textContent;
    btn.textContent = 'copied ✓';
    setTimeout(() => { btn.textContent = original; }, 1200);
  } catch {}
});

// ── Force reconnect & test drop ─────────────────────────────────────────────
$('#reconnect-btn').addEventListener('click', () => window.memedrop.reconnect());
$('#test-btn').addEventListener('click', () => window.memedrop.testDrop());

// ── Sliders, switches, etc. ─────────────────────────────────────────────────
function bindRange(id, outId, fmt, key, scale = 1) {
  const input = document.getElementById(id);
  const out   = document.getElementById(outId);
  input.addEventListener('input', () => {
    out.textContent = fmt(input.value);
    input.style.setProperty('--value', `${(input.value - input.min) * 100 / (input.max - input.min)}%`);
    window.memedrop.setSettings({ [key]: Number(input.value) / scale });
  });
}

bindRange('volume',   'volume-out',   v => `${v}%`, 'volume',   100);
bindRange('opacity',  'opacity-out',  v => `${v}%`, 'opacity',  100);
bindRange('duration', 'duration-out', v => `${v}s`, 'duration', 1);

$('#sound').addEventListener('change', (e) => {
  window.memedrop.setSettings({ soundOnArrival: e.target.checked });
});

$('#autostart').addEventListener('change', (e) => {
  window.memedrop.setSettings({ autostart: e.target.checked });
});

$('#server').addEventListener('change', (e) => {
  const v = e.target.value.trim();
  if (!v) return;
  window.memedrop.setSettings({ serverUrl: v });
});

$('#display').addEventListener('change', (e) => {
  const id = e.target.value === 'primary' ? null : Number(e.target.value);
  window.memedrop.setSettings({ overlayDisplayId: id });
});

// ── Init: load current settings & display list ──────────────────────────────
async function init() {
  const s = await window.memedrop.getSettings();

  const volEl = $('#volume');
  volEl.value = Math.round((s.volume ?? .75) * 100);
  $('#volume-out').textContent = `${volEl.value}%`;
  volEl.style.setProperty('--value', `${volEl.value}%`);

  const opEl = $('#opacity');
  opEl.value = Math.round((s.opacity ?? 1) * 100);
  $('#opacity-out').textContent = `${opEl.value}%`;
  opEl.style.setProperty('--value', `${opEl.value}%`);

  const durEl = $('#duration');
  durEl.value = s.duration ?? 4;
  $('#duration-out').textContent = `${durEl.value}s`;
  durEl.style.setProperty('--value', `${(durEl.value - 1) * 100 / 14}%`);

  $('#sound').checked     = !!s.soundOnArrival;
  $('#autostart').checked = !!s.autostart;
  $('#server').value      = s.serverUrl || 'ws://localhost:8765';

  // Display list
  const displays = await window.memedrop.listDisplays();
  const sel = $('#display');
  sel.innerHTML = '';
  const primOpt = document.createElement('option');
  primOpt.value = 'primary';
  primOpt.textContent = '◇  Primary display (auto)';
  sel.appendChild(primOpt);
  for (const d of displays) {
    const o = document.createElement('option');
    o.value = String(d.id);
    o.textContent = `${d.primary ? '★' : '·'}  ${d.label} — ${d.bounds.width}×${d.bounds.height}`;
    sel.appendChild(o);
  }
  sel.value = s.overlayDisplayId == null ? 'primary' : String(s.overlayDisplayId);
}
init();

// ── External link ──────────────────────────────────────────────────────────
$('#open-discord').addEventListener('click', (e) => {
  e.preventDefault();
  window.memedrop.openExternal('https://github.com/');
});
