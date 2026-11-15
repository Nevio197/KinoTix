const fs = require('node:fs')
const path = require('node:path')

function createUpdater({app,notify}) {
  const current = app.getVersion()
  const enabled = app.isPackaged && fs.existsSync(path.join(process.resourcesPath,'app-update.yml'))
  let state = {current,phase:enabled?'idle':'unconfigured'}
  const publish = (phase, extra = {}) => notify({type:'updater',...(state={current,phase,...extra})})
  let autoUpdater
  let timer
  if (enabled) {
    ;({autoUpdater}=require('electron-updater'))
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowPrerelease = false
    autoUpdater.allowDowngrade = false
    autoUpdater.on('checking-for-update',()=>publish('checking'))
    autoUpdater.on('update-available',info=>publish('downloading',{available:info.version,percent:0}))
    autoUpdater.on('update-not-available',()=>publish('current'))
    autoUpdater.on('download-progress',value=>publish('downloading',{percent:Math.round(value.percent)}))
    autoUpdater.on('update-downloaded',info=>publish('ready',{available:info.version}))
    autoUpdater.on('error',()=>publish('error'))
  }
  async function check() {
    if (autoUpdater && state.phase!=='ready' && state.phase!=='downloading') {
      try { await autoUpdater.checkForUpdates() } catch { publish('error') }
    }
    return state
  }
  return {
    state:()=>state,
    start() {
      if (autoUpdater && !timer) {
        timer=setTimeout(()=>void check(),1500)
        timer.unref()
      }
    },
    check,
  }
}

module.exports = {createUpdater}
