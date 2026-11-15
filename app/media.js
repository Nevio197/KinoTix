const {request,status} = window.kino
const video = document.querySelector('video')
const byID = id => document.getElementById(id)
const controls = byID('controls')
const seek = byID('seek')
const volume = byID('volume')
const source = byID('source')
const quality = byID('quality')
const sleep = byID('sleep')
let state = {}
let panel, hideTimer, messageTimer, optionsKey

const icons = {
  back:'<path d="m14 6-6 6 6 6"/>',
  play:'<path d="m8 5 12 7-12 7z" fill="currentColor" stroke="none"/>',
  pause:'<path d="M9 5v14m6-14v14" stroke-width="3"/>',
  volume:'<path d="M3 9h4l5-4v14l-5-4H3zM15 9a4 4 0 0 1 0 6m2-9a8 8 0 0 1 0 12"/>',
  muted:'<path d="M3 9h4l5-4v14l-5-4H3zM16 10l5 5m0-5-5 5"/>',
  next:'<path d="m5 5 11 7-11 7m14-14v14"/>',
  options:'<path d="M3 7h18M3 17h18"/><circle cx="8" cy="7" r="2.5" fill="#211925"/><circle cx="16" cy="17" r="2.5" fill="#211925"/>',
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
  const error=byID('error')
  clearTimeout(messageTimer)
  error.textContent=text
  error.hidden=!text
  if (text) messageTimer=setTimeout(()=>{error.hidden=true},6500)
}
const send = (action,value) => request('player-control',{action,value}).catch(error=>report(error.message))
function wake() {
  clearTimeout(hideTimer)
  controls.classList.remove('asleep')
  if (video.paused || panel || state.countdown || controls.querySelector(':focus-visible')) return
  hideTimer=setTimeout(()=>controls.classList.add('asleep'),2700)
}
function format(value) {
  const seconds=Math.max(0,Math.floor(Number.isFinite(value)?value:0))
  const minutes=Math.floor(seconds/60)
  return (minutes>=60?Math.floor(minutes/60)+':'+String(minutes%60).padStart(2,'0'):minutes)+':'+String(seconds%60).padStart(2,'0')
}
function updateTime() {
  const ready=state.ready && Number.isFinite(video.duration) && video.duration>0
  seek.disabled=!ready
  if (!seek.matches(':active')) {
    seek.max=ready?video.duration:1
    seek.value=video.currentTime
  }
  byID('time').textContent=format(video.currentTime)+(ready?' / '+format(video.duration):'')
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
function togglePanel(name) {
  panel=panel===name?null:name
  for (const id of ['options','timer']) {
    byID(id+'-panel').hidden=panel!==id
    byID(id).setAttribute('aria-expanded',String(panel===id))
  }
  wake()
}
const labels={intro:'Intro',recap:'Rückblick',outro:'Abspann'}
function render(next) {
  const previous=state
  state=next
  byID('title').textContent=state.title || ''
  byID('next').hidden=!state.next
  byID('countdown').hidden=!state.countdown
  byID('remaining').textContent=state.countdown?'Nächste Folge in '+state.countdown+' s':''
  icon('fullscreen',state.fullscreen?'exit':'fullscreen',state.fullscreen?'Vollbild beenden':'Vollbild')
  byID('marker').hidden=!state.marker
  if (state.marker) {
    byID('marker').textContent=labels[state.marker.type]+' überspringen'
    byID('marker').title='Zeitmarke: '+state.marker.provider
  }
  byID('undo').hidden=!state.undo
  if (state.undo) byID('undo').textContent=labels[state.undo.type]+' übersprungen · Rückgängig'
  if (state.error && state.error!==previous.error) report(state.error)
  if (state.audio) {
    const {muted,level}=state.audio
    if (!volume.matches(':active')) volume.value=muted?0:Math.round(level*100)
    volume.setAttribute('aria-valuetext',muted?'Stumm':volume.value+' %')
    icon('mute',muted||level===0?'muted':'volume',muted?'Ton einschalten':'Stumm schalten')
  }
  sleep.value=state.sleep==null?'':String(state.sleep)
  byID('timer').dataset.on=String(state.sleep!=null)
  updateOptions()
  updateTime()
  if (state.fullscreen!==previous.fullscreen || state.countdown!==previous.countdown ||
      state.undo!==previous.undo || state.marker!==previous.marker) wake()
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
sleep.addEventListener('change',()=>{void send('sleep',sleep.value==='episode'?'episode':Number(sleep.value)||null);togglePanel('timer')})
volume.addEventListener('input',()=>void send('set-volume',Number(volume.value)/100))
seek.addEventListener('input',()=>seek.setAttribute('aria-valuetext',format(Number(seek.value))))
seek.addEventListener('change',()=>void send('seek',Number(seek.value)))
byID('pip').addEventListener('click',async()=>{
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture()
    else await video.requestPictureInPicture()
  } catch { report('Bild-in-Bild ist für dieses Video gerade nicht verfügbar.') }
})
video.addEventListener('enterpictureinpicture',()=>{byID('pip').dataset.on='true'})
video.addEventListener('leavepictureinpicture',()=>{byID('pip').dataset.on='false'})
for (const event of ['timeupdate','durationchange','loadedmetadata','seeked']) video.addEventListener(event,updateTime)
video.addEventListener('loadedmetadata',updateOptions)
for (const event of ['playing','pause','ended']) video.addEventListener(event,updatePlayback)
video.addEventListener('click',()=>{
  if (panel) togglePanel(panel)
  else void send('toggle')
})
video.addEventListener('dblclick',()=>void send('fullscreen'))
document.addEventListener('pointermove',wake)
document.addEventListener('pointerdown',wake)
document.addEventListener('focusin',wake)
document.addEventListener('focusout',()=>setTimeout(wake,0))
document.addEventListener('keydown',event=>{
  wake()
  if (event.key==='Escape') {
    if (panel) togglePanel(panel)
    else if (state.fullscreen) void send('fullscreen')
    return
  }
  if (event.altKey || event.ctrlKey || event.metaKey || /BUTTON|INPUT|SELECT/.test(event.target.tagName)) return
  const command={ ' ':['toggle'],ArrowLeft:['jump',-10],ArrowRight:['jump',10],
    ArrowUp:['volume',.1],ArrowDown:['volume',-.1],m:['mute'],f:['fullscreen'],p:['pip'] }[event.key]
  if (!command || command[0]==='fullscreen' && event.repeat) return
  event.preventDefault()
  if (command[0]==='pip') byID('pip').click()
  else void send(...command)
})

try {
  const url = new URL(decodeURIComponent(location.hash.slice(1)))
  if (['https:','file:'].includes(url.protocol)) video.src = url.href
} catch { report('Die Video-Adresse ist ungültig.') }
