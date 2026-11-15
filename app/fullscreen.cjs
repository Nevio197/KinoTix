function createFullscreen(win) {
  let player, inline, requested, queued
  let native = win.isFullScreen()
  let playerRequestedFullscreen = false
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
    if (requested !== undefined) {
      queued=value===requested ? undefined : value
      return true
    }
    if (native === value) return false
    requested=value
    win.setFullScreen(value)
    layout()
    publish()
    return true
  }
  function nativeChanged(value) {
    native=value
    requested=undefined
    const next=queued
    queued=undefined
    if (!native) playerRequestedFullscreen=false
    if (next!==undefined && transition(next)) {
      if (next) playerRequestedFullscreen=true
      return
    }
    layout()
    publish()
  }
  win.on('enter-full-screen',()=>nativeChanged(true))
  win.on('leave-full-screen',()=>nativeChanged(false))
  win.on('resize',layout)
  return {
    attach(view,data) {
      player=view
      state=data
      layout()
      view.webContents.once('did-finish-load',()=>{ if (player===view) publish() })
      if (isFullscreen()) view.webContents.focus()
    },
    detach(exit) {
      player=undefined
      if (exit) {
        inline=undefined
        if (playerRequestedFullscreen || process.platform!=='darwin' && isFullscreen()) transition(false)
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
    toggle() {
      if (!player) return false
      const enter=!(queued ?? requested ?? native)
      if (enter) playerRequestedFullscreen=true
      return transition(enter)
    },
    escape:()=>Boolean(player) && isFullscreen() && transition(false),
  }
}

module.exports = {createFullscreen}
