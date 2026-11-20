const { Resolver } = require('node:dns/promises')
const path = require('node:path')
const { https, config } = require('./catalog-format.cjs')
const { formats } = require('./media.cjs')

const catalogType = 'application/vnd.kinotix.catalog+json'
const limit = 64 * 1024
const redirects = new Set([301,302,303,307,308])
const securityMarker = /(^|\.)landingpage-cuii(?:[.-]|$)/i
const accessibleMessage = 'Prüfe die Adresse und versuche es erneut.'
const websiteMessage = 'Das ist eine Webseite. Nutze einen direkten Videolink, einen Kataloglink oder eine Katalogdatei.'
const dnsRedirectIssue = {code:'dns-blocked',message:'Diese Adresse wird in deinem Netz auf eine Sperrseite umgeleitet.'}
const dnsErrorCodes = new Set(['ERR_NAME_NOT_RESOLVED','ERR_NAME_RESOLUTION_FAILED','ERR_DNS_TIMED_OUT','ENOTFOUND','EAI_AGAIN'])

function address(value) {
  const input = typeof value === 'string' ? value.trim() : ''
  if (!input || input.length>2048 || /[\s\\]/.test(input) || input.startsWith('/')) throw Error('Gib eine vollständige Webadresse ein.')
  const explicit = /^[a-z][a-z0-9+.-]*:\/\//i.test(input)
  const parsed = new URL(explicit ? input : 'https://' + input)
  parsed.hash = ''
  const url = https(parsed.href)
  if (!explicit && !url.hostname.includes('.') && url.hostname !== 'localhost') throw Error('Gib eine vollständige Webadresse ein.')
  return url
}

async function blockedHost(hostname) {
  if (securityMarker.test(hostname)) return true
  try {
    const resolver = new Resolver({timeout:1300,tries:1})
    const aliases = await resolver.resolveCname(hostname)
    return aliases.some(alias => securityMarker.test(alias))
  } catch {
    return false
  }
}

function httpIssue(status) {
  if (status === 429) return {code:'rate-limit',message:'Die Quelle erhält zu viele Anfragen. Versuche es später erneut.'}
  if (status === 451) return {code:'blocked',message:'Der Zugriff auf diese Adresse ist gesperrt.'}
  if (status === 401 || status === 403) return {code:'forbidden',message:'Die Quelle verweigert den Zugriff. Prüfe, ob der Link öffentlich erreichbar ist.'}
  if (status === 404 || status === 410) return {code:'missing',message:'Die Adresse wurde nicht gefunden. Prüfe den Link.'}
  return {code:'http',message:'Die Quelle antwortet mit HTTP ' + status + '. ' + accessibleMessage}
}

// Fetch exposes Headers, while Electron webRequest supplies arrays keyed by header name.
function browserCheck(headers) {
  const marker = typeof headers?.get === 'function' ? headers.get('cf-mitigated') :
    Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === 'cf-mitigated')?.[1]
  if ([marker].flat().some(value => typeof value === 'string' && value.trim().toLowerCase() === 'challenge')) {
    return {code:'browser-check',message:'Die Quelle verlangt eine Prüfung im Browser. KinoTix erhält deshalb keine Katalogdaten.'}
  }
}

function isDnsError(error) {
  const message = typeof error === 'string' ? error : error?.message
  const netCode = /^(?:net::)?(ERR_[A-Z_]+)\b/.exec(message ?? '')?.[1]
  return [error?.code,error?.cause?.code,netCode].some(code=>dnsErrorCodes.has(code))
}

async function networkIssue(error, url, detectBlock = blockedHost) {
  if (isDnsError(error)) {
    return {code:'dns',message:'Der Name der Quelle konnte in diesem Netz nicht gefunden werden.'}
  }
  const detail = [error?.name,error?.code,error?.message,error?.cause?.code].filter(Boolean).join(' ')
  if (/cert|ssl|tls|certificate/i.test(detail)) return {code:'certificate',message:'Die sichere Verbindung zur Quelle konnte nicht aufgebaut werden.'}
  if (await detectBlock(url.hostname)) return dnsRedirectIssue
  if (/timed? ?out|timeout/i.test(detail)) return {code:'timeout',message:'Die Quelle antwortet zu langsam. Versuche es gleich noch einmal.'}
  return {code:'connection',message:'Die Quelle ist gerade nicht erreichbar. ' + accessibleMessage}
}

async function request(url, fetcher, signal, detectBlock) {
  let target = url
  for (let count = 0; count < 6; count++) {
    if (await detectBlock(target.hostname)) return {issue:dnsRedirectIssue}
    let response
    try {
      response = await fetcher(target.href,{redirect:'manual',credentials:'omit',cache:'no-store',signal})
    } catch (error) {
      return {issue:await networkIssue(error,target,detectBlock)}
    }
    const verification = browserCheck(response.headers)
    if (verification) {
      await response.body?.cancel().catch(()=>{})
      return {issue:verification}
    }
    if (response.ok) return {response,target}
    const location = redirects.has(response.status) && response.headers.get('location')
    await response.body?.cancel().catch(()=>{})
    if (!location) return {issue:httpIssue(response.status)}
    try { target = https(new URL(location,target).href) }
    catch { return {issue:{code:'redirect',message:'Die Quelle leitet auf eine Adresse ohne sichere HTTPS-Verbindung weiter.'}} }
  }
  return {issue:{code:'redirect',message:'Die Quelle leitet zu oft weiter. Prüfe den Link.'}}
}

async function textPrefix(response) {
  const reader = response.body?.getReader()
  if (!reader) return {text:'',truncated:false}
  const parts = []
  let size = 0
  let truncated = false
  try {
    while (true) {
      const {value,done} = await reader.read()
      if (done) break
      if (size + value.length > limit) {
        parts.push(value.subarray(0,limit-size))
        truncated = true
        break
      }
      size += value.length
      parts.push(value)
    }
    return {text:Buffer.concat(parts).toString('utf8').replace(/^\uFEFF/,''),truncated}
  } finally {
    await reader.cancel().catch(()=>{})
  }
}

function linkedCatalog(html, url) {
  const head = html.split(/<\/head\s*>|<body\b/i,1)[0]
    .replace(/<!--[\s\S]*?-->/g,'')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'')
  for (const [tag] of head.matchAll(/<link\s+(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)) {
    const attrs = new Map()
    for (const [,name,double,single,bare] of tag.matchAll(/([a-z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+))/gi)) {
      attrs.set(name.toLowerCase(),double ?? single ?? bare)
    }
    if (!attrs.get('rel')?.toLowerCase().split(/\s+/).includes('alternate') || attrs.get('type')?.toLowerCase() !== catalogType || !attrs.get('href')) continue
    try {
      const link = https(new URL(attrs.get('href').replace(/&amp;/g,'&'),url).href)
      if (link.origin === url.origin) return link
    } catch {}
  }
  return null
}

function mimeType(response) {
  return (response.headers.get('content-type') ?? '').split(';',1)[0].trim().toLowerCase()
}
function manifestType(type, pathname) {
  return type === catalogType || type === 'application/json' || /\.json$/i.test(pathname)
}
function supportedVideo(type, ...paths) {
  if (['video/mp4','video/x-m4v','video/webm','video/quicktime','video/ogg'].includes(type)) return true
  return (!type || type === 'application/octet-stream' || type === 'application/ogg') &&
    paths.some(pathname=>formats.has(path.posix.extname(pathname).toLowerCase()))
}

async function checkSource(value,{fetcher=fetch,detectBlock=blockedHost,verifyCatalog,withDnsFallback=operation=>operation()} = {}) {
  let url
  try { url = address(value) }
  catch (error) { return {kind:'invalid',message:error instanceof TypeError?'Gib eine gültige HTTPS-Adresse ein.':error.message} }
  const info = {url:url.href,hostname:url.hostname}
  const result = (kind,message,extra) => ({...info,kind,message,...extra})
  const unavailable = ({code,message}) => result('unreachable',message,{code})
  const load = address => withDnsFallback(
    () => request(address,fetcher,AbortSignal.timeout(7000),detectBlock),
    result => result?.issue?.code,
  )

  async function recognizeCatalog(loaded) {
    let contents
    const {response,target} = loaded
    try { contents = await textPrefix(response) }
    catch (error) { return unavailable(await networkIssue(error,target,detectBlock)) }
    if (contents.truncated) return result('invalid','Die Katalogdatei darf höchstens 64 KB groß sein.')
    let source
    try { source = config(JSON.parse(contents.text)) }
    catch { return result('invalid','Dieser Link liefert keine gültige KinoTix-Katalogdatei.') }
    let items
    if (verifyCatalog) {
      try { items = await verifyCatalog(source) }
      catch (error) {
        return error?.code === 'incompatible'
          ? result('invalid',error.message,{code:error.code})
          : unavailable({code:error?.code ?? 'connection',message:error.message})
      }
    }
    return result('catalog','Katalog erkannt: ' + source.name + '.',{name:source.name,items,source})
  }

  const loaded = await load(url)
  if (loaded.issue) return unavailable(loaded.issue)
  const {response,target} = loaded
  const type = mimeType(response)
  if (supportedVideo(type,target.pathname,url.pathname) && response.headers.get('content-length') !== '0') {
    await response.body?.cancel().catch(()=>{})
    return result('video','Direkter Videolink erkannt.')
  }
  if (manifestType(type,target.pathname) && type !== 'text/html') return recognizeCatalog(loaded)
  if (!type || type === 'text/html' || type === 'application/xhtml+xml' || type === 'text/plain') {
    let contents
    try { contents = await textPrefix(response) }
    catch (error) { return unavailable(await networkIssue(error,target,detectBlock)) }
    const link = linkedCatalog(contents.text,target)
    if (link) {
      const manifest = await load(link)
      if (manifest.issue) return unavailable(manifest.issue)
      return recognizeCatalog(manifest)
    }
    if (type === 'text/html' || type === 'application/xhtml+xml' || /<!doctype\s+html|<html\b/i.test(contents.text)) {
      return result('website',websiteMessage)
    }
  } else await response.body?.cancel().catch(()=>{})
  return result('invalid','Die Adresse liefert weder ein unterstütztes Video noch einen KinoTix-Katalog.')
}

module.exports = { checkSource, blockedHost, networkIssue, httpIssue, browserCheck, dnsRedirectIssue, isDnsError }
