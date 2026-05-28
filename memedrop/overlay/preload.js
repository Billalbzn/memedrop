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
  onConnection:   (cb) => {
    const handler = (_e, state) => cb(state);
    ipcRenderer.on('connection-state', handler);
    return () => ipcRenderer.removeListener('connection-state', handler);
  },

  // Drops (overlay window only)
  onDrop:         (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('drop', handler);
    return () => ipcRenderer.removeListener('drop', handler);
  },

  // Live settings push (overlay window only) — fires on volume/opacity slider moves
  onSettingsUpdate: (cb) => {
    const handler = (_e, settings) => cb(settings);
    ipcRenderer.on('settings-update', handler);
    return () => ipcRenderer.removeListener('settings-update', handler);
  },

  // Misc
  testDrop:       () => ipcRenderer.send('test-drop'),
  openExternal:   (url) => ipcRenderer.send('open-external', url),
  stageEmpty:     () => ipcRenderer.send('stage-empty'),
});
