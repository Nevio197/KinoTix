const fs=require('node:fs')
const path=require('node:path')
const {readSitemap}=require('./catalog-sitemap.cjs')
const {createHash}=require('node:crypto')
const {setTimeout:delay}=require('node:timers/promises')
const {https,config,catalogDomain,defaultDomainSource,decodeTitle,titleID,episodeID,catalogRecord}=require('./catalog-format.cjs')
const {request,blockedHost,networkIssue,httpIssue,browserCheck,dnsRedirectIssue}=require('./source-check.cjs')

const reader=fs.readFileSync(path.join(__dirname,'catalog-reader.js'),'utf8')
const reliableID=value=>typeof value==='string' && /^tt\d{7,12}$/.test(value)?value:undefined
const clean=(value,max)=>typeof value==='string'?value.trim().slice(0,max):''
const normalize=value=>value.toLocaleLowerCase('de-DE').normalize('NFD').replace(/\p{Diacritic}/gu,'')
const byTitle=new Intl.Collator('de',{numeric:true})

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

function openCatalog(folder,{makeView,makeParser,fetcher=fetch,detectBlock=blockedHost,withDnsFallback=operation=>operation()}) {
  const filename=path.join(folder,'catalogs.json')
  const records=new Map()
  try {
    for (const raw of JSON.parse(fs.readFileSync(filename,'utf8'))) {
      const row=catalogRecord(raw)
      if (row) records.set(row.id,row)
    }
  } catch {}
  const visible=()=>[...records.values()].filter(record=>!record.removed).map(record=>record.source)
  const sourceByOrigin=origin=>visible().find(source=>source.origin===origin)
  const titles=new Map(), listing=new Map(), index=new Map(), videos=new Map()
  const shelves=new Map(), covers=new Map(), coverBlocked=new Map(), directories=new Map()
  const shelfFile=path.join(folder,'katalogvorschau.json')
  const fingerprint=source=>createHash('sha256').update(JSON.stringify(source)).digest('hex')
  try {
    const saved=JSON.parse(fs.readFileSync(shelfFile,'utf8'))
    for (const source of visible()) {
      const shelf=saved[source.id]
      if (shelf?.fingerprint!==fingerprint(source) || !Array.isArray(shelf.items) || !Number.isFinite(shelf.savedAt)) continue
      const items=[]
      for (const row of shelf.items.slice(0,200)) {
        const ref=decodeTitle(row?.url)
        const item=ref?.id===source.id && cleanRow({...row,url:webURL(source,ref.pathname)},source)
        if (item) items.push(item)
      }
      if (items.length) shelves.set(source.id,{...shelf,items})
    }
  } catch {}
  function saveShelves() {
    try {
      fs.writeFileSync(shelfFile+'.tmp',JSON.stringify(Object.fromEntries(shelves)),{mode:0o600})
      fs.renameSync(shelfFile+'.tmp',shelfFile)
    } catch (error) { console.warn('Katalogvorschau konnte nicht gespeichert werden:',error.code) }
  }
  function shelfRows() {
    return visible().map(source=>({id:source.id,name:source.name,items:shelves.get(source.id)?.items || [],
      savedAt:shelves.get(source.id)?.savedAt,hasIndex:Boolean(source.index)}))
  }
  const findSource=id=>records.get(id)?.source
  const save=()=>{
    fs.writeFileSync(filename+'.tmp',JSON.stringify([...records.values()]),{mode:0o600})
    fs.renameSync(filename+'.tmp',filename)
  }
  function clear(id) {
    directories.delete(id)
    coverBlocked.delete(id)
    if (shelves.delete(id)) saveShelves()
    for (const key of covers.keys()) if (decodeTitle(key)?.id===id) covers.delete(key)
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
  function browserAddress(id,titleRef) {
    const source=findSource(id)
    if (!source) throw Error('Der Katalog ist nicht vorhanden.')
    if (titleRef===undefined) return source.origin
    const ref=decodeTitle(titleRef)
    const url=ref?.id===id && webURL(source,ref.pathname)
    if (!url) throw Error('Die Titeladresse gehört nicht zum Katalog.')
    return url
  }

  async function staticPage(source,address,rules) {
    const hosts=rules.player?[...source.playerHosts,...source.mediaHosts]:[new URL(source.origin).hostname,...source.catalogHosts]
    const url=safeURL(address,hosts)
    if (!url) throw Error('Die Quelle hat eine ungültige Adresse.')
    const {response,target,issue}=await request(url,fetcher,AbortSignal.timeout(10000),detectBlock,hosts)
    if (issue) throw sourceError(issue.code,issue.message)
    const type=(response.headers.get('content-type') || '').toLowerCase().split(';')[0].trim()
    if (rules.player && type.startsWith('video/') && source.mediaHosts.includes(target.hostname)) {
      await response.body?.cancel()
      return [{height:0,url:target.href}]
    }
    const limit=2*1024*1024
    if (!response.body || Number(response.headers.get('content-length'))>limit ||
        !['','text/html','application/xhtml+xml','text/plain'].includes(type)) {
      await response.body?.cancel()
      throw sourceError('incompatible','Die Quelle liefert keine unterstützte Katalogseite.')
    }
    const charset=response.headers.get('content-type')?.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1]
    let decoder
    try { decoder=new TextDecoder(charset || 'utf-8') } catch { decoder=new TextDecoder() }
    let bytes=0, html=''
    for await (const chunk of response.body) {
      bytes+=chunk.byteLength
      if (bytes>limit) throw sourceError('incompatible','Die Katalogseite ist größer als 2 MB.')
      html+=decoder.decode(chunk,{stream:true})
    }
    html+=decoder.decode()
    const parser=makeParser()
    let timeout
    try {
      const read=async()=>{
        await parser.loadURL('about:blank')
        const args=[rules,html,target.href].map(value=>JSON.stringify(value)).join(',')
        return parser.executeJavaScriptInIsolatedWorld(1001,[{code:reader+'('+args+')'}])
      }
      return await Promise.race([read(),new Promise((_,reject)=>{
        timeout=setTimeout(()=>reject(sourceError('timeout','Die Katalogseite braucht zu lange zum Verarbeiten.')),5000)
      })])
    } finally {
      clearTimeout(timeout)
      if (!parser.isDestroyed()) parser.close()
    }
  }
  function read(source,address,rules,accept) {
    return withDnsFallback(async()=>{
      if (makeParser) {
        const value=await staticPage(source,address,rules)
        if (accept(value) && (!rules.detail || value.episodes?.length) && (!rules.listing || value.items?.length)) return value
      }
      return readOnce(source,address,rules,accept)
    })
  }
  async function readOnce(source,address,rules,accept) {
    const mainHosts=rules.player?[...source.playerHosts,...source.mediaHosts]:
      [new URL(source.origin).hostname,...source.catalogHosts]
    const url=safeURL(address,mainHosts)
    if (!url) throw Error('Die Quelle hat eine ungültige Adresse.')
    if (await detectBlock(url.hostname)) throw sourceError(dnsRedirectIssue.code,dnsRedirectIssue.message)
    const allowed=[...mainHosts,...source.resourceHosts]
    const signature=createHash('sha256').update(JSON.stringify(allowed)).digest('hex').slice(0,12)
    const contents=makeView('kinotix-catalog-'+source.id+'-'+signature,mainHosts,allowed)
    const navigation=new AbortController()
    let timeout
    const stop=new Promise((_,reject)=>{
      const fail=({code,message})=>{ if (!navigation.signal.aborted) reject(sourceError(code,message)) }
      timeout=setTimeout(()=>fail({code:'timeout',message:'Die Quelle antwortet zu langsam. Versuche es gleich noch einmal.'}),10500)
      contents.once('catalog-browser-check',fail)
      contents.on('did-navigate',(_event,_target,status)=>{
        if (status>=400) fail(httpIssue(status))
      })
      void contents.loadURL(url.href).catch(async error=>{
        if (!navigation.signal.aborted) fail(await networkIssue(error,url,detectBlock))
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
    if (!seen.size) throw sourceError('incompatible','Der Katalog hat keine passenden Titel geliefert.')
    return [...seen.values()]
  }
  async function homeOne(source) {
    const cached=listing.get(source.id)
    if (cached && cached.until>Date.now()) return cached.operation
    const entry={until:Date.now()+120000,operation:loadListing(source)}
    listing.set(source.id,entry)
    try {
      const items=await entry.operation
      if (findSource(source.id)===source && listing.get(source.id)===entry) {
        const preview=items.map(row=>({...row,poster:row.poster && !new URL(row.poster).search ? row.poster : ''}))
        shelves.set(source.id,{fingerprint:fingerprint(source),savedAt:Date.now(),items:preview})
        saveShelves()
      }
      return items
    }
    catch (error) {
      if (listing.get(source.id)===entry) listing.delete(source.id)
      if (findSource(source.id)===source && ['browser-check','rate-limit','forbidden','blocked'].includes(error.code))
        coverBlocked.set(source.id,Date.now()+300000)
      throw error
    }
  }
  async function readIndex(source) {
    if (!source.index) return []
    const cached=index.get(source.id)
    if (!cached || cached.until<=Date.now()) {
      const operation=(async()=>{
        const url=new URL(source.index)
        const response=await withDnsFallback(async()=>{
          if (await detectBlock(url.hostname)) throw sourceError(dnsRedirectIssue.code,dnsRedirectIssue.message)
          try {
            return await fetcher(url.href,{redirect:'error',credentials:'omit',signal:AbortSignal.timeout(8000)})
          } catch (error) {
            const {code,message}=await networkIssue(error,url,detectBlock)
            throw sourceError(code,message)
          }
        })
        const issue=browserCheck(response.headers) || (!response.ok && httpIssue(response.status))
        if (issue || !response.body || response.headers.get('content-type')?.toLowerCase().startsWith('text/html')) {
          await response.body?.cancel().catch(()=>{})
          throw issue ? sourceError(issue.code,issue.message) : sourceError('index','Die Quelle hat keinen XML-Suchindex geliefert.')
        }
        const results=new Map()
        await readSitemap(response.body,address=>{
          const url=safeURL(address)
          if (!url) return
          try {
            const slug=decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) ?? '')
              .replace(/^\d+-/,'').replace(/\.[a-z]{2,5}$/i,'').replace(/[-_]+/g,' ')
            const item=cleanRow({url:url.href,title:slug.charAt(0).toUpperCase()+slug.slice(1)},source)
            if (item) results.set(item.url,item)
          } catch {}
        })
        return [...results.values()]
      })().catch(error=>{
        if (index.get(source.id)?.operation===operation) index.delete(source.id)
        throw error
      })
      index.set(source.id,{operation,until:Date.now()+120000})
    }
    return index.get(source.id).operation
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
    if (!meta.poster) meta.poster=shelves.get(source.id)?.items.find(item=>item.url===url)?.poster || ''
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
    if (findSource(source.id)!==source) throw Error('Der Katalog wurde geändert.')
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
  async function searchResults(query) {
    const phrase=normalize(query.trim()).replace(/\s+/g,' ')
    const terms=phrase.split(' ').filter(Boolean)
    const found=new Map(), issues=[]
    if (terms.length) {
      const responses=await Promise.all(visible().map(async source=>({
        source, parts:await Promise.allSettled([homeOne(source),readIndex(source)])
      })))
      for (const {source,parts} of responses) {
        const failures=new Set()
        for (const part of parts) {
          if (part.status==='rejected') {
            const {message,code}=part.reason
            if (!failures.has(message)) issues.push({id:source.id,name:source.name,issue:message,issueCode:code})
            failures.add(message)
            continue
          }
          for (const item of part.value) {
            if (found.has(item.url)) continue
            const name=normalize(item.title)
            if (terms.every(term=>name.includes(term))) {
              const rank=name===phrase?0:name.startsWith(phrase+' ')?1:name.includes(phrase)?2:3
              found.set(item.url,{item,rank})
            }
          }
        }
      }
    }
    const matches=[...found.values()].sort((a,b)=>a.rank-b.rank || a.item.title.length-b.item.title.length ||
      a.item.title.localeCompare(b.item.title,'de') || a.item.url.localeCompare(b.item.url))
    return {items:matches.slice(0,100).map(match=>match.item),issues}
  }
  return {
    records:()=>[...records.values()],apply,importFile,importSource,
    missingFrom:other=>other.records().filter(row=>row.source && !findSource(row.id)).map(row=>row.source),
    browserAddress,searchResults,shelfRows,
    pageBookmark(id,address,label) {
      const source=findSource(id)
      const url=safeURL(address)
      if (!source || url?.origin!==source.origin || url.pathname==='/' || url.search) throw Error('Öffne zuerst die Seite eines Titels.')
      const known=shelves.get(id)?.items.find(row=>row.url===titleID(id,url.pathname))
      if (known) return known
      const item=cleanRow({title:label,url:url.href},source)
      if (!item) throw Error('Diese Seite hat keinen speicherbaren Titel.')
      return item
    },
    async browse(id,page) {
      const source=findSource(id)
      if (!source) throw Error('Der Katalog wurde entfernt.')
      const listing=await homeOne(source).catch(()=>shelves.get(id)?.items || [])
      const entries=await readIndex(source)
      if (findSource(id)!==source) throw Error('Der Katalog wurde geändert.')
      let directory=directories.get(id)
      if (!directory || directory.listing!==listing || directory.entries!==entries) {
        const rows=new Map(listing.map(item=>[item.url,item]))
        for (const entry of entries) if (!rows.has(entry.url)) rows.set(entry.url,entry)
        const all=[...rows.values()].sort((a,b)=>byTitle.compare(a.title,b.title) || a.url.localeCompare(b.url))
        directory={all,listing,entries}
        directories.set(id,directory)
      }
      const all=directory.all
      const pages=Math.max(1,Math.ceil(all.length/48))
      const current=Math.max(1,Math.min(Number.isSafeInteger(page)?page:1,pages))
      return {name:source.name,items:all.slice((current-1)*48,current*48),page:current,pages,total:all.length}
    },
    async cover(url) {
      const ref=decodeTitle(url),source=ref && findSource(ref.id)
      if (!source || !makeParser || !source.detail.poster || coverBlocked.get(ref.id)>Date.now()) return ''
      const cached=covers.get(url)
      if (cached && cached.until>Date.now()) return cached.operation
      const operation=withDnsFallback(()=>staticPage(source,webURL(source,ref.pathname),{cover:source.detail.poster}))
        .then(value=>findSource(ref.id)===source ? safeURL(value)?.href || '' : '')
        .catch(error=>{
          if (findSource(ref.id)===source && ['browser-check','rate-limit','forbidden','blocked','dns-blocked'].includes(error.code))
            coverBlocked.set(ref.id,Date.now()+300000)
          return ''
        })
      if (covers.size>=512) covers.delete(covers.keys().next().value)
      covers.set(url,{until:Date.now()+300000,operation})
      return operation
    },
    sourceByOrigin,
    async resolveDomain(value,device,discover) {
      const origin=catalogDomain(value)
      const known=sourceByOrigin(origin) || device.sourceByOrigin(origin)
      if (known) return known
      const info=await discover(origin)
      if (info.kind!=='catalog') return defaultDomainSource(origin)
      if (info.source.origin!==origin) throw Error('Der verknüpfte Katalog gehört zu einer anderen Domain.')
      return info.source
    },
    async check(source) { return (await loadListing(config(source))).length },
    remove(id) {
      if (!findSource(id)) throw Error('Der Katalog ist nicht vorhanden.')
      return update(null,id)
    },
    list:()=>visible().map(source=>({id:source.id,name:source.name,origin:source.origin})),
    async home() {
      return Promise.all(visible().map(async source=>{
        try { return {id:source.id,name:source.name,items:await homeOne(source),hasIndex:Boolean(source.index)} }
        catch (e) { const shelf=shelves.get(source.id)
          return {id:source.id,name:source.name,items:shelf?.items || [],savedAt:shelf?.savedAt,hasIndex:Boolean(source.index),issue:e.message,issueCode:e.code} }
      }))
    },
    async search(query) { return (await searchResults(query)).items },
    async detail(url) {
      const value=await title(url)
      return {...value,episodes:value.episodes.map(({id,season,episode})=>({id,season,episode}))}
    },
    playback,
    has:url=>Boolean(findSource(decodeTitle(url)?.id)),
  }
}

module.exports={openCatalog}
