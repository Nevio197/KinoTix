const fs = require('node:fs')
const path = require('node:path')
const { createWindowsUpdater } = require('./windows-updater.cjs')
const { updateConfig } = require('./windows-update-format.cjs')

function createUpdater({app,notify}) {
  const windowsConfig = path.join(__dirname,'windows-update.json')
  let customConfigured = false
  if (process.platform === 'win32' && process.arch === 'x64' && app.isPackaged && fs.existsSync(windowsConfig)) {
    customConfigured = true
    try {
      const config = updateConfig(JSON.parse(fs.readFileSync(windowsConfig,'utf8')))
      return createWindowsUpdater({app,notify,config})
    } catch (error) {
      console.warn('KinoTix-Update:', error.message)
    }
  }
  const current = app.getVersion()
  const enabled = !customConfigured && app.isPackaged && fs.existsSync(path.join(process.resourcesPath,'app-update.yml'))
  let state = {current,phase:enabled?'idle':'unconfigured'}
  const publish = (phase, extra = {}) => notify({type:'updater',...(state={current,phase,...extra})})
  let autoUpdater
  let timer
  let installRequested = false
  if (enabled) {
    ;({autoUpdater}=require('electron-updater'))
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowPrerelease = false
    autoUpdater.allowDowngrade = false
    autoUpdater.disableWebInstaller = true
    autoUpdater.on('checking-for-update',()=>publish('checking'))
    autoUpdater.on('update-available',info=>publish('downloading',{available:info.version,percent:0}))
    autoUpdater.on('update-not-available',()=>publish('current'))
    autoUpdater.on('download-progress',value=>publish('downloading',{available:state.available,percent:Math.round(value.percent)}))
    if (process.platform === 'darwin') {
      // electron-updater emits its event before the macOS updater has staged the ZIP.
      autoUpdater.on('update-downloaded',info=>publish('downloading',{available:info.version,percent:100}))
      require('electron').autoUpdater.on('update-downloaded',()=>{
        if (state.phase === 'downloading') publish('ready',{available:state.available})
      })
    } else {
      autoUpdater.on('update-downloaded',info=>publish('ready',{available:info.version}))
    }
    autoUpdater.on('error',()=>publish('error'))
  }
  async function check() {
    if (autoUpdater && !['checking','ready','downloading'].includes(state.phase)) {
      try {
        const result = await autoUpdater.checkForUpdates()
        result?.downloadPromise?.catch(()=>{
          if (state.phase !== 'error') publish('error')
        })
      } catch {
        if (state.phase !== 'error') publish('error')
      }
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
    install() {
      if (state.phase !== 'ready' || installRequested) return false
      installRequested = true
      setImmediate(()=>app.quit())
      return true
    },
  }
}

module.exports = {createUpdater}
