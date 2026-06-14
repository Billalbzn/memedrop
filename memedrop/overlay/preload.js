// preload.js — exposes a tiny, audited surface to the renderer
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('memedrop', {
  // Settings
  getSettings:    () => ipcRenderer.invoke('settings:get'),
  setSettings:    (patch) => ipcRenderer.invoke('settings:set', patch),

  // Displays
  listDisplays:   () => ipcRenderer.invoke('displays:list'),

  // Connection
  getConnection:  () => ipcRenderer.invoke('connection:get'),
  reconnect:      () => ipcRenderer.invoke('connection:reconnect'),
  unlinkGuild:    (guildId) => ipcRenderer.invoke('connection:unlink-guild', guildId),
  unblockUser:    (userId) => ipcRenderer.invoke('connection:unblock-user', userId),
  onConnection:   (cb) => {
    const handler = (_e, state) => cb(state);
    ipcRenderer.on('connection-state', handler);
    return () => ipcRenderer.removeListener('connection-state', handler);
  },

  // Mode tranquille (mute)
  setMute:        (minutes) => ipcRenderer.invoke('mute:set', minutes),
  getMute:        () => ipcRenderer.invoke('mute:get'),

  // Historique des drops reçus
  getHistory:     () => ipcRenderer.invoke('history:get'),
  clearHistory:   () => ipcRenderer.invoke('history:clear'),
  onHistory:      (cb) => {
    const handler = (_e, history) => cb(history);
    ipcRenderer.on('history-update', handler);
    return () => ipcRenderer.removeListener('history-update', handler);
  },

  // Drops (overlay window)
  onDrop:         (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('drop', handler);
    return () => ipcRenderer.removeListener('drop', handler);
  },

  onSettingsUpdate: (cb) => {
    const handler = (_e, settings) => cb(settings);
    ipcRenderer.on('settings-update', handler);
    return () => ipcRenderer.removeListener('settings-update', handler);
  },

  // App version + auto-updater
  getVersion:       () => ipcRenderer.invoke('app:get-version'),
  getUpdateState:   () => ipcRenderer.invoke('update:get-state'),
  checkForUpdate:   () => ipcRenderer.invoke('update:check'),
  downloadUpdate:   () => ipcRenderer.invoke('update:download'),
  installUpdate:    () => ipcRenderer.invoke('update:install'),
  onUpdateState:    (cb) => {
    const handler = (_e, state) => cb(state);
    ipcRenderer.on('update-state', handler);
    return () => ipcRenderer.removeListener('update-state', handler);
  },

  // Misc
  testDrop:       () => ipcRenderer.send('test-drop'),
  openExternal:   (url) => ipcRenderer.send('open-external', url),
  stageEmpty:     () => ipcRenderer.send('stage-empty'),
  // Drag — sondage curseur + bascule setIgnoreMouseEvents
  watchCursor:   () => ipcRenderer.send('overlay:watch-cursor'),
  unwatchCursor: () => ipcRenderer.send('overlay:unwatch-cursor'),
  setIgnoreMouse: (ignore) => ipcRenderer.send('overlay:set-ignore-mouse', ignore),
  onCursor: (cb) => {
    const handler = (_e, pos) => cb(pos);
    ipcRenderer.on('overlay:cursor', handler);
    return () => ipcRenderer.removeListener('overlay:cursor', handler);
  },
});
