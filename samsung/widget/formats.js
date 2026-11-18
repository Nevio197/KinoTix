(() => {
  'use strict'

  const sourceKey = /^[a-z0-9][a-z0-9-]{0,30}$/
  const mediaKey = /^media:[a-f0-9]{64}$/
  const catalogKey = /^catalog:([a-z0-9][a-z0-9-]{0,30}):([A-Za-z0-9_-]{2,1400})$/
  const hostKey = /^[a-z0-9.-]{1,253}$/
  const controls = /[\u0000-\u001f\u007f]/
  const privateParts = new Set(['authorization','token','auth','key','secret','signature','sig','credential',
    'password','jwt','expires','session','policy'])
  const privateNames = new Set(['accesstoken','accesskey','refreshtoken','authkey','apikey','hdnea','hdnts'])
  const encoder = new TextEncoder()

  function https(value, allowedHosts, limit = 2048) {
    if (typeof value !== 'string' || !value || value.length > limit || /[\s\\]/.test(value)) {
      throw Error('Gib eine vollständige HTTPS-Adresse ein.')
    }
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || !hostKey.test(url.hostname) ||
      url.href.length > limit || allowedHosts && !allowedHosts.includes(url.hostname)) {
      throw Error('Die HTTPS-Adresse gehört nicht zu dieser Quelle.')
    }
    return url
  }

  function safeAddress(value, base, hosts, limit = 2048) {
    if (typeof value !== 'string' || !value.trim()) return null
    try {
      return https(new URL(value.trim(), base).href, hosts, limit)
    } catch { return null }
  }

  function text(value, limit, label, optional = false) {
    if (optional && value == null) return undefined
    if (typeof value !== 'string' || !value.trim() || value.length > limit || controls.test(value)) {
      throw Error('Ungültige Angabe für ' + label + '.')
    }
    return value.trim()
  }

  function hosts(input, label) {
    if (!Array.isArray(input) || input.length > 20 ||
      input.some(host => typeof host !== 'string' || !hostKey.test(host))) {
      throw Error('Ungültige Hostliste für ' + label + '.')
    }
    return [...new Set(input.map(host => host.toLowerCase()))]
  }

  function config(value) {
    if (value?.version !== 1 || !sourceKey.test(value.id || '')) throw Error('Der Katalog braucht Version 1 und eine Kennung.')
    const origin = https(value.origin)
    if (origin.pathname !== '/' || origin.search) throw Error('Die Basisadresse muss auf eine HTTPS-Startseite zeigen.')
    const catalogHosts = hosts(value.catalogHosts || [], 'Katalog')
    const playerHosts = hosts(value.playerHosts || [], 'Player')
    const mediaHosts = hosts(value.mediaHosts, 'Videos')
    const resourceHosts = hosts(value.resourceHosts || [], 'Ressourcen')
    const index = value.index ? https(value.index, [origin.hostname, ...catalogHosts]) : null
    if (index?.search) throw Error('Der Suchindex muss zum Katalog gehören.')
    const fields = {
      listing: ['root','items'],
      detail: ['title','description','poster','imdb','groups','controls','episodeAttribute','sourceAttribute','iframe','seriesPrefix'],
      player: ['variants'],
    }
    const result = {
      version: 1, id: value.id, name: text(value.name, 80, 'Name'), origin: origin.origin,
      catalogHosts, playerHosts, mediaHosts, resourceHosts,
    }
    if (index) result.index = index.href
    for (const [group, names] of Object.entries(fields)) {
      result[group] = {}
      for (const name of names) {
        const rule = text(value[group]?.[name], 450, name, !['items','title','groups'].includes(name))
        if (rule !== undefined) result[group][name] = rule
      }
    }
    if (value.detail?.embedPattern != null) {
      result.detail.embedPattern = text(value.detail.embedPattern, 450, 'Videoauswahl')
    }
    // Matching happens in a disposable worker. Imported syntax is still rejected here.
    for (const expression of [result.detail.embedPattern, result.player.variants].filter(Boolean)) new RegExp(expression)
    for (const selector of [result.listing.root, result.listing.items, result.detail.title, result.detail.description,
      result.detail.poster, result.detail.imdb, result.detail.groups, result.detail.controls, result.detail.iframe].filter(Boolean)) {
      try { document.createElement('template').content.querySelector(selector) } catch {
        throw Error('Der Katalog enthält eine ungültige Auswahlregel.')
      }
    }
    return result
  }

  function base64url(value) {
    return btoa(String.fromCharCode(...encoder.encode(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }

  function decodeTitle(value) {
    const match = typeof value === 'string' && catalogKey.exec(value)
    if (!match) return null
    try {
      const bytes = Uint8Array.from(atob(match[2].replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0))
      const pathname = new TextDecoder('utf-8', {fatal: true}).decode(bytes)
      if (!pathname.startsWith('/') || pathname.startsWith('//') || /[?#\\\u0000-\u0020]/.test(pathname) ||
        base64url(pathname) !== match[2]) return null
      return {id: match[1], pathname}
    } catch { return null }
  }

  function titleID(id, pathname) {
    const value = 'catalog:' + id + ':' + base64url(pathname)
    return decodeTitle(value) ? value : null
  }

  async function sha256(value) {
    if (!globalThis.crypto?.subtle) throw Error('Die sichere Geräteverschlüsselung ist nicht verfügbar.')
    const result = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))
    return Array.from(result, byte => byte.toString(16).padStart(2, '0')).join('')
  }

  const episodeID = async (title, season, episode) => 'media:' + await sha256(title + '|' + season + '|' + episode)
  const mediaID = async value => 'media:' + await sha256(value)
  const isMediaID = value => typeof value === 'string' && mediaKey.test(value)
  const validTime = value => Number.isSafeInteger(value) && value > 0 && value <= Date.now() + 300000

  function episodeOf(value) {
    return Number.isInteger(value?.season) && value.season >= 1 && value.season <= 999 &&
      Number.isInteger(value?.episode) && value.episode >= 1 && value.episode <= 9999
      ? {season: value.season, episode: value.episode} : null
  }

  function titleOf(value) {
    if (!value || !decodeTitle(value.url) && !isMediaID(value.url)) return null
    try {
      const result = {url: value.url, title: text(value.title, 180, 'Titel'), isSeries: value.isSeries === true}
      const poster = safeAddress(value.poster)
      if (poster) result.poster = poster.href
      return result
    } catch { return null }
  }

  function accountVideoURL(value) {
    if (typeof value !== 'string' || value.length > 4096 || !/^https:\/\//i.test(value) ||
      /[\s\\#]/.test(value) || /^https:\/\/[^/?]*@/i.test(value)) return null
    try {
      if (controls.test(decodeURIComponent(value))) return null
      const url = https(value, undefined, 4096)
      for (const field of url.search.slice(1).split(/[&;]/)) {
        const name = decodeURIComponent(field.split('=', 1)[0].replace(/\+/g, ' ')).trim().toLowerCase()
        if (name.startsWith('x-amz-') || name.startsWith('x-goog-') || privateNames.has(name) ||
          name.split(/[^a-z0-9]+/).some(part => privateParts.has(part))) return null
      }
      return url
    } catch { return null }
  }

  function catalogRecord(row) {
    try {
      const id = row?.item_id ?? row?.id
      const at = row?.updated_at ?? row?.updatedAt
      const value = row?.value ?? row
      if (!sourceKey.test(id || '') || !validTime(at)) return null
      if (value.removed === true) return {id, updatedAt: at, removed: true}
      const source = config(value.source)
      return source.id === id ? {id, updatedAt: at, source} : null
    } catch { return null }
  }

  async function mediaRecord(row) {
    if (!row || typeof row !== 'object') return null
    const id = row?.item_id ?? row?.id
    const at = row?.updated_at ?? row?.updatedAt
    const value = row?.value ?? row
    if (!value || typeof value !== 'object' || !isMediaID(id) || !validTime(at)) return null
    if (value.removed === true) return {id, updatedAt: at, removed: true}
    const url = accountVideoURL(value.url)
    if (!url || await mediaID(url.href) !== id) return null
    try { return {id, updatedAt: at, url: url.href, title: text(value.title, 150, 'Titel')} } catch { return null }
  }

  window.KinoFormats = {
    https, safeAddress, config, decodeTitle, titleID, episodeID, mediaID, sha256, isMediaID,
    episodeOf, titleOf, validTime, accountVideoURL, catalogRecord, mediaRecord,
  }
})()
