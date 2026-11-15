const fs=require('node:fs')
const path=require('node:path')
const {createHash}=require('node:crypto')
const {setTimeout:delay}=require('node:timers/promises')
const {https,config,decodeTitle,titleID,episodeID,catalogRecord}=require('./catalog-format.cjs')
const {blockedHost,networkIssue,httpIssue}=require('./source-check.cjs')

const reader=fs.readFileSync(path.join(__dirname,'catalog-reader.js'),'utf8')
const reliableID=value=>typeof value==='string' && /^tt\d{7,12}$/.test(value)?value:undefined
const clean=(value,max)=>typeof value==='string'?value.trim().slice(0,max):''
const normalize=value=>value.toLocaleLowerCase('de-DE').normalize('NFD').replace(/\p{Diacritic}/gu,'')

function sourceError(code,message) {
  return Object.assign(new Error(message),{code})
}
function safeURL(value,hosts) {
  try {
    const url=https(value)
    return !hosts || hosts.includes(url.hostname)?url:null
  } catch { return null }
}
function webURL(source,pathname) {
  const url=new URL(pathname,source.origin)
  return url.origin===source.origin?url.href:null
}
function cleanRow(raw,source) {
  const url=safeURL(raw?.url,[new URL(source.origin).hostname,...source.catalogHosts])
  const title=clean(raw?.title,180)
  const id=url && titleID(source.id,url.pathname)
  if (!id || !title) return null
  return {url:id,title,poster:safeURL(raw.poster)?.href ?? '',year:Number(raw.year)||null,
    provider:source.name,isSeries:raw.isSeries===true || Boolean(source.detail.seriesPrefix && url.pathname.startsWith(source.detail.seriesPrefix))}
}

function openCatalog(folder,{makeView,fetcher=fetch,detectBlock=blockedHost}) {
  const filename=path.join(folder,'catalogs.json')
  const records=new Map()
  try {
    for (const raw of JSON.parse(fs.readFileSync(filename,'utf8'))) {
      const row=catalogRecord(raw)
      if (row) records.set(row.id,row)
    }
  } catch {}
  const visible=()=>[...records.values()].filter(record=>!record.removed).map(record=>record.source)
  const titles=new Map(), listing=new Map(), index=new Map(), videos=new Map()
  const findSource=id=>records.get(id)?.source
  const save=()=>{
    fs.writeFileSync(filename+'.tmp',JSON.stringify([...records.values()]),{mode:0o600})
    fs.renameSync(filename+'.tmp',filename)
  }
  function clear(id) {
    listing.delete(id)
    index.delete(id)
    for (const key of titles.keys()) if (decodeTitle(key)?.id===id) titles.delete(key)
    for (const key of videos.keys()) if (decodeTitle(key.split('|')[0])?.id===id) videos.delete(key)
  }
  function apply(incoming) {
    let changed=false
    for (const raw of incoming) {
      const row=catalogRecord(raw)
      if (!row || (records.get(row.id)?.updatedAt ?? 0)>=row.updatedAt || (!records.has(row.id) && records.size>=30)) continue
      records.set(row.id,row)
      clear(row.id)
      changed=true
    }
    if (changed) save()
    return changed
  }
  function update(source, id=source?.id) {
    const old=records.get(id)
    const updatedAt=Math.max(Date.now(),(old?.updatedAt ?? 0)+1)
    const row=source?{id,updatedAt,source}:{id,updatedAt,removed:true}
    if (!apply([row])) throw Error('Der Katalog konnte nicht gespeichert werden.')
    return row
  }
  function importFile(file) {
    if (fs.statSync(file).size>65536) throw Error('Die Katalogdatei ist größer als 64 KB.')
    let input
    try { input=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')) }
    catch { throw Error('Die Katalogdatei ist kein gültiges JSON.') }
    return update(config(input))
  }
  function importSource(value,{allowOriginChange=false}={}) {
    const source = config(value)
    const existing = findSource(source.id)
    if (existing && existing.origin !== source.origin && !allowOriginChange) {
      throw Error('Ein anderer Katalog verwendet diese Kennung bereits.')
    }
    return update(source)
  }

  async function read(source,address,rules,accept) {
    const url=safeURL(address)
    if (!url) throw Error('Die Quelle hat eine ungültige Adresse.')
    if (rules.listing && await detectBlock(url.hostname)) {
      throw sourceError('blocked','Diese Adresse wird in deinem Netz auf eine Sperrseite umgeleitet.')
    }
    const mainHosts=rules.player?[...source.playerHosts,...source.mediaHosts]:
      [new URL(source.origin).hostname,...source.catalogHosts]
    const allowed=[...mainHosts,...source.resourceHosts]
    const signature=createHash('sha256').update(JSON.stringify(allowed)).digest('hex').slice(0,12)
    const contents=makeView('kinotix-catalog-'+source.id+'-'+signature,mainHosts,allowed)
    const navigation=new AbortController()
    let timeout
    const stop=new Promise((_,reject)=>{
      const fail=({code,message})=>{ if (!navigation.signal.aborted) reject(sourceError(code,message)) }
      timeout=setTimeout(()=>fail({code:'timeout',message:'Die Quelle antwortet zu langsam. Versuche es gleich noch einmal.'}),10500)
      contents.on('did-navigate',(_event,_target,status)=>{
        if (status>=400) fail(httpIssue(status))
      })
      void contents.loadURL(url.href).catch(async error=>{
        if (!navigation.signal.aborted) fail(await networkIssue(error,url,rules.listing?()=>false:detectBlock))
      })
    })
    const run=(async()=>{
      const script=reader+'('+JSON.stringify(rules)+')'
      for (let attempt=0;attempt<18 && !navigation.signal.aborted && !contents.isDestroyed();attempt++) {
        const value=await contents.executeJavaScriptInIsolatedWorld(1001,[{code:script}]).catch(()=>null)
        if (accept(value) && safeURL(contents.getURL(),mainHosts)) return value
        await delay(500)
      }
      throw sourceError('incompatible','Die Webseite liefert keine passenden Katalogdaten. Prüfe, ob die Katalogdatei aktuell ist.')
    })()
    try { return await Promise.race([run,stop]) }
    finally { navigation.abort(); clearTimeout(timeout); if (!contents.isDestroyed()) contents.close() }
  }
  async function loadListing(source) {
    const response=await read(source,source.origin,{listing:source.listing},value=>value?.ready && Array.isArray(value.items))
    const seen=new Map()
    for (const raw of response.items.slice(0,200)) {
      const item=cleanRow(raw,source)
      if (item && !seen.has(item.url)) seen.set(item.url,item)
    }
    return [...seen.values()]
  }
  async function homeOne(source) {
    const cached=listing.get(source.id)
    if (cached && cached.until>Date.now()) return cached.items
    const items=await loadListing(source)
    listing.set(source.id,{until:Date.now()+120000,items})
    return items
  }
  async function readIndex(source) {
    if (!source.index) return []
    if (!index.has(source.id)) {
      const operation=(async()=>{
        const response=await fetcher(source.index,{redirect:'error',signal:AbortSignal.timeout(8000)})
        if (!response.ok || !response.body) throw Error('Der Suchindex ist nicht erreichbar.')
        let bytes=0, xml=''
        const decoder=new TextDecoder()
        for await (const chunk of response.body) {
          bytes+=chunk.byteLength
          if (bytes>14*1024*1024) throw Error('Der Suchindex ist zu groß.')
          xml+=decoder.decode(chunk,{stream:true})
        }
        xml+=decoder.decode()
        const results=[]
        for (const match of xml.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/g)) {
          const url=safeURL(match[1].trim())
          if (!url) continue
          try {
            const slug=decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) ?? '')
              .replace(/^\d+-/,'').replace(/\.[a-z]{2,5}$/i,'').replace(/[-_]+/g,' ')
            const item=cleanRow({url:url.href,title:slug.charAt(0).toUpperCase()+slug.slice(1)},source)
            if (item) results.push(item)
          } catch {}
          if (results.length>=80000) break
        }
        return results
      })().catch(()=>{index.delete(source.id);return []})
      index.set(source.id,operation)
    }
    return index.get(source.id)
  }
  async function title(url) {
    const ref=decodeTitle(url)
    const source=ref && findSource(ref.id)
    if (!source) throw Error('Füge den Katalog auf diesem Gerät hinzu.')
    const cached=titles.get(url)
    if (cached && cached.until>Date.now()) return cached.value
    const address=webURL(source,ref.pathname)
    if (!address) throw Error('Die Titeladresse gehört nicht zum Katalog.')
    const response=await read(source,address,{detail:source.detail},value=>value?.ready && typeof value.title==='string')
    const meta=cleanRow({...response,url:address},source)
    if (!meta) throw Error('Der Katalog hat keinen Titel geliefert.')
    const allowed=[...source.playerHosts,...source.mediaHosts]
    const episodes=[]
    for (const row of (Array.isArray(response.episodes)?response.episodes:[]).slice(0,2500)) {
      if (!Number.isInteger(row.season) || row.season<1 || row.season>999 ||
          !Number.isInteger(row.episode) || row.episode<1 || row.episode>9999) continue
      const links=(Array.isArray(row.sources)?row.sources:[]).slice(0,6).map(value=>safeURL(value,allowed)?.href).filter(Boolean)
      if (links.length) episodes.push({id:episodeID(url,row.season,row.episode),season:row.season,episode:row.episode,links})
    }
    episodes.sort((a,b)=>a.season-b.season || a.episode-b.episode)
    const value={...meta,imdb:reliableID(response.imdb),description:clean(response.description,600),episodes}
    titles.set(url,{until:Date.now()+600000,value})
    return value
  }
  async function resolve(source,address,index) {
    const url=safeURL(address)
    if (!url) return null
    if (source.mediaHosts.includes(url.hostname) && /\.(?:mp4|m4v|webm|mov|ogv)$/i.test(url.pathname)) {
      return {name:'Quelle '+(index+1),variants:[{url:url.href,height:0}]}
    }
    const matching=items=>Array.isArray(items) && items.some(item=>safeURL(item.url,source.mediaHosts))
    const raw=await read(source,address,{player:source.player},matching)
    const heights=new Map()
    for (const item of raw) {
      const video=safeURL(item.url,source.mediaHosts)
      if (!video) continue
      const height=Number.isInteger(item.height) && item.height>=0 && item.height<=4320?item.height:0
      if (!heights.has(height)) heights.set(height,{url:video.href,height})
    }
    return {name:'Quelle '+(index+1),variants:[...heights.values()].sort((a,b)=>b.height-a.height)}
  }
  async function playback(url,season,number) {
    const value=await title(url)
    const episode=value.episodes.find(row=>row.season===season && row.episode===number)
    const source=findSource(decodeTitle(url).id)
    if (!episode || !source) throw Error('Diese Folge ist nicht verfügbar.')
    const key=url+'|'+season+'|'+number
    const cached=videos.get(key)
    if (cached && cached.until>Date.now()) return cached.value
    const responses=await Promise.allSettled(episode.links.map((address,index)=>resolve(source,address,index)))
    const sources=responses.filter(row=>row.status==='fulfilled' && row.value?.variants.length).map(row=>row.value)
    if (!sources.length) throw Error('Keine der Katalogquellen hat einen direkt abspielbaren Videostream geliefert.')
    const result={title:value,episode:{...episode,sources}}
    videos.set(key,{until:Date.now()+120000,value:result})
    return result
  }
  return {
    records:()=>[...records.values()],apply,importFile,importSource,
    async check(source) { return (await loadListing(config(source))).length },
    remove(id) {
      if (!findSource(id)) throw Error('Der Katalog ist nicht vorhanden.')
      return update(null,id)
    },
    list:()=>visible().map(source=>({id:source.id,name:source.name,origin:source.origin})),
    async home() {
      return Promise.all(visible().map(async source=>{
        try { return {name:source.name,items:await homeOne(source)} }
        catch (e) { return {name:source.name,items:[],issue:e.message,issueCode:e.code} }
      }))
    },
    async search(query) {
      const terms=normalize(query).split(/\s+/).filter(Boolean)
      if (!terms.length) return []
      const found=new Map()
      await Promise.all(visible().map(async source=>{
        const [items,fromIndex]=await Promise.all([homeOne(source).catch(()=>[]),readIndex(source)])
        for (const item of [...items,...fromIndex]) {
          if (terms.every(term=>normalize(item.title).includes(term)) && !found.has(item.url)) found.set(item.url,item)
          if (found.size>=80) break
        }
      }))
      return [...found.values()].slice(0,60)
    },
    async detail(url) {
      const value=await title(url)
      return {...value,episodes:value.episodes.map(({id,season,episode})=>({id,season,episode}))}
    },
    playback,
    has:url=>Boolean(findSource(decodeTitle(url)?.id)),
  }
}

module.exports={openCatalog}
