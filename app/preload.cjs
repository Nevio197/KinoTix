const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('kino', {
  platform: process.platform,
  request: (action, data) => ipcRenderer.invoke('kino', action, data),
  status: callback => ipcRenderer.on('player-status', (_event, value) => callback(value)),
})
