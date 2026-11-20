const {request,status} = window.kino
const video = document.querySelector('#video')
const byID = id => document.getElementById(id)
const controls = byID('controls')
const seek = byID('seek')
const volume = byID('volume')
const source = byID('source')
const quality = byID('quality')
const sleep = byID('sleep')
const timeline = byID('timeline')
const preview = byID('seek-preview')
const previewFrame = byID('preview-frame')
const audioTrack = byID('audio-track')
const audioTracks = video.audioTracks
const pip = byID('pip')
const languageLabels = new Intl.DisplayNames(['de'],{type:'language'})
const labels={intro:'Intro',recap:'Rückblick',outro:'Abspann',post_credits:'Abspannszene'}
let state = {}
let panel, hideTimer, messageTimer, optionsKey, segmentsKey, videoClickTimer, rangePointer
let audioTracksKey, audioChoiceMade=false
let marks=[], previewMedia, previewTimer, previewTarget, pointerTime
let previewUnavailable=false

const icons = {
  back:'<path d="m14 6-6 6 6 6"/>',
  play:'<path d="m8 5 12 7-12 7z" fill="currentColor" stroke="none"/>',
  pause:'<path d="M9 5v14m6-14v14" stroke-width="3"/>',
  volume:'<path d="M3 9h4l5-4v14l-5-4H3zM15 9a4 4 0 0 1 0 6m2-9a8 8 0 0 1 0 12"/>',
  muted:'<path d="M3 9h4l5-4v14l-5-4H3zM16 10l5 5m0-5-5 5"/>',
  next:'<path d="m5 5 11 7-11 7m14-14v14"/>',
  options:'<path d="M3 7h4m5 0h9M3 17h9m5 0h4"/><circle cx="9.5" cy="7" r="2.5"/><circle cx="14.5" cy="17" r="2.5"/>',
  pip:'<rect x="2.5" y="4" width="19" height="15" rx="2"/><rect x="12" y="11" width="7" height="5" rx="1" fill="currentColor" stroke="none"/>',
  timer:'<circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6"/>',
  fullscreen:'<path d="M4 9V4h5m6 0h5v5m0 6v5h-5m-6 0H4v-5"/>',
  exit:'<path d="M9 4v5H4m16 0h-5V4m0 16v-5h5m-16 0h5v5"/>',
}
function icon(id, name, label) {
  const button=byID(id)
  if (button.dataset.icon!==name) {
    button.dataset.icon=name
    button.innerHTML='<svg aria-hidden="true" viewBox="0 0 24 24">'+icons[name]+'</svg>'
  }
  if (label && button.title!==label) {
    button.setAttribute('aria-label',label)
    button.title=label
  }
}
for (const id of ['back','play','next','options','pip','timer','fullscreen']) icon(id,id)
icon('mute','volume')

function report(text) {
  const message=byID('notice')
  clearTimeout(messageTimer)
  message.textContent=text
  message.hidden=!text
  if (text) messageTimer=setTimeout(()=>{message.hidden=true},5200)
}
const send = (action,value) => request('player-control',{action,value}).catch(error=>report(error.message))
function controlsHeld() {
  return rangePointer!==undefined || video.paused || panel || state.error || state.countdown ||
    timeline.matches(':hover') || controls.querySelector(':focus-visible')
}
function wake() {
  clearTimeout(hideTimer)
  controls.classList.remove('asleep')
  if (controlsHeld()) return
  hideTimer=setTimeout(()=>{if (!controlsHeld()) controls.classList.add('asleep')},2700)
}
function releaseRange(event) {
  if (event?.pointerId!==undefined && event.pointerId!==rangePointer) return
  rangePointer=undefined
  wake()
}
function format(value) {
  const seconds=Math.max(0,Math.floor(Number.isFinite(value)?value:0))
  const minutes=Math.floor(seconds/60)
  return (minutes>=60?Math.floor(minutes/60)+':'+String(minutes%60).padStart(2,'0'):minutes)+':'+String(seconds%60).padStart(2,'0')
}
function renderSegments(duration) {
  const input=state.segments ?? []
  const key=JSON.stringify([duration,input])
  if (key===segmentsKey) return
  segmentsKey=key
  marks=duration ? input.filter(mark=>Object.hasOwn(labels,mark.type) &&
    Number.isFinite(mark.start) && Number.isFinite(mark.end) && mark.start>=0 &&
    mark.start<duration && mark.end>mark.start && mark.end<=duration+2)
    .map(mark=>({...mark,end:Math.min(mark.end,duration)})) : []
  byID('segments').replaceChildren(...marks.map(mark=>{
    const element=document.createElement('div')
    element.className='segment'
    element.dataset.kind=mark.type
    element.style.left=mark.start/duration*100+'%'
    element.style.width=(mark.end-mark.start)/duration*100+'%'
    return element
  }))
  byID('segment-description').textContent=marks.map(mark=>
    labels[mark.type]+' von '+format(mark.start)+' bis '+format(mark.end)).join('. ')
}
function updatePosition(position) {
  const duration=Number(seek.max)
  const value=Math.min(position,duration)
  byID('played').style.width=value/duration*100+'%'
  seek.setAttribute('aria-valuetext',format(value)+' von '+format(duration))
}
function updateTime() {
  const ready=state.ready && Number.isFinite(video.duration) && video.duration>0
  seek.disabled=!ready
  if (!seek.matches(':active')) {
    seek.max=ready?video.duration:1
    seek.value=video.currentTime
    updatePosition(Number(seek.value))
  }
  byID('time').textContent=format(video.currentTime)+(ready?' / '+format(video.duration):'')
  renderSegments(ready?video.duration:0)
}
function updatePlayback() {
  icon('play',video.paused?'play':'pause',video.paused?'Abspielen':'Pause')
  wake()
}
function fill(node, entries, selected) {
  const options=entries.map(({value,label})=>{
    const item=document.createElement('option')
    item.value=value
    item.textContent=label
    return item
  })
  node.replaceChildren(...options)
  node.value=selected
  node.disabled=options.length<2
}
function updateOptions() {
  const key=JSON.stringify([state.sources,state.source,state.quality,video.videoHeight])
  if (key===optionsKey || !state.sources?.length) return
  optionsKey=key
  fill(source,state.sources.map((value,index)=>({value:index,label:value.name})),state.source)
  const row=state.sources[state.source]
  fill(quality,row.heights.map((height,index)=>({value:index,label:height?height+'p':
    video.videoHeight?'Original · '+video.videoHeight+'p':'Original'})),state.quality)
}
function normalizedLanguage(value) {
  if (!value || value==='und') return ''
  if (/^(de|deu|ger)(-|$)/i.test(value)) return 'de'
  try { return new Intl.Locale(value).language } catch { return '' }
}
function chooseAudio(index, tracks) {
  const chosen=tracks[index]
  if (!chosen) return false
  chosen.enabled=true
  for (const track of tracks) if (track!==chosen && track.enabled) track.enabled=false
  return chosen.enabled
}
function preferredAudioIndex(tracks) {
  const choice=state.audioChoice
  if (choice) {
    const sameLanguage=track=>normalizedLanguage(track?.language)===choice.language
    const exact=track=>sameLanguage(track) && track?.label?.trim()===choice.label
    if (choice.label) {
      if (exact(tracks[choice.index])) return choice.index
      const byLabel=tracks.findIndex(exact)
      if (byLabel>=0) return byLabel
    }
    if (tracks[choice.index] && sameLanguage(tracks[choice.index])) return choice.index
    return tracks.findIndex(sameLanguage)
  }
  const language=normalizedLanguage(state.audioLanguage) || 'de'
  return tracks.findIndex(track=>normalizedLanguage(track.language)===language)
}
function updateAudioTracks() {
  const tracks=Array.from(audioTracks ?? [])
  byID('audio-field').hidden=tracks.length<2
  if (tracks.length<2) return
  const selected=tracks.findIndex(track=>track.enabled)
  if (!audioChoiceMade && state.title && video.readyState>=1) {
    const index=preferredAudioIndex(tracks)
    if (index>=0 && (selected===index || chooseAudio(index,tracks))) audioChoiceMade=true
  }
  const current=tracks.findIndex(track=>track.enabled)
  const entries=tracks.map((track,index)=>{
    const code=normalizedLanguage(track.language)
    const label=code?languageLabels.of(code):''
    const names=[...new Set([label,track.label].filter(Boolean))]
    return {value:index,label:names.join(' · ') || 'Tonspur '+(index+1)}
  })
  const labelCounts=new Map()
  for (const entry of entries) labelCounts.set(entry.label,(labelCounts.get(entry.label) ?? 0)+1)
  for (const entry of entries) if (labelCounts.get(entry.label)>1) entry.label+=' · '+(entry.value+1)
  const key=JSON.stringify(entries)
  if (key!==audioTracksKey) {
    audioTracksKey=key
    fill(audioTrack,entries,current)
  } else audioTrack.value=current
}

function drawPreview() {
  const source=previewMedia
  if (preview.hidden || pointerTime===undefined || !source || source.seeking ||
      source.readyState<2 || !source.videoWidth || Math.abs(source.currentTime-previewTarget)>.42 ||
      Math.abs(pointerTime-previewTarget)>1) return
  const context=previewFrame.getContext('2d')
  if (!context) return
  const width=previewFrame.width, height=previewFrame.height
  const scale=Math.min(width/source.videoWidth,height/source.videoHeight)
  const w=source.videoWidth*scale, h=source.videoHeight*scale
  context.fillStyle='#05070c'
  context.fillRect(0,0,width,height)
  try { context.drawImage(source,(width-w)/2,(height-h)/2,w,h) } catch { return }
  previewFrame.hidden=false
  positionPreview(pointerTime)
}
function loadPreview() {
  if (previewUnavailable || pointerTime===undefined || !video.currentSrc) return
  if (!previewMedia) {
    // Leave the preview decoder outside the player document and start only on a deliberate hover.
    previewMedia=document.createElement('video')
    previewMedia.muted=true
    previewMedia.preload='metadata'
    previewMedia.addEventListener('loadedmetadata',loadPreview)
    previewMedia.addEventListener('loadeddata',drawPreview)
    previewMedia.addEventListener('seeked',drawPreview)
    previewMedia.addEventListener('error',()=>{
      previewUnavailable=true
      previewFrame.hidden=true
      positionPreview(pointerTime)
    },{once:true})
    previewMedia.src=video.currentSrc
  }
  if (previewMedia.readyState===0) return
  previewTarget=Math.max(.001,Math.min(pointerTime,previewMedia.duration-.05))
  if (!Number.isFinite(previewTarget)) return
  if (previewMedia.readyState<2 || Math.abs(previewMedia.currentTime-previewTarget)>.15) {
    previewMedia.currentTime=previewTarget
  }
  else drawPreview()
}
function positionPreview(time) {
  if (!Number.isFinite(time) || preview.hidden) return
  const width=timeline.clientWidth
  const offset=preview.offsetWidth/2
  const point=6+time/Number(seek.max)*(width-12)
  preview.style.left=Math.min(width-offset,Math.max(offset,point))+'px'
}
function showPreview(event) {
  if (event.pointerType==='touch' || seek.disabled || panel) return
  const {left,width}=seek.getBoundingClientRect()
  const share=Math.min(1,Math.max(0,(event.clientX-left-6)/Math.max(1,width-12)))
  const time=share*Number(seek.max)
  if (pointerTime!==undefined && Math.abs(time-pointerTime)<.15) return
  pointerTime=time
  byID('preview-time').textContent=format(time)
  const mark=marks.find(mark=>time>=mark.start && time<mark.end)
  const caption=byID('preview-segment')
  caption.hidden=!mark
  caption.textContent=mark?labels[mark.type]:''
  if (Math.abs(time-previewTarget)>1) previewFrame.hidden=true
  preview.hidden=false
  positionPreview(time)
  clearTimeout(previewTimer)
  previewTimer=setTimeout(loadPreview,155)
}
function hidePreview() {
  pointerTime=undefined
  preview.hidden=true
  previewFrame.hidden=true
  clearTimeout(previewTimer)
}
function togglePanel(name) {
  panel=panel===name?null:name
  hidePreview()
  for (const id of ['options','timer']) {
    byID(id+'-panel').hidden=panel!==id
    byID(id).setAttribute('aria-expanded',String(panel===id))
  }
  wake()
}
function render(next) {
  const previous=state
  state=next
  document.body.classList.toggle('mac-player',state.macOS===true)
  byID('title').textContent=state.title || ''
  byID('next').hidden=!state.next
  byID('countdown').hidden=!state.countdown
  byID('remaining').textContent=state.countdown?'Nächste Folge in '+state.countdown+' s':''
  icon('fullscreen',state.fullscreen?'exit':'fullscreen',state.fullscreen?'Vollbild beenden':'Vollbild')
  byID('marker').hidden=!state.marker
  byID('skip').hidden=!(state.marker || state.undo)
  if (state.marker) {
    byID('marker').textContent=labels[state.marker.type]+' überspringen'
    byID('marker').title='Zeitmarke: '+state.marker.provider
  }
  byID('undo').hidden=!state.undo
  if (state.undo) byID('undo').textContent=labels[state.undo.type]+' übersprungen · Rückgängig'
  const error=byID('error')
  if (state.error!==previous.error) {
    error.textContent=state.error || ''
    error.hidden=!state.error
  }
  if (state.notice && state.notice!==previous.notice) report(state.notice)
  if (state.audio) {
    const {muted,level}=state.audio
    if (!volume.matches(':active')) volume.value=muted?0:Math.round(level*100)
    volume.setAttribute('aria-valuetext',muted?'Stumm':volume.value+' %')
    icon('mute',muted||level===0?'muted':'volume',muted?'Ton einschalten':'Stumm schalten')
  }
  sleep.value=state.sleep==null?'':String(state.sleep)
  byID('timer').dataset.on=String(state.sleep!=null)
  updateOptions()
  updateAudioTracks()
  updateTime()
  if (state.fullscreen!==previous.fullscreen || state.countdown!==previous.countdown ||
      state.undo!==previous.undo || state.marker!==previous.marker || state.error!==previous.error) wake()
}
status(render)
void send('state').then(next=>{if(next && !state.title) render(next)})

for (const [id,action] of Object.entries({back:'back',play:'toggle',mute:'mute',fullscreen:'fullscreen',
  next:'next',cancel:'cancel',marker:'marker',undo:'undo'})) {
  byID(id).addEventListener('click',()=>void send(action))
}
byID('timer').addEventListener('click',()=>togglePanel('timer'))
byID('options').addEventListener('click',()=>togglePanel('options'))
source.addEventListener('change',()=>void send('source',Number(source.value)))
quality.addEventListener('change',()=>void send('quality',Number(quality.value)))
audioTrack.addEventListener('change',()=>{
  const tracks=Array.from(audioTracks ?? [])
  const index=Number(audioTrack.value)
  audioChoiceMade=true
  if (!chooseAudio(index,tracks)) { report('Die Tonspur konnte nicht gewechselt werden.'); updateAudioTracks(); return }
  void send('audio-track',{language:normalizedLanguage(tracks[index].language),label:tracks[index].label ?? '',index})
})
for (const event of ['addtrack','removetrack','change']) audioTracks?.addEventListener(event,updateAudioTracks)
sleep.addEventListener('change',()=>{void send('sleep',sleep.value==='episode'?'episode':Number(sleep.value)||null);togglePanel('timer')})
volume.addEventListener('input',()=>void send('set-volume',Number(volume.value)/100))
seek.addEventListener('input',()=>updatePosition(Number(seek.value)))
seek.addEventListener('change',()=>void send('seek',Number(seek.value)))
timeline.addEventListener('pointermove',showPreview)
timeline.addEventListener('pointerleave',()=>{hidePreview(); wake()})
pip.addEventListener('click',async()=>{
  if (pip.dataset.pending==='true') return
  if (!document.pictureInPictureElement &&
      (!document.pictureInPictureEnabled || !video.videoWidth || !state.ready)) {
    report('Bild-in-Bild ist für dieses Video gerade nicht verfügbar.')
    return
  }
  pip.dataset.pending='true'
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture()
    else await video.requestPictureInPicture()
  } catch { report('Bild-in-Bild ist für dieses Video gerade nicht verfügbar.') }
  finally { delete pip.dataset.pending }
})
function updatePictureInPicture() {
  const enabled=document.pictureInPictureElement===video
  pip.dataset.on=String(enabled)
  pip.setAttribute('aria-pressed',String(enabled))
  const label=enabled?'Bild-in-Bild beenden':'Bild-in-Bild'
  pip.setAttribute('aria-label',label)
  pip.title=label
  if (enabled && panel) togglePanel(panel)
  wake()
}
pip.setAttribute('aria-pressed','false')
video.addEventListener('enterpictureinpicture',updatePictureInPicture)
video.addEventListener('leavepictureinpicture',updatePictureInPicture)
for (const event of ['timeupdate','durationchange','loadedmetadata','seeked']) video.addEventListener(event,updateTime)
video.addEventListener('loadedmetadata',updateOptions)
video.addEventListener('loadedmetadata',updateAudioTracks)
for (const event of ['playing','pause','ended']) video.addEventListener(event,updatePlayback)
function playerClick() {
  if (panel) togglePanel(panel)
  else void send('toggle')
}
video.addEventListener('click',event=>{
  if (!state.macOS) { playerClick(); return }
  if (event.detail===1) videoClickTimer=setTimeout(playerClick,300)
})
video.addEventListener('dblclick',()=>{
  clearTimeout(videoClickTimer)
  void send('fullscreen')
})
document.addEventListener('pointermove',wake)
document.addEventListener('pointerdown',event=>{
  if (event.button===0 && (event.target===seek || event.target===volume)) rangePointer=event.pointerId
  wake()
},{capture:true})
document.addEventListener('pointerup',releaseRange,{capture:true})
document.addEventListener('pointercancel',releaseRange,{capture:true})
document.addEventListener('mouseup',releaseRange,{capture:true})
window.addEventListener('blur',releaseRange)
document.addEventListener('focusin',wake)
document.addEventListener('focusout',()=>setTimeout(wake,0))
document.addEventListener('keydown',event=>{
  wake()
  if (event.key==='Escape') {
    if (panel || state.fullscreen) {
      event.preventDefault()
      if (panel) togglePanel(panel)
      else if (!event.repeat) void send('exit-fullscreen')
    }
    return
  }
  if (event.altKey || event.ctrlKey || event.metaKey || /INPUT|SELECT/.test(event.target.tagName)) return
  const command={ ' ':['toggle'],ArrowLeft:['jump',-10],ArrowRight:['jump',10],
    ArrowUp:['volume',.1],ArrowDown:['volume',-.1],m:['mute'],f:['fullscreen'],p:['pip'] }[event.key]
  if (!command || event.target.tagName==='BUTTON' && !['fullscreen','pip'].includes(command[0]) ||
      event.repeat && ['fullscreen','pip'].includes(command[0])) return
  event.preventDefault()
  if (command[0]==='pip') pip.click()
  else void send(...command)
})

try {
  const url = new URL(decodeURIComponent(location.hash.slice(1)))
  if (['https:','file:'].includes(url.protocol)) video.src = url.href
} catch { report('Die Video-Adresse ist ungültig.') }
