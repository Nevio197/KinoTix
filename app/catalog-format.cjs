const {createHash} = require('node:crypto')

const keyPattern = /^[a-z0-9][a-z0-9-]{0,30}$/
const titlePattern = /^catalog:([a-z0-9][a-z0-9-]{0,30}):([A-Za-z0-9_-]{2,1400})$/
const hostPattern = /^[a-z0-9.-]{1,253}$/
const omitUndefined = fields => Object.fromEntries(Object.entries(fields).filter(([,value])=>value!==undefined))

function https(value) {
  if (typeof value!=='string' || value.length>2048) throw Error('Ungültige HTTPS-Adresse.')
  const url=new URL(value)
  if (url.protocol!=='https:' || url.username || url.password || url.hash || !hostPattern.test(url.hostname)) {
    throw Error('Kataloge und Videos brauchen HTTPS-Adressen ohne Zugangsdaten.')
  }
  return url
}
function text(value,limit,label,optional=false) {
  if (optional && value==null) return undefined
  if (typeof value!=='string' || !value.trim() || value.length>limit) throw Error('Ungültige Angabe für '+label+'.')
  return value.trim()
}
function hosts(values,label) {
  if (!Array.isArray(values) || values.length>20 || values.some(host=>typeof host!=='string' || !hostPattern.test(host))) {
    throw Error('Ungültige Hostliste für '+label+'.')
  }
  return [...new Set(values)]
}
function config(value) {
  if (value?.version!==1 || !keyPattern.test(value.id ?? '')) throw Error('Die Katalogdatei braucht version: 1 und eine id.')
  const origin=https(value.origin)
  if (origin.pathname!=='/' || origin.search) throw Error('origin muss eine HTTPS-Startadresse sein.')
  const catalogHosts=hosts(value.catalogHosts ?? [],'Katalog')
  const playerHosts=hosts(value.playerHosts ?? [],'Player')
  const mediaHosts=hosts(value.mediaHosts,'Videodateien')
  const resourceHosts=hosts(value.resourceHosts ?? [],'Ressourcen')
  const index=value.index && https(value.index)
  if (index && (![origin.hostname,...catalogHosts].includes(index.hostname) || index.search)) throw Error('Der Suchindex muss zum Katalog gehören.')
  const rules={}
  const fields={
    listing:['root','items'],detail:['title','description','poster','imdb','groups','controls','episodeAttribute','sourceAttribute','iframe','seriesPrefix'],
    player:['variants'],
  }
  for (const [group,keys] of Object.entries(fields)) {
    rules[group]=omitUndefined(Object.fromEntries(keys.map(key=>[key,text(value[group]?.[key],450,key,
      !['items','title','groups'].includes(key))])))
  }
  for (const expression of [rules.player.variants,value.detail?.embedPattern].filter(Boolean)) {
    // Syntax errors are rejected on import; matching runs in a sandboxed renderer.
    if (typeof expression!=='string' || expression.length>450) throw Error('Ungültiges Muster.')
    new RegExp(expression,'g')
  }
  rules.detail.embedPattern=value.detail?.embedPattern
  return {version:1,id:value.id,name:text(value.name,80,'Name'),origin:origin.origin,catalogHosts,playerHosts,mediaHosts,
    resourceHosts,index:index?.href,...rules}
}
function decodeTitle(value) {
  const match = typeof value==='string' && titlePattern.exec(value)
  if (!match) return null
  const pathname=Buffer.from(match[2],'base64url').toString('utf8')
  if (!pathname.startsWith('/') || pathname.startsWith('//') || /[?#\\\x00-\x20]/.test(pathname) ||
      Buffer.from(pathname).toString('base64url')!==match[2]) return null
  return {id:match[1],pathname}
}
function titleID(id,pathname) {
  const value='catalog:'+id+':'+Buffer.from(pathname).toString('base64url')
  return decodeTitle(value)?value:null
}
function episodeID(title,season,episode) {
  return 'media:'+createHash('sha256').update(title+'|'+season+'|'+episode).digest('hex')
}
function reference(value) {
  if (!decodeTitle(value?.url) || typeof value.title!=='string' || !value.title.trim() || value.title.length>180 ||
      !Number.isInteger(value.season) || value.season<1 || value.season>999 ||
      !Number.isInteger(value.episode) || value.episode<1 || value.episode>9999) return null
  return {url:value.url,title:value.title,season:value.season,episode:value.episode,isSeries:Boolean(value.isSeries)}
}
function catalogRecord(value) {
  if (!keyPattern.test(value?.id ?? '') || !Number.isSafeInteger(value.updatedAt) ||
      value.updatedAt<1 || value.updatedAt>Date.now()+300000) return null
  const {id,updatedAt}=value
  if (value.removed===true) return {id,updatedAt,removed:true}
  try {
    const source=config(value.source)
    return source.id===id?{id,updatedAt,source}:null
  } catch { return null }
}

module.exports={https,config,decodeTitle,titleID,episodeID,reference,catalogRecord}
