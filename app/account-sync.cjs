const fs=require('node:fs')
const path=require('node:path')
const {createServer}=require('node:http')
const {createHash,randomBytes}=require('node:crypto')
const {mediaID}=require('./media.cjs')
const {reference,catalogRecord,episodeID}=require('./catalog-format.cjs')

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const random=()=>randomBytes(32).toString('base64url')
const read=filename=>{try {return JSON.parse(fs.readFileSync(filename,'utf8'))} catch {return null}}
function write(filename,value) {
  fs.writeFileSync(filename+'.tmp',JSON.stringify(value),{mode:0o600})
  fs.renameSync(filename+'.tmp',filename)
}
function validConfig(value) {
  try {
    const url=new URL(value.url)
    if (url.protocol!=='https:' || !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname) || url.port ||
        url.username || url.password || url.pathname!=='/' || url.search || url.hash ||
        typeof value.publishableKey!=='string' || !/^sb_publishable_[\w-]+$/.test(value.publishableKey)) return null
    return {url:url.origin,key:value.publishableKey}
  } catch { return null }
}

async function authorize({url,openExternal}) {
  const verifier=random()
  const nonce=random()
  const route='/kinotix/auth/'+nonce
  let resolveCode,rejectCode,timer,redirect
  const result=new Promise((resolve,reject)=>{resolveCode=resolve;rejectCode=reject})
  result.catch(()=>{})
  const server=createServer((req,res)=>{
    let target
    try { target=new URL(req.url,'http://127.0.0.1') } catch {res.writeHead(400).end();return}
    if (req.method!=='GET' || target.pathname!==route || req.headers.host!==new URL(redirect).host) {
      res.writeHead(404).end()
      return
    }
    const code=target.searchParams.get('code')
    res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer'})
    res.end(code?'Du kannst das Fenster schließen und zu KinoTix zurückkehren.':'Die Anmeldung wurde abgebrochen.')
    if (code && code.length<=500) resolveCode(code)
    else rejectCode(Error('Die Google-Anmeldung wurde abgebrochen.'))
  })
  try {
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
    redirect='http://127.0.0.1:'+server.address().port+route
    const target=new URL('/auth/v1/authorize',url)
    target.search=new URLSearchParams({provider:'google',redirect_to:redirect,
      code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'s256'})
    await openExternal(target.href)
    timer=setTimeout(()=>rejectCode(Error('Die Google-Anmeldung ist abgelaufen.')),180000)
    return {auth_code:await result,code_verifier:verifier}
  } finally { clearTimeout(timer);server.closeAllConnections();server.close() }
}

function progress(value) {
  if (!mediaID(value?.id) || !Number.isFinite(value.time) || !Number.isFinite(value.duration) ||
      value.duration<0 || value.duration>86400 || value.time<0 || value.time>value.duration+.5 ||
      typeof value.finished!=='boolean' || !Number.isSafeInteger(value.updatedAt) || value.updatedAt<1 ||
      value.updatedAt>Date.now()+300000) return null
  const {id,time,duration,finished,updatedAt}=value
  const item=reference(value.catalog)
  const catalog=item && episodeID(item.url,item.season,item.episode)===id?item:undefined
  return {id,time,duration,finished,updatedAt,...catalog && {catalog}}
}
const recordKey=(kind,id)=>kind+':'+id
function decode(row) {
  if (row?.kind==='catalog') return catalogRecord({...row.value,id:row.item_id,updatedAt:row.updated_at})
  if (row?.kind==='progress') return progress({...row.value,id:row.item_id,updatedAt:row.updated_at})
  return null
}
function createAccountSync({folder,safeStorage,openExternal,bind,apply,applyCatalogs,notify,config,fetcher=fetch,authorizeBrowser=authorize}) {
  const project=validConfig(config)
  const filename=path.join(folder,'account.json')
  const stored=read(filename)
  let account,session,timer,timerDue=0,flight,signingIn=false,restoring=false,active=true,issue='',lastSync=null
  let pending=new Map(),downloaded=new Map()
  const status=()=>({configured:Boolean(project),connected:Boolean(account),signingIn,restoring,lastSync,issue,email:account?.email ?? ''})
  const emit=()=>notify({type:'sync',...status()})
  const pendingFile=owner=>path.join(folder,'pending-'+owner.id+'.json')
  function schedule(ms) {
    clearTimeout(timer)
    timer=undefined
    timerDue=0
    if (active && account) {
      timerDue=Date.now()+ms
      timer=setTimeout(()=>{timer=undefined;timerDue=0;void exchange()},ms)
      timer.unref?.()
    }
  }
  async function api(route,options={},access) {
    const response=await fetcher(project.url+route,{...options,redirect:'error',signal:AbortSignal.timeout(8000),
      headers:{apikey:project.key,'Content-Type':'application/json',...(access?{Authorization:'Bearer '+access}:{}),...options.headers}})
    if (!response.ok) {
      const error=Error('Das KinoTix-Konto ist gerade nicht erreichbar (HTTP '+response.status+').')
      error.status=response.status
      throw error
    }
    return response.status===204?null:response.json()
  }
  const token=(grant,body)=>api('/auth/v1/token?grant_type='+grant,{method:'POST',body:JSON.stringify(body)})
  function setSession(value) {
    if (typeof value?.refresh_token!=='string' || typeof value.access_token!=='string' || !Number.isFinite(value.expires_in)) {
      throw Error('Der Dienst hat keine gültige Anmeldung geliefert.')
    }
    session={access:value.access_token,refresh:value.refresh_token,until:Date.now()+value.expires_in*1000}
  }
  async function persist(owner,refresh) {
    const encrypted=await safeStorage.encryptStringAsync(refresh)
    if (account!==owner) return
    write(filename,{project:project.url,id:owner.id,email:owner.email,refresh:encrypted.toString('base64')})
  }
  function select(owner) {
    account=owner
    downloaded=new Map()
    pending=new Map()
    const saved=owner && read(pendingFile(owner))
    for (const row of Array.isArray(saved)?saved:[]) {
      if (decode(row)) pending.set(recordKey(row.kind,row.item_id),row)
    }
    bind(owner?.id)
    schedule(0)
    emit()
  }
  async function access(owner) {
    if (account!==owner) throw Error('Die Sitzung wurde beendet.')
    if (session.until<Date.now()+60000) {
      const fresh=await token('refresh_token',{refresh_token:session.refresh})
      if (account!==owner) throw Error('Die Sitzung wurde beendet.')
      setSession(fresh)
      await persist(owner,session.refresh)
    }
    if (account!==owner) throw Error('Die Sitzung wurde beendet.')
    return session.access
  }
  async function readItems(kind,auth) {
    const rows=[]
    const count=kind==='catalog'?100:500
    for (let offset=0;offset<(kind==='catalog'?100:5000);offset+=count) {
      const page=await api('/rest/v1/kinotix_sync?select=kind,item_id,updated_at,value&kind=eq.'+kind+
        '&order=updated_at.desc,item_id.asc&limit='+count+'&offset='+offset,{},auth)
      if (!Array.isArray(page)) throw Error('Der Synchronisierungsdienst hat ungültige Daten geliefert.')
      rows.push(...page.map(decode).filter(Boolean))
      if (page.length<count) break
    }
    return rows
  }
  async function run(owner) {
    const auth=await access(owner)
    const sending=[...pending.values()].slice(0,1000)
    for (let offset=0;offset<sending.length && account===owner;offset+=100) {
      const batch=sending.slice(offset,offset+100)
      await api('/rest/v1/rpc/kinotix_merge',{method:'POST',body:JSON.stringify({p_items:batch})},auth)
      if (account!==owner) return
      for (const row of batch) {
        const key=recordKey(row.kind,row.item_id)
        if (pending.get(key)===row) pending.delete(key)
      }
      write(pendingFile(owner),[...pending.values()])
    }
    const [catalogs,items]=await Promise.all([readItems('catalog',auth),readItems('progress',auth)])
    if (account!==owner) return
    applyCatalogs(catalogs)
    downloaded=new Map(items.map(item=>[item.id,item]))
    apply(items)
    issue=''
    lastSync=Date.now()
  }
  function exchange() {
    if (flight || !account) return flight
    const owner=account
    flight=run(owner).catch(error=>{
      if (account===owner) {
        if (error.status===401) session.until=0
        issue='Synchronisierung gerade nicht verfügbar. Änderungen bleiben auf diesem Gerät gespeichert.'
      }
    }).finally(()=>{
      flight=undefined
      schedule(account!==owner?0:pending.size && !issue?2000:30000)
      emit()
    })
    return flight
  }
  function queue(kind,item) {
    if (!account || !item) return
    const item_id=item.id
    const mapKey=recordKey(kind,item_id)
    const updated_at=Math.max(item.updatedAt,(pending.get(mapKey)?.updated_at ?? 0)+1)
    const {id,updatedAt,...value}=item
    pending.set(mapKey,{kind,item_id,updated_at,value})
    write(pendingFile(account),[...pending.values()])
    if (!flight && !issue && (!timer || timerDue>Date.now()+2000)) schedule(2000)
  }
  return {
    status,exchange,
    remoteProgress:id=>downloaded.get(id),
    record(id,saved,catalog) { if (saved) queue('progress',progress({id,...saved,catalog})) },
    recordCatalog(value) { queue('catalog',catalogRecord(value)) },
    async signIn() {
      if (!project) throw Error('Das Supabase-Projekt ist für diesen Build noch nicht eingerichtet.')
      if (signingIn || restoring || account) return status()
      signingIn=true;issue='';emit()
      try {
        if (!await safeStorage.isAsyncEncryptionAvailable()) throw Error('Der geschützte Speicher ist nicht verfügbar.')
        const fields=await authorizeBrowser({url:project.url,openExternal})
        setSession(await token('pkce',fields))
        const user=await api('/auth/v1/user',{},session.access)
        if (!uuid.test(user?.id ?? '') || typeof user.email!=='string') throw Error('Das Konto konnte nicht bestätigt werden.')
        const owner={id:user.id,email:user.email}
        const encrypted=await safeStorage.encryptStringAsync(session.refresh)
        if (!active) return status()
        write(filename,{project:project.url,id:owner.id,email:owner.email,refresh:encrypted.toString('base64')})
        select(owner)
      } catch (error) {session=undefined;issue=error.message}
      finally {signingIn=false;emit()}
      return status()
    },
    async start() {
      if (!project || !active || restoring || signingIn || account || stored?.project!==project.url || !uuid.test(stored.id)) return
      restoring=true
      emit()
      try {
        const decrypted=await safeStorage.decryptStringAsync(Buffer.from(stored.refresh,'base64'))
        if (!active) return
        if (decrypted.isTemporarilyUnavailable || !decrypted.result) {
          issue='Die gespeicherte Anmeldung ist gerade nicht verfügbar. Öffne den geschützten Speicher oder melde dich erneut an.'
          return
        }
        session={refresh:decrypted.result,until:0}
        select({id:stored.id,email:stored.email})
      } catch {
        if (active) issue='Die gespeicherte Anmeldung konnte nicht geöffnet werden.'
      } finally {
        restoring=false
        emit()
      }
    },
    signOut() {
      fs.rmSync(filename,{force:true})
      const accessToken=session?.access
      session=undefined;issue='';lastSync=null
      select(undefined)
      if (accessToken) void api('/auth/v1/logout?scope=local',{method:'POST'},accessToken).catch(()=>{})
      return status()
    },
    async stop() {
      active=false
      clearTimeout(timer)
      if (flight) await flight
      if (pending.size) await exchange()
    },
  }
}

module.exports={createAccountSync,validConfig}
