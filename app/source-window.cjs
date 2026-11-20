const {BrowserWindow,session,Menu,dialog}=require('electron')
const {randomUUID}=require('node:crypto')

function openSourceWindow(parent,address,saveBookmark) {
  const origin=new URL(address).origin
  const permitted=(value,sameOrigin)=>{
    try {
      const url=new URL(value)
      return url.protocol==='https:' && !url.username && !url.password && (!sameOrigin || url.origin===origin)
    } catch {return false}
  }
  const isolated=session.fromPartition('kinotix-source-window-'+randomUUID(),{cache:false})
  isolated.setPermissionRequestHandler((_contents,_permission,done)=>done(false))
  isolated.setPermissionCheckHandler(()=>false)
  isolated.setDevicePermissionHandler(()=>false)
  isolated.on('will-download',event=>event.preventDefault())
  isolated.webRequest.onBeforeRequest(({url,resourceType},done)=>{
    if (resourceType==='mainFrame') return done({cancel:!permitted(url,true)})
    const localMedia=url.startsWith('blob:') && permitted(url.slice(5),false)
    const inlineImage=resourceType==='image' && url.startsWith('data:image/')
    done({cancel:!permitted(url,false) && !localMedia && !inlineImage})
  })
  const view=new BrowserWindow({
    width:1040,height:760,autoHideMenuBar:true,
    title:'KinoTix · '+origin,backgroundColor:'#ffffff',
    webPreferences:{session:isolated,sandbox:true,contextIsolation:true,nodeIntegration:false,
      webSecurity:true,webviewTag:false,navigateOnDragDrop:false,disableDialogs:true}
  })
  const history=view.webContents.navigationHistory
  let loaded=''
  function bookmark() {
    try {
      if (!loaded || loaded!==view.webContents.getURL() || !menu.getMenuItemById('bookmark').enabled) return
      saveBookmark(loaded,view.webContents.getTitle())
      menu.getMenuItemById('bookmark').enabled=false
      view.setTitle('In der Merkliste · '+origin+' · KinoTix')
    } catch(error) {
      void dialog.showMessageBox(view,{type:'info',message:error.message})
    }
  }
  const menu=Menu.buildFromTemplate([{label:'Navigation',submenu:[
    {label:'Zurück',click:()=>{if (history.canGoBack()) history.goBack()}},
    {label:'Vorwärts',click:()=>{if (history.canGoForward()) history.goForward()}},
    {label:'Katalog-Startseite',click:()=>{void view.loadURL(origin).catch(()=>{})}},
    {label:'Neu laden',role:'reload'},
    {label:'Zur Mediathek',role:'close'}
  ]},{label:'Merkliste',submenu:[{id:'bookmark',label:'Aktuellen Titel merken',accelerator:'CmdOrCtrl+D',enabled:false,click:bookmark}]}])
  view.setMenu(menu)
  view.webContents.on('did-start-navigation',(_event,details,_inPlace,mainFrame)=>{
    if (!(typeof details==='string'?mainFrame:details.isMainFrame)) return
    loaded=''
    menu.getMenuItemById('bookmark').enabled=false
    view.setTitle('KinoTix · '+origin)
  })
  view.webContents.on('did-navigate',(_event,url,status)=>{
    if (!(status>=200 && status<300) || !permitted(url,true)) return
    const page=new URL(url)
    if (page.pathname==='/' || page.search || page.hash) return
    loaded=page.href
    menu.getMenuItemById('bookmark').enabled=true
  })
  view.setMenuBarVisibility(true)
  view.on('page-title-updated',event=>event.preventDefault())
  // A title link may request another tab. Keep same-site GET links in this window.
  view.webContents.setWindowOpenHandler(({url,postBody})=>{
    if (!postBody && permitted(url,true)) {
      setImmediate(()=>{if (!view.isDestroyed()) void view.loadURL(url).catch(()=>{})})
    }
    return {action:'deny'}
  })
  view.webContents.on('will-navigate',(event,value)=>{
    if (!permitted(typeof value==='string'?value:event.url,true)) event.preventDefault()
  })
  view.webContents.on('before-input-event',(event,input)=>{
    if (input.type!=='keyDown') return
    if (input.key==='Escape') { event.preventDefault();view.close() }
    else if ((input.control || input.meta) && input.key.toLowerCase()==='d') { event.preventDefault();bookmark() }
    else if (input.alt && input.key==='ArrowLeft' && view.webContents.navigationHistory.canGoBack()) {
      event.preventDefault()
      view.webContents.navigationHistory.goBack()
    }
  })
  const close=()=>{if (!view.isDestroyed()) view.destroy()}
  parent.once('closed',close)
  view.once('closed',()=>{
    parent.off('closed',close)
    void isolated.clearStorageData().catch(()=>{})
  })
  const ready=view.loadURL(address).catch(error=>{
    if (!view.isDestroyed() && error.code!=='ERR_ABORTED') { view.destroy();throw error }
  })
  return {view,ready}
}

module.exports={openSourceWindow}
