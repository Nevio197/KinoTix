const { app, BrowserWindow, WebContentsView, ipcMain, session, Menu, net, shell, safeStorage, dialog } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const { openLibrary } = require('./library.cjs')
const { openMedia, formats } = require('./media.cjs')
const { createAccountSync } = require('./account-sync.cjs')
const { openCatalog } = require('./catalog.cjs')
const { decodeTitle,https } = require('./catalog-format.cjs')
const { createUpdater } = require('./public-updater.cjs')
const { autoSkip, destination, markerService, readSegments, segmentKey, timelineSegments } = require('./segments.js')
const { controller, keyAction, fallbackVariant } = require('./playback-controls.cjs')
const { createFullscreen } = require('./fullscreen.cjs')
const getMarkers = markerService(async url => {
  const response = await net.fetch(url, {signal:AbortSignal.timeout(4500)})
  return response.ok ? response.json() : null
})

const playerScript = "document.getElementById('video')"
const mediaTimeout = 12000
const webOptions = { sandbox: true, contextIsolation: true, nodeIntegration: false }
const control = controller(playerScript)
let updater, sync, win, fullscreen, player, playback, playToken, timer, library, deviceLibrary, media, folder
let catalog, deviceCatalog, playbackRequest=0
let sleepJob, sleepMinutes = null, sleepAtEnd = false
let audio, audioSave
let nextTimer, undoTimer

app.setName('KinoTix')
if (process.platform === 'win32') app.setAppUserModelId('de.kinotix.desktop')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
if (!app.requestSingleInstanceLock()) app.quit()

function notify(value) {
  if (win && !win.isDestroyed()) win.webContents.send('player-status', value)
}
function searchTitles(query) {
  const normalized = query.toLocaleLowerCase('de-DE')
  return media.all().filter(item => item.title.toLocaleLowerCase('de-DE').includes(normalized))
}
function makeCatalogView(partition,topHosts,resourceHosts) {
  const permitted=(value,hosts)=>{
    try { return hosts.includes(https(value).hostname) } catch { return false }
  }
  const isolated=session.fromPartition(partition)
  isolated.setPermissionRequestHandler((_contents,_permission,finish)=>finish(false))
  isolated.setPermissionCheckHandler(()=>false)
  isolated.webRequest.onBeforeRequest((details,done)=>done({cancel:!permitted(details.url,
    ['mainFrame','subFrame'].includes(details.resourceType)?topHosts:resourceHosts)}))
  const view=new WebContentsView({webPreferences:{...webOptions,partition}})
  const contents=view.webContents
  contents.setWindowOpenHandler(()=>({action:'deny'}))
  const block=(event,value)=>{if (!permitted(typeof value==='string'?value:event.url,topHosts)) event.preventDefault()}
  contents.on('will-navigate',block)
  contents.on('will-redirect',block)
  return contents
}
const catalogOptions={makeView:makeCatalogView,fetcher:(url,options)=>net.fetch(url,options)}
const getTitle=url=>decodeTitle(url)?catalog.detail(url):media.detail(url)

function stop(leaveFullscreen = true) {
  clearInterval(timer)
  clearInterval(nextTimer)
  clearTimeout(undoTimer)
  playToken = undefined
  fullscreen?.detach(leaveFullscreen)
  if (player) {
    win.contentView.removeChildView(player)
    player.webContents.close()
    player = undefined
  }
  playback = undefined
}
const readVideo = `(() => {
  const video = ${playerScript}
  return video ? {time:video.currentTime, duration:video.duration, ended:video.ended, paused:video.paused, seeking:video.seeking,
    readyState:video.readyState, error:video.error?.code ?? null,
    level:video.volume, volumeReady:video[Symbol.for("kinotix-volume-ready")] === true,
  } : null;
})()`

function saveAudio() {
  if (!audioSave) return
  clearTimeout(audioSave)
  audioSave = undefined
  try { deviceLibrary.save() } catch (error) { console.error('Lautstärke konnte nicht gespeichert werden.',error) }
}
function updateAudio(level, muted) {
  const next = {level:Math.round(Math.max(0,Math.min(1,level))*100)/100,muted}
  if (next.level === audio.level && next.muted === audio.muted) return
  audio = next
  deviceLibrary.setAudio(audio)
  clearTimeout(audioSave)
  audioSave = setTimeout(saveAudio,250)
  fullscreen?.update({audio})
}
function updateOutputMute(info) {
  info.contents.setAudioMuted(!info.audioReady || audio.muted || audio.level === 0)
}
function videoCommand(action, value) {
  if (action === 'fullscreen') return fullscreen.toggle()
  if (action === 'mute' || action === 'volume' || action === 'set-volume') {
    if (action !== 'mute' && !Number.isFinite(value)) return false
    const level = action === 'mute' ? audio.level : action === 'volume' ? audio.level + value : value
    updateAudio(level, action === 'mute' && !audio.muted)
    const info = playback
    if (info) {
      updateOutputMute(info)
      if (action !== 'mute') void control(info.frame,'set-volume',audio.level)
    }
    return true
  }
  return control(playback?.frame, action, value)
}
function playerKey(event, input) {
  if (!input.key.startsWith('Media')) return
  const command = keyAction(input)
  if (!command) return
  event.preventDefault()
  void videoCommand(...command)
}
function recordProgress(profile, title, episode, value, options) {
  const saved=library.record(profile,title,episode,value,options)
  if (profile===library.primaryProfile()) {
    sync.record(episode.id,saved,{url:title.url,title:title.title,isSeries:title.isSeries,
      season:episode.season,episode:episode.episode})
  }
  return saved
}
const recordPlayback=(info,value)=>recordProgress(info.profile,info.title,info.episode,value)
async function checkpoint(info = playback) {
  if (!info?.frame || !info.resumed) return
  const frame = info.frame
  const value = await frame.executeJavaScript(readVideo).catch(() => null)
  if (playback !== info || !value || value.error || !Number.isFinite(value.duration) ||
      value.time < 0 || !Number.isFinite(value.time)) return
  info.lastObserved = value
  if (value.time !== info.lastSaved || value.paused !== info.paused || value.ended !== info.ended) {
    info.lastSaved = value.time
    info.paused = value.paused
    recordPlayback(info,value)
  }
  return value
}
async function closePlayback() {
  const request=++playbackRequest
  const info=playback
  await Promise.race([checkpoint(info).catch(()=>{}),delay(850)])
  if (playback===info && request===playbackRequest) stop()
}
function applyProgress(records) {
  const profile = library.primaryProfile()
  let changed = false
  for (const value of records) {
    const item = value.catalog && catalog.has(value.catalog.url) ?
      {title:value.catalog,episode:value.catalog} : media.byProgressID(value.id)
    if (!item || (playback?.profile===profile && playback.episode.id===value.id)) continue
    if (library.record(profile,item.title,item.episode,value,
      {remote:value.updatedAt,force:true,keepHidden:true,save:false})) changed=true
  }
  if (changed) { library.save(); notify({type:'library'}) }
}

function bindAccount(id) {
  ++playbackRequest
  stop()
  const location = id ? path.join(folder,'accounts',id) : folder
  fs.mkdirSync(location,{recursive:true})
  library = id ? openLibrary(location) : deviceLibrary
  catalog = id ? openCatalog(location,catalogOptions) : deviceCatalog
  notify({type:'library'})
}

function setSleep(input) {
  clearTimeout(sleepJob)
  sleepAtEnd = input === 'episode'
  sleepMinutes = [15,30,45,60,90].includes(input) ? input : null
  fullscreen?.update({sleep:sleepAtEnd?'episode':sleepMinutes})
  if (sleepMinutes) {
    sleepJob = setTimeout(() => {
      sleepMinutes = null
      void videoCommand('pause')
      fullscreen.update({sleep:null,notice:'Schlaftimer · Wiedergabe angehalten'})
    }, input * 60000)
  }
  return true
}
function nextEpisode(info) {
  return info.title.episodes[info.title.episodes.findIndex(item=>item.id===info.episode.id)+1]
}
async function goNext(info) {
  const next = info && nextEpisode(info)
  if (!next) return false
  clearInterval(nextTimer)
  await checkpoint(info)
  if (playback!==info) return false
  return startPlayer({url:info.title.url,season:next.season,episode:next.episode})
}
function countdown(info) {
  if (!nextEpisode(info)) return
  let seconds=8
  fullscreen.update({countdown:seconds})
  nextTimer=setInterval(()=>{
    if (--seconds) fullscreen.update({countdown:seconds})
    else { clearInterval(nextTimer); void goNext(info).catch(()=>fullscreen.update({error:'Die nächste Folge konnte nicht geöffnet werden.'})) }
  },1000)
}
async function switchVariant(info, action, value) {
  if (!info || !Number.isInteger(value)) return false
  const source = action==='source' ? value : info.selection.source
  const quality = action==='quality' ? value : 0
  if (!info.episode.sources[source]?.variants[quality] ||
      (!info.failed && info.selection.source===source && info.selection.quality===quality)) return false
  const current=await checkpoint(info)
  if (playback!==info || info.requestID!==playbackRequest) return false
  return mountVariant(info.title,info.episode,info.profile,{source,quality},{
    ...resumeDetails(info,current),attempted:new Set(),notice:null,
  },info.requestID)
}
function resumeDetails(info, current=info.lastObserved) {
  return {...info.request,position:current?.time ?? info.resumePosition,
    autoplay:current ? !current.paused : info.request.autoplay,skipped:info.skipped}
}
function recoverVariant(info) {
  if (playback!==info || info.requestID!==playbackRequest || info.failed) return false
  const {sources}=info.episode
  const attempted=info.attempted
  attempted.add(sources[info.selection.source].variants[info.selection.quality].url)
  const selection=fallbackVariant(sources,info.selection,attempted)
  if (selection) {
    const notice=selection.source===info.selection.source?'Andere Qualität wird geladen':
      'Andere Quelle wird geladen · '+sources[selection.source].name
    return mountVariant(info.title,info.episode,info.profile,selection,
      {...resumeDetails(info),attempted,notice},info.requestID)
  }
  clearInterval(timer)
  info.failed=true
  fullscreen.update({ready:false,notice:null,error:'Dieses Video konnte nicht abgespielt werden. Prüfe die Datei oder den Link und öffne es erneut.'})
  return false
}
async function poll(info, view, token) {
  if (info.polling || view.isDestroyed() || token !== playToken) return
  info.polling = true
  try {
    const initialAudio = audio
    const frame=view.mainFrame
    const value=await frame.executeJavaScript(readVideo).catch(()=>null)
    if (token !== playToken) return
    if (value?.error) return recoverVariant(info)
    const now=Date.now()
    if (!value || !Number.isFinite(value.duration) || value.duration<=0) {
      if (now-(info.stalledAt ??= now)>mediaTimeout) return recoverVariant(info)
      return
    }
    const stalled=value.seeking || (!value.ended && !value.paused &&
      (value.readyState<2 || Math.abs(value.time-(info.lastObserved?.time ?? -1))<.05))
    if (stalled) {
      if (now-(info.stalledAt ??= now)>mediaTimeout) return recoverVariant(info)
    } else info.stalledAt=undefined
    if (info.resumed) info.lastObserved=value
    info.frame = frame
    if (info.duration!==value.duration) {
      info.duration=value.duration
      fullscreen.update({segments:timelineSegments(info.markers,info.duration)})
    }
    if (!value.volumeReady) {
      if (!await control(frame,'set-volume',audio.level) || token !== playToken) return
      info.audioReady = true
      updateOutputMute(info)
    } else if (initialAudio === audio && Number.isFinite(value.level) && Math.abs(value.level-audio.level) >= .005) {
      updateAudio(value.level,audio.muted)
      updateOutputMute(info)
    }
    if (!info.resumed) {
      const resume = Math.min(info.resumePosition,Math.max(0,value.duration-.1))
      if (resume>0) await control(frame,'seek',resume)
      if (token!==playToken) return
      info.resumed = true
      info.lastObserved={...value,time:resume,paused:info.request.autoplay===false}
      fullscreen.update({ready:true})
      if (info.request.autoplay!==false) void control(frame,'play')
      return
    }
    const justUndidSkip = Date.now() < (info.skipPausedUntil ?? 0)
    const skip = !justUndidSkip && !value.paused && !value.seeking && autoSkip(info.markers,info.skipped,value.time,value.duration)
    if (skip && await control(frame,'seek',skip.target) && token === playToken) {
      info.skipped.add(segmentKey(skip.mark))
      info.undo = {type:skip.mark.type,time:value.time}
      info.visibleMarker = null
      fullscreen.update({undo:info.undo,marker:null})
      clearTimeout(undoTimer)
      undoTimer=setTimeout(()=>{if(playback===info) {info.undo=null;fullscreen.update({undo:null})}},6000)
      return
    }
    const nextMarker = info.markers.find(mark => destination(mark, value.time, value.duration) !== null)
    if (nextMarker !== info.visibleMarker) {
      info.visibleMarker = nextMarker
      fullscreen.update({marker:nextMarker ?? null})
    }
    if (Math.abs(value.time-info.lastSaved) >= 4 || value.paused !== info.paused || (value.ended && !info.ended)) {
      info.lastSaved = value.time
      info.paused = value.paused
      recordPlayback(info,value)
    }
    const sleeping = sleepAtEnd && (value.ended || value.duration-value.time <= 1.25)
    if ((value.ended || sleeping) && !info.ended) {
      info.ended = true
      if (sleeping) {
        setSleep(null)
        await control(frame,'pause')
        fullscreen.update({notice:'Schlaftimer · Wiedergabe angehalten'})
      }
      else countdown(info)
    }
  } finally { info.polling = false }
}
async function startPlayer(details) {
  const request=++playbackRequest
  const {title,episode}=decodeTitle(details.url)?await catalog.playback(details.url,details.season,details.episode):
    {title:media.detail(details.url),episode:media.episode(details.url,details.season,details.episode)}
  if (request!==playbackRequest || !win || win.isDestroyed()) return false
  const selection = {source:details.source ?? 0,quality:details.quality ?? 0}
  return mountVariant(title,episode,library.profile(),selection,details,request)
}
function mountVariant(title,episode,profile,selection,details,requestID) {
  const variant = episode?.sources[selection.source]?.variants[selection.quality]
  if (!variant) throw Error('Diese Quelle oder Qualitätsstufe ist nicht verfügbar.')
  stop(false)
  player = new WebContentsView({webPreferences:{...webOptions,enableBlinkFeatures:'AudioVideoTracks',
    partition:'kino-public-player',preload:path.join(__dirname,'preload.cjs')}})
  player.setBackgroundColor('#000000')
  const view = player.webContents
  view.setWindowOpenHandler(()=>({action:'deny'}))
  view.on('will-navigate',event=>event.preventDefault())
  const token = playToken = Symbol()
  const local={...episode.segments,...variant.segments}
  const previous=profile.history[title.url]?.episodes[episode.season+':'+episode.episode]
  const resumePosition=Number.isFinite(details.position) && details.position>=0?details.position:
    previous && !previous.finished?previous.time:0
  const info = playback = {contents:view,audioReady:false,title,episode,profile,selection,
    skipped:details.skipped instanceof Set ? details.skipped : new Set(),request:details,requestID,resumePosition,
    attempted:details.attempted instanceof Set ? details.attempted : new Set(),resumed:false,lastSaved:0,
    stalledAt:Date.now(),markers:readSegments(null,local)}
  updateOutputMute(info)
  view.on('before-input-event',playerKey)
  void getMarkers(title,episode,local).then(markers=>{
    if (token!==playToken) return
    info.markers=markers
    fullscreen.update({segments:timelineSegments(markers,info.duration)})
  })
  win.contentView.addChildView(player)
  fullscreen.bounds(details.bounds)
  fullscreen.attach(player,{title:title.title+(title.isSeries?' · S'+episode.season+' F'+episode.episode:''),audio,
    sources:episode.sources.map(value=>({name:value.name,heights:value.variants.map(item=>item.height)})),
    ...selection,next:Boolean(nextEpisode(info)),sleep:sleepAtEnd?'episode':sleepMinutes,segments:[],
    notice:details.notice ?? null,audioLanguage:deviceLibrary.audioLanguage()})
  void view.loadFile(path.join(__dirname,'media.html'),{hash:encodeURIComponent(variant.url)})
    .catch(()=>{if (token===playToken) recoverVariant(info)})
  timer=setInterval(()=>void poll(info,view,token).catch(()=>{}),750)
  return true
}

ipcMain.handle('kino', async (event, action, payload = {}) => {
  if (action === 'player-control' && fullscreen?.contains(event.sender)
      && event.senderFrame?.url === event.sender.getURL()) {
    if (payload.action === 'state') return fullscreen.snapshot()
    if (payload.action === 'back') { notify({type:'player-back'}); return true }
    if (payload.action === 'next') return goNext(playback)
    if (payload.action === 'cancel') {
      clearInterval(nextTimer)
      fullscreen.update({countdown:0})
      return
    }
    if (payload.action === 'marker' && playback?.visibleMarker) return videoCommand('seek',playback.visibleMarker.end)
    if (payload.action === 'undo' && playback?.undo) {
      const info=playback
      const time=info.undo.time
      info.undo=null
      info.skipPausedUntil=Date.now()+10000
      fullscreen.update({undo:null})
      return videoCommand('seek',time)
    }
    if (payload.action === 'source' || payload.action === 'quality') return switchVariant(playback,payload.action,payload.value)
    if (payload.action === 'audio-language') {
      if (typeof payload.value!=='string') return false
      const language=payload.value.trim().toLowerCase()
      if (language && (language.length>40 || !/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/.test(language))) return false
      deviceLibrary.setAudioLanguage(language)
      fullscreen.update({audioLanguage:language})
      return true
    }
    if (payload.action === 'sleep') return setSleep(payload.value)
    if (['toggle','jump','seek','set-volume','mute','volume','fullscreen'].includes(payload.action)) return videoCommand(payload.action,payload.value)
    return false
  }
  if (!win || event.sender !== win.webContents || event.senderFrame?.url !== win.webContents.getURL()) throw Error('Zugriff verweigert.')
  if (action === 'updates-state') return updater.state()
  if (action === 'updates-check') return updater.check()
  if (action === 'updates-install') return updater.install()
  if (action === 'sync-state') return sync.status()
  if (action === 'sync-sign-in') { await closePlayback(); return sync.signIn() }
  if (action === 'sync-sign-out') { await closePlayback(); return sync.signOut() }
  if (action === 'sync-refresh') { await sync.exchange(); return sync.status() }
  if (action === 'catalog-home') return catalog.home()
  if (action === 'catalog-state') return {sources:catalog.list(),available:catalog!==deviceCatalog && deviceCatalog.list().length>0}
  if (action === 'catalog-import') {
    const result=await dialog.showOpenDialog(win,{properties:['openFile'],filters:[{name:'Katalogdatei',extensions:['json']}]})
    if (result.canceled) return false
    const row=catalog.importFile(result.filePaths[0])
    sync.recordCatalog(row)
    return true
  }
  if (action === 'catalog-remove') {
    sync.recordCatalog(catalog.remove(payload.id))
    return true
  }
  if (action === 'catalog-copy-local' && catalog!==deviceCatalog) {
    const existing=new Set(catalog.records().map(row=>row.id))
    const added=deviceCatalog.records().filter(row=>!row.removed && !existing.has(row.id))
    if (catalog.apply(added)) for (const row of added) sync.recordCatalog(row)
    return true
  }
  if (action === 'media-add') {
    let item
    if (payload.local) {
      const result=await dialog.showOpenDialog(win,{properties:['openFile'],filters:[
        {name:'Video oder Medienliste',extensions:[...formats].map(value=>value.slice(1)).concat('json')}]})
      if (result.canceled) return null
      const filename=result.filePaths[0]
      item=path.extname(filename).toLowerCase()==='.json'?media.addList(filename):media.addFile(filename,payload)
    } else item=media.addURL(payload.url,payload)
    applyProgress(item.episodes.map(entry=>sync.remoteProgress(entry.id)).filter(Boolean))
    return item
  }
  if (action === 'home') return media.all()
  if (action === 'search') {
    const query=String(payload.query ?? '').trim().slice(0,125)
    return [...searchTitles(query),...await catalog.search(query)].slice(0,80)
  }
  if (action === 'title') {
    const title=await getTitle(payload.url)
    applyProgress(title.episodes.map(entry=>sync.remoteProgress(entry.id)).filter(Boolean))
    return title
  }
  if (action === 'history') return library.snapshot().history
  if (action === 'library') return library.snapshot()
  if (action === 'profile-new' || action === 'profile-select') {
    await closePlayback()
    setSleep(null)
    const snapshot=action==='profile-new'?library.addProfile(String(payload.name).trim()):library.select(payload.id)
    return snapshot
  }
  if (action === 'list-add') return library.addList(String(payload.name).trim())
  if (action === 'list-toggle') {
    const list = library.profile().lists.find(entry => entry.id === payload.list)
    const title = await getTitle(payload.url)
    if (!list || !title) throw Error('Die Liste oder der Titel fehlt.')
    return library.toggle(list,title)
  }
  if (action === 'list-check') return library.snapshot()
  if (action === 'news-seen') return library.viewed(payload.url)
  if (action === 'hide') {
    const item = library.profile().history[payload.url]
    if (item) { item.hidden = true; library.save() }
    return library.snapshot()
  }
  if (action === 'play') {
    await checkpoint()
    return startPlayer(payload)
  }
  if (action === 'mark') {
    const title = await getTitle(payload.url)
    const episode = title?.episodes.find(entry => entry.season === payload.season && entry.episode === payload.episode)
    if (episode) {
      const p = library.profile()
      const old = p.history[title.url]?.episodes[episode.season + ':' + episode.episode]
      const finished = payload.finished ?? true
      recordProgress(p,title,episode,{time:finished ? old?.time ?? 0 : 0,duration:old?.duration ?? 0,finished},{force:true})
    }
    return
  }
  if (action === 'video') return videoCommand(payload.action,payload.value)
  if (action === 'bounds') return fullscreen.bounds(payload)
  if (action === 'fullscreen') return fullscreen.toggle()
  if (action === 'close') return closePlayback()
  throw Error('Unbekannte Aktion.')
})

function createWindow() {
  const chrome = process.platform === 'darwin' ? {titleBarStyle:'hiddenInset'} : {autoHideMenuBar:true}
  win = new BrowserWindow({ width:1320, height:860, minWidth:740, minHeight:540, ...chrome,
    backgroundColor:'#090b11', icon:path.join(__dirname,'art','mark.png'),
    webPreferences:{ ...webOptions, preload:path.join(__dirname,'preload.cjs') } })
  win.webContents.setWindowOpenHandler(() => ({ action:'deny' }))
  win.webContents.on('will-navigate', event => event.preventDefault())
  fullscreen = createFullscreen(win)
  win.webContents.on('before-input-event', (event,input) => {
    if (input.type === 'keyDown' && input.key === 'Escape' && fullscreen.escape()) event.preventDefault()
  })
  let closing = false
  win.on('close', event => {
    if (closing) return
    event.preventDefault()
    closing = true
    void closePlayback().finally(() => {
      if (!win.isDestroyed()) win.close()
    })
  })
  win.loadFile(path.join(__dirname,'index.html')).then(()=>updater.start()).catch(console.error)
}
app.on('second-instance', () => { if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.focus() } })
app.whenReady().then(async () => {
  session.fromPartition('kino-public-player').setPermissionRequestHandler((_contents,_permission,finish)=>finish(false))
  folder = app.getPath('userData')
  fs.mkdirSync(folder,{recursive:true})
  library = deviceLibrary = openLibrary(folder)
  media = openMedia(folder)
  catalog = deviceCatalog = openCatalog(folder,catalogOptions)
  audio = deviceLibrary.audio()
  let config
  try { config=JSON.parse(fs.readFileSync(path.join(__dirname,'supabase.json'),'utf8')) } catch {}
  sync = createAccountSync({folder,safeStorage,openExternal:url=>shell.openExternal(url),bind:bindAccount,apply:applyProgress,
    applyCatalogs:items=>{if(catalog.apply(items)) notify({type:'library'})},notify,config})
  await sync.start()
  updater = createUpdater({app,notify})
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role:'appMenu' }, { role:'editMenu' }, { role:'viewMenu', submenu:[{ role:'togglefullscreen' }] }, { role:'windowMenu' },
  ]))
  createWindow()
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow() })
})
let quitting = false
app.on('before-quit', event => {
  if (quitting || !sync) return
  saveAudio()
  quitting=true
  event.preventDefault()
  void closePlayback().then(()=>Promise.race([sync.stop(),delay(1250)])).finally(()=>app.quit())
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
