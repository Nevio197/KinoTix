const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { pathToFileURL } = require('node:url')

const formats = new Set(['.mp4', '.m4v', '.webm', '.mov', '.ogv'])
const digest = value => createHash('sha256').update(value).digest('hex')
const mediaID = value => typeof value === 'string' && /^media:[a-f0-9]{64}$/.test(value)
const mediaHash = value => 'media:' + digest(value)
const segmentTypes = ['intro','recap','outro','post_credits']
const authParts = new Set(['authorization','token','auth','key','secret','signature','sig','credential',
  'password','jwt','expires','session','policy'])
const authNames = new Set(['accesstoken','accesskey','refreshtoken','authkey','apikey','hdnea','hdnts'])
const controlCharacters = /[\u0000-\u001f\u007f]/
const imdbID = /^tt\d{7,12}$/

function accountVideoURL(value) {
  if (typeof value!=='string' || value.length>4096 || !/^https:\/\//i.test(value) ||
      /[\s\\#]/.test(value) || /^https:\/\/[^/?]*@/i.test(value)) return null
  try {
    if (controlCharacters.test(decodeURIComponent(value))) return null
    const url=new URL(value)
    if (url.protocol!=='https:' || url.username || url.password || url.href.length>4096) return null
    for (const field of url.search.slice(1).split(/[&;]/)) {
      const raw=field.split('=',1)[0].replace(/\+/g,' ')
      const name=decodeURIComponent(raw).trim().toLowerCase()
      if (name.startsWith('x-amz-') || name.startsWith('x-goog-') || authNames.has(name) ||
          name.split(/[^a-z0-9]+/).some(part=>authParts.has(part))) return null
    }
    return url
  } catch { return null }
}

function mediaRecord(value) {
  if (!mediaID(value?.id) || !Number.isSafeInteger(value.updatedAt) ||
      value.updatedAt<1 || value.updatedAt>Date.now()+300000) return null
  const {id,updatedAt}=value
  if (value.removed===true) return {id,updatedAt,removed:true}
  const address=accountVideoURL(value.url)
  const title=typeof value.title==='string' ? value.title.trim() : ''
  if (!address || mediaHash(address.href)!==id || !title || title.length>150 || controlCharacters.test(title)) return null
  return {id,updatedAt,url:address.href,title}
}

function defaultTitle(url) {
  let name=path.posix.basename(url.pathname) || url.hostname
  try { name=decodeURIComponent(name) } catch {}
  return name.replace(/\.[a-z0-9]{2,4}$/i,'') || url.hostname
}

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
  const view=mediaView(id=>items[id],()=>Object.values(items).reverse())

  function save(item) {
    writeItems({...items,[item.url]:item})
    return view.detail(item.url)
  }
  function writeItems(next) {
    fs.writeFileSync(file+'.tmp',JSON.stringify(next),{mode:0o600})
    fs.renameSync(file+'.tmp',file)
    items=next
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
    return add(url.href,digest(url.href),metadata,defaultTitle(url))
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

  function addList(filename,input) {
    if (fs.statSync(filename).size > 2*1024*1024) throw Error('Die Medienliste ist größer als 2 MB.')
    if (input===undefined) {
      try { input=JSON.parse(fs.readFileSync(filename,'utf8').replace(/^\uFEFF/,'')) }
      catch { throw Error('Die Medienliste ist kein gültiges JSON.') }
    }
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

  return {
    addURL,addFile,addList,
    ...view,
    unavailable:id=>mediaID(id) && !items[id],
    removeLocal(id) {
      if (!mediaID(id) || !items[id]) throw Error('Der Titel ist nicht auf diesem Gerät gespeichert.')
      const next={...items}
      delete next[id]
      writeItems(next)
    },
    rawItem:id=>items[id],
    rawItems:()=>Object.values(items).reverse(),
  }
}

function episodeEntries(item) {
  return item.episodes ?? [{id:item.url,season:1,episode:1,segments:item.segments,
    sources:[{name:'Originalquelle',variants:[{url:item.source,height:0}]}]}]
}

function mediaView(find, visible) {
  function requireItem(id) {
    const item=mediaID(id) && find(id)
    if (!item) throw Error('Füge diese Datei oder Video-Adresse auf diesem Gerät hinzu.')
    return item
  }
  function detail(id) {
    const item=requireItem(id)
    const {source,episodes,segments,...metadata}=item
    return {...metadata,episodes:episodeEntries(item).map(({id,season,episode})=>({id,season,episode}))}
  }
  return {
    detail,
    all:()=>visible().map(item=>detail(item.url)),
    episode(id,season,number) { return episodeEntries(requireItem(id)).find(item=>item.season===season && item.episode===number) },
    byProgressID(id) {
      for (const item of visible()) {
        const episode=episodeEntries(item).find(entry=>entry.id===id)
        if (episode) return {title:detail(item.url),episode}
      }
      return null
    },
  }
}

function openAccountMedia(folder, device) {
  const file=path.join(folder,'media-links.json')
  let saved
  try { saved=JSON.parse(fs.readFileSync(file,'utf8')) } catch {}
  const savedRecords=Array.isArray(saved) ? saved : saved?.records
  let records=new Map((Array.isArray(savedRecords) ? savedRecords : []).map(mediaRecord).filter(Boolean).map(row=>[row.id,row]))
  let annotations=Object.fromEntries(Object.entries(saved?.annotations ?? {}).filter(([id,value])=>mediaID(id) && imdbID.test(value)))
  const item=row=>row && !row.removed ? {url:row.id,source:row.url,title:row.title,isSeries:false,accountLink:true,
    imdb:annotations[row.id] ?? device.rawItem(row.id)?.imdb} : undefined
  function save(next,notes=annotations) {
    fs.writeFileSync(file+'.tmp',JSON.stringify({records:[...next.values()],annotations:notes}),{mode:0o600})
    fs.renameSync(file+'.tmp',file)
    records=next
    annotations=notes
  }
  const find=id=>item(records.get(id)) ?? device.rawItem(id)
  function visible() {
    const links=[...records.values()].filter(row=>!row.removed).sort((a,b)=>b.updatedAt-a.updatedAt).map(item)
    const ids=new Set(links.map(row=>row.url))
    return [...links,...device.rawItems().filter(row=>!ids.has(row.url))]
  }
  function apply(incoming) {
    const next=new Map(records)
    let changed=false
    for (const raw of incoming) {
      const row=mediaRecord(raw)
      if (!row || (next.get(row.id)?.updatedAt ?? 0)>=row.updatedAt) continue
      next.set(row.id,row)
      changed=true
    }
    if (!changed) return false
    save(next)
    return true
  }
  const nextTime=id=>Math.max(Date.now(),(records.get(id)?.updatedAt ?? 0)+1)
  function makeLink(value,metadata={}) {
    const address=accountVideoURL(value)
    if (!address) throw Error('Das Konto kann nur HTTPS-Videolinks ohne Zugangsdaten, Signaturen oder Fragmente übernehmen.')
    const id=mediaHash(address.href)
    const provided=typeof metadata.title==='string' ? metadata.title.replace(/[\u0000-\u001f\u007f]/g,' ').trim() : ''
    const title=(provided || item(records.get(id))?.title || defaultTitle(address)).slice(0,150)
    const row=mediaRecord({id,updatedAt:nextTime(id),url:address.href,title})
    if (!row) throw Error('Der Videolink konnte nicht für das Konto gespeichert werden.')
    return row
  }
  function copyable() {
    return device.rawItems().flatMap(local=>{
      const address=local.episodes ? null : accountVideoURL(local.source)
      if (!address || item(records.get(local.url)) || mediaHash(address.href)!==local.url) return []
      return [{id:local.url,title:local.title,hostname:address.hostname}]
    })
  }
  return {
    ...mediaView(find,visible),
    addFile:device.addFile,addList:device.addList,apply,makeLink,copyable,
    annotate(id,imdb) {
      if (!mediaID(id) || typeof imdb!=='string' || !imdbID.test(imdb) || annotations[id]===imdb) return
      save(records,{...annotations,[id]:imdb})
    },
    copy(ids) {
      return copyable().filter(row=>ids.has(row.id)).map(row=>makeLink(device.rawItem(row.id).source,row))
    },
    remove(id) {
      if (!mediaID(id) || !item(records.get(id))) throw Error('Dieser Videolink ist nicht im Konto gespeichert.')
      return {id,updatedAt:nextTime(id),removed:true}
    },
    unavailable(id) { return mediaID(id) && !find(id) },
  }
}

module.exports = {openMedia,openAccountMedia,mediaRecord,mediaID,formats}
