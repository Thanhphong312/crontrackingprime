const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  runTracking: (kind) => ipcRenderer.invoke('tracking:run', kind),
  getStats: () => ipcRenderer.invoke('tracking:stats'),
  onLog: (cb) => ipcRenderer.on('log', (_e, d) => cb(d)),
  onStatus: (cb) => ipcRenderer.on('status', (_e, d) => cb(d)),
  onStats: (cb) => ipcRenderer.on('stats', (_e, d) => cb(d)),
});
