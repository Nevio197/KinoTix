function createFullscreen(win) {
  let player, inline, requested
  let native = win.isFullScreen()
  let exitWhenEntered = false
  let state = {}
  const isFullscreen = () => native || requested === true
  const snapshot = () => ({...state,fullscreen:isFullscreen()})
  const publish = () => {
    if (player && !player.webContents.isDestroyed() && !player.webContents.isLoadingMainFrame()) {
      player.webContents.send('player-status',snapshot())
    }
  }
  function layout() {
    if (!player) return
    const {width,height} = win.getContentBounds()
    const box = isFullscreen() ? {x:0,y:0,width,height} : inline
    if (!box) return
    player.setBounds({...box,width:Math.max(0,Math.min(box.width,width-box.x)),
      height:Math.max(0,Math.min(box.height,height-box.y))})
  }
  function transition(value) {
    if (requested !== undefined || native === value) return false
    requested=value
    win.setFullScreen(value)
    layout()
    publish()
    return true
  }
  win.on('enter-full-screen',()=>{
    native=true
    requested=undefined
    if (exitWhenEntered) { exitWhenEntered=false; transition(false) }
    else { layout(); publish() }
  })
  win.on('leave-full-screen',()=>{
    native=false
    requested=undefined
    layout()
    publish()
  })
  win.on('resize',layout)
  return {
    attach(view,data) {
      player=view
      state=data
      layout()
      view.webContents.on('did-finish-load',publish)
      if (isFullscreen()) view.webContents.focus()
    },
    detach(exit) {
      player=undefined
      if (exit) {
        inline=undefined
        if (requested===true) exitWhenEntered=true
        else if (native) transition(false)
      }
    },
    bounds(box) {
      if (!box || !['x','y','width','height'].every(key=>Number.isFinite(box[key]))) return
      inline=Object.fromEntries(Object.entries(box).filter(([key])=>['x','y','width','height'].includes(key))
        .map(([key,value])=>[key,Math.max(0,Math.round(value))]))
      layout()
    },
    update(values) { state={...state,...values}; publish() },
    snapshot,
    contains: sender => player?.webContents===sender,
    toggle:()=>Boolean(player) && transition(!isFullscreen()),
    escape:()=>isFullscreen() && transition(false),
  }
}

module.exports = {createFullscreen}
