const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { pathToFileURL } = require('node:url')

const formats = new Set(['.mp4', '.m4v', '.webm', '.mov', '.ogv'])
const digest = value => createHash('sha256').update(value).digest('hex')
const mediaID = value => typeof value === 'string' && /^media:[a-f0-9]{64}$/.test(value)
const mediaHash = value => 'media:' + digest(value)
const segmentTypes = ['intro','recap','outro','post_credits']

function videoURL(value) {
  let url
  try { url = new URL(value) } catch { throw Error('Gib einen vollständigen HTTPS-Videolink ein.') }
  if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 2048) {
    throw Error('Gib einen HTTPS-Videolink ohne Zugangsdaten ein.')
  }
  url.hash = ''
  return url
}

function localSource(value, folder) {
  const parts=value.split(/[\\/]/)
  if (value.includes(':') || path.isAbsolute(value) || parts.some(part=>!part || part==='.' || part==='..') ||
      !formats.has(path.extname(value).toLowerCase())) {
    throw Error('Dateiquellen müssen im Verzeichnis der Medienliste liegen und ein unterstütztes Videoformat haben.')
  }
  let filename=folder
  let entry
  for (const part of parts) {
    filename=path.join(filename,part)
    entry=fs.lstatSync(filename,{throwIfNoEntry:false})
    if (!entry || entry.isSymbolicLink()) throw Error('Dateiquelle fehlt oder verweist über einen symbolischen Link.')
  }
  if (!entry.isFile()) throw Error('Die Dateiquelle ist keine Videodatei.')
  return pathToFileURL(filename).href
}

function segments(input) {
  const result = {}
  for (const type of segmentTypes) {
    if (input?.[type] == null) continue
    const [start,end] = Array.isArray(input[type]) ? input[type] : []
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > 86400) {
      throw Error('Ungültige Zeitmarke für '+type+'. Verwende [Start, Ende] in Sekunden.')
    }
    result[type]={start_sec:start,end_sec:end,confidence:1}
  }
  return result
}
function sidecar(filename) {
  const parsed=path.parse(filename)
  const name=path.join(parsed.dir,parsed.name+'.kinotix.json')
  if (!fs.existsSync(name)) return {}
  if (!fs.lstatSync(name).isFile() || fs.statSync(name).size>32768) throw Error('Die begleitende KinoTix-Datei ist ungültig oder zu groß.')
  let data
  try { data=JSON.parse(fs.readFileSync(name,'utf8').replace(/^\uFEFF/,'')) }
  catch { throw Error('Die begleitende KinoTix-Datei ist kein gültiges JSON.') }
  if (!data || typeof data!=='object' || Array.isArray(data)) throw Error('Die begleitende KinoTix-Datei braucht ein JSON-Objekt.')
  return {...data,segments:segments(data.segments)}
}

function sources(input, folder) {
  if (!Array.isArray(input) || !input.length || input.length > 12) throw Error('Gib pro Video eine bis zwölf Quellen an.')
  return input.map((source,index) => {
    const name = typeof source?.name === 'string' && source.name.trim().slice(0,60) || 'Quelle '+(index+1)
    const variants = source?.variants ?? [source]
    if (!Array.isArray(variants) || !variants.length || variants.length > 10) throw Error('Eine Quelle braucht eine bis zehn Qualitätsstufen.')
    const seen = new Set()
    return {name,variants:variants.map(variant => {
      const {url,file,height=0} = variant ?? {}
      if ((typeof url === 'string') === (typeof file === 'string') || !Number.isInteger(height) || height < 0 || height > 4320) {
        throw Error('Eine Variante braucht entweder url oder file und optional height.')
      }
      if (seen.has(height)) throw Error('Gib jede Auflösung pro Quelle einmal an.')
      seen.add(height)
      return {url:typeof url==='string' ? videoURL(url).href : localSource(file,folder),height,segments:segments(variant.segments)}
    }).sort((a,b)=>b.height-a.height)}
  })
}

function openMedia(folder) {
  const file = path.join(folder, 'medien.json')
  let items
  try { items = JSON.parse(fs.readFileSync(file,'utf8')) } catch {}
  items ??= {}

  function save(item) {
    const next = {...items,[item.url]:item}
    fs.writeFileSync(file+'.tmp',JSON.stringify(next),{mode:0o600})
    fs.renameSync(file+'.tmp',file)
    items=next
    return detail(item.url)
  }
  function add(source, identity, metadata, fallback) {
    const url = 'media:' + identity
    const previous = items[url]
    const title = typeof metadata.title === 'string' && metadata.title.trim() || previous?.title || fallback
    const imdb = typeof metadata.imdb === 'string' && /^tt\d{7,12}$/.test(metadata.imdb.trim()) ? metadata.imdb.trim() : previous?.imdb
    return save({title:title.slice(0,150),url,imdb,source,isSeries:false,segments:metadata.segments})
  }

  function addURL(value, metadata) {
    const url = videoURL(value)
    const label = path.posix.basename(url.pathname)
    let title = label || url.hostname
    try { title = decodeURIComponent(title) } catch {}
    return add(url.href,digest(url.href),metadata,title.replace(/\.[a-z0-9]{2,4}$/i,''))
  }

  function addFile(filename, metadata) {
    const suffix = path.extname(filename)
    if (!formats.has(suffix.toLowerCase())) throw Error('Wähle eine MP4-, WebM-, MOV- oder Ogg-Videodatei.')
    const fd = fs.openSync(filename,'r')
    let identity
    try {
      const {size} = fs.fstatSync(fd)
      if (size < 1) throw Error('Die Datei ist leer.')
      const hash = createHash('sha256').update('file:'+size+':')
      const length = Math.min(65536,size)
      for (const offset of new Set([0,Math.floor((size-length)/2),size-length])) {
        const sample = Buffer.alloc(length)
        const read = fs.readSync(fd,sample,0,length,offset)
        hash.update(sample.subarray(0,read))
      }
      identity = hash.digest('hex')
    } finally { fs.closeSync(fd) }
    const local=sidecar(filename)
    return add(pathToFileURL(filename).href,identity,{...local,
      title:metadata.title?.trim() || local.title,imdb:metadata.imdb?.trim() || local.imdb},path.basename(filename,suffix))
  }

  function addList(filename) {
    if (fs.statSync(filename).size > 2*1024*1024) throw Error('Die Medienliste ist größer als 2 MB.')
    let input
    try { input=JSON.parse(fs.readFileSync(filename,'utf8').replace(/^\uFEFF/,'')) }
    catch { throw Error('Die Medienliste ist kein gültiges JSON.') }
    if (typeof input?.id!=='string' || !/^[\w.-]{1,120}$/.test(input.id) ||
        typeof input.title!=='string' || !input.title.trim()) throw Error('Die Medienliste braucht id und title.')
    const folder = path.dirname(fs.realpathSync(filename))
    const url=mediaHash('list:'+input.id)
    const isSeries=Array.isArray(input.episodes)
    const raw=isSeries ? input.episodes : [{season:1,episode:1,sources:input.sources,segments:input.segments}]
    if (!raw.length || raw.length>500) throw Error('Die Medienliste braucht eine bis 500 Folgen.')
    const seen=new Set()
    const episodes=raw.map(value=>{
      const {season,episode} = value ?? {}
      const key=season+':'+episode
      if (!Number.isInteger(season) || season<1 || season>999 || !Number.isInteger(episode) || episode<1 || episode>9999 || seen.has(key)) {
        throw Error('Jede Staffel- und Folgennummer muss eindeutig und größer als null sein.')
      }
      seen.add(key)
      return {id:isSeries?mediaHash(url+':'+key):url,season,episode,sources:sources(value.sources,folder),segments:segments(value.segments)}
    }).sort((a,b)=>a.season-b.season || a.episode-b.episode)
    const imdb = typeof input.imdb==='string' && /^tt\d{7,12}$/.test(input.imdb) ? input.imdb : undefined
    return save({url,title:input.title.trim().slice(0,150),imdb,isSeries,episodes})
  }

  const entries = item => item.episodes ?? [{
    id:item.url,season:1,episode:1,segments:item.segments,sources:[{name:'Originalquelle',variants:[{url:item.source,height:0}]}],
  }]

  function requireItem(url) {
    const item = mediaID(url) && items[url]
    if (!item) throw Error('Füge diese Datei oder Video-Adresse auf diesem Gerät hinzu.')
    return item
  }

  function detail(url) {
    const item = requireItem(url)
    const {source,episodes,segments,...metadata} = item
    return {...metadata,episodes:entries(item).map(({id,season,episode})=>({id,season,episode}))}
  }

  return {
    addURL,addFile,addList,detail,
    all:()=>Object.keys(items).reverse().map(detail),
    episode(url,season,number) { return entries(requireItem(url)).find(item=>item.season===season && item.episode===number) },
    byProgressID(id) {
      for (const item of Object.values(items)) {
        const episode=entries(item).find(entry=>entry.id===id)
        if (episode) return {title:detail(item.url),episode}
      }
      return null
    },
  }
}

module.exports = {openMedia,mediaID,formats}
