(() => {
  'use strict'

  // The same local file is a disposable regex worker. Catalog scripts are only text.
  if (typeof document === 'undefined') {
    self.onmessage = ({data}) => {
      if (data?.type !== 'kinotix-pattern') return
      try {
        if (typeof data.pattern !== 'string' || data.pattern.length > 450 || ![1, 2].includes(data.groups) ||
          !Array.isArray(data.texts) || data.texts.length > (data.groups === 1 ? 500 : 100)) throw Error('Ungültiges Muster.')
        const expression = new RegExp(data.pattern, 'g')
        const result = []
        let remaining = 500000
        for (const input of data.texts) {
          if (typeof input !== 'string' || remaining <= 0) break
          const value = input.slice(0, Math.min(100000, remaining))
          remaining -= value.length
          expression.lastIndex = 0
          if (data.groups === 1) {
            const match = expression.exec(value)
            result.push(match?.[1]?.slice(0, 2048) || '')
            continue
          }
          for (let match; (match = expression.exec(value)) !== null;) {
            if (match[1] && (data.groups === 1 || match[2])) {
              result.push(data.groups === 1 ? match[1].slice(0, 2048) :
                {height: Number(match[1]), url: match[2].slice(0, 2048)})
            }
            if (result.length >= 20) break
            if (!match[0].length) expression.lastIndex++
          }
          if (result.length >= 20) break
        }
        self.postMessage({result})
      } catch { self.postMessage({error: true}) }
    }
    return
  }

  const F = window.KinoFormats
  if (!F) throw Error('Die KinoTix-Datenformate fehlen.')
  const sourceLimit = 30
  const textLimit = 2 * 1024 * 1024
  const indexLimit = 14 * 1024 * 1024
  const mediaPath = /\.(?:mp4|m4v|webm|mov|ogv|m3u8|mkv|ts)$/i
  const decorative = /(?:^|[_.-])(?:logo|icon|placeholder|spacer|blank|spinner|no[-_]?image)(?=[_.-]|$)/i
  let catalogs = new Map()
  let media = new Map()
  let epoch = 0
  let mediaEpoch = 0
  let lastRequest = 'Noch keine Katalogabfrage'
  const homeCache = new Map()
  const indexCache = new Map()
  const titleCache = new Map()
  const episodeSources = new WeakMap()
  const markerIdentities = new Map()
  const markerResponses = new Map()
  const markerTypes = ['intro', 'recap', 'outro', 'post_credits']
  const imdbID = /^tt\d{7,12}$/

  function setCatalogs(records) {
    const next = new Map()
    for (const raw of Array.isArray(records) ? records.slice(0, 100) : []) {
      try {
        let source
        if (raw?.version === 1) source = F.config(raw)
        else {
          const record = F.catalogRecord(raw)
          if (record && !record.removed) source = record.source
        }
        if (source && next.size < sourceLimit) next.set(source.id, source)
      } catch {}
    }
    const ordered = map => JSON.stringify([...map.values()].sort((a, b) => a.id.localeCompare(b.id)))
    if (ordered(next) === ordered(catalogs)) return false
    catalogs = next
    epoch++
    homeCache.clear()
    indexCache.clear()
    titleCache.clear()
    return true
  }

  async function setMedia(records) {
    const ticket = ++mediaEpoch
    const next = new Map()
    for (const raw of Array.isArray(records) ? records.slice(0, 5000) : []) {
      const record = await F.mediaRecord(raw)
      if (record && !record.removed) {
        next.set(record.id, {title: record.title, url: record.id, address: record.url, poster: '',
          isSeries: false, provider: 'Videolink'})
      }
    }
    if (ticket !== mediaEpoch) return false
    const changed = JSON.stringify([...next.values()]) !== JSON.stringify([...media.values()])
    media = next
    return changed
  }

  function safeTree(html) {
    const template = document.createElement('template')
    template.innerHTML = html
    return template.content
  }

  function pick(root, selector) { return selector ? root.querySelector(selector) : null }
  function find(root, selector) { return selector ? [...root.querySelectorAll(selector)] : [] }
  function value(node) { return node?.textContent?.trim() || '' }
  function normalize(name) { return name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('de') }
  const catalogHosts = source => [...new Set([new URL(source.origin).hostname, ...source.catalogHosts])]
  const playbackHosts = source => [...new Set([...source.playerHosts, ...source.mediaHosts])]
  const resourceHosts = source => [...new Set([...catalogHosts(source), ...playbackHosts(source), ...source.resourceHosts])]

  function titleSource(id) {
    const ref = F.decodeTitle(id)
    const source = ref && catalogs.get(ref.id)
    if (!source) throw Error('Dieser Katalog ist auf dem Fernseher nicht verfügbar.')
    const url = F.safeAddress(ref.pathname, source.origin, catalogHosts(source))
    if (!url) throw Error('Die Titeladresse gehört nicht zum Katalog.')
    return {source, url}
  }

  async function read(url, allowedHosts, limit = textLimit) {
    if (!window.KinoTransport?.text) throw Error('Der Netzwerkdienst ist nicht verfügbar.')
    const target = F.https(url, allowedHosts)
    try {
      const result = await window.KinoTransport.text(target.href, {allowedHosts, maxBytes: limit})
      if (typeof result !== 'string' || !result.length || new TextEncoder().encode(result).length > limit) {
        throw Error('Die Quelle liefert ungültige oder zu große Daten.')
      }
      lastRequest = 'Quelle erreichbar'
      return result
    } catch (error) {
      lastRequest = 'Abruf fehlgeschlagen'
      throw error
    }
  }

  function image(node, base, source) {
    if (!node) return ''
    for (const key of ['data-src', 'data-lazy-src', 'data-original', 'src']) {
      const url = F.safeAddress(node.getAttribute(key), base, resourceHosts(source))
      if (url && !decorative.test(url.pathname.split('/').pop())) return url.href
    }
    return ''
  }

  function listingPoster(node, title, base, source) {
    const card = node.closest('article,.short') || node
    let poster = '', best = -1
    for (const candidate of find(card, 'img').slice(0, 24)) {
      const url = image(candidate, base, source)
      if (!url) continue
      const matchesTitle = normalize(candidate.getAttribute('alt') || '') === normalize(title)
      const matchesLink = F.safeAddress(candidate.closest('a[href]')?.getAttribute('href'), base)?.href ===
        F.safeAddress(node.getAttribute('href'), base)?.href
      const width = Number(candidate.getAttribute('width')), height = Number(candidate.getAttribute('height'))
      if (!matchesTitle && !matchesLink && width > 0 && height > 0 && Math.max(width, height) < 64) continue
      const score = (matchesTitle ? 8 : 0) + (matchesLink ? 4 : 0) + (height > width ? 2 : 0) +
        (Math.max(width, height) >= 110 ? 1 : 0)
      if (score > best) { best = score; poster = url }
    }
    return poster
  }

  function catalogTitle(source, target, label, poster = '') {
    const url = F.safeAddress(target, source.origin, catalogHosts(source))
    const title = typeof label === 'string' ? label.trim().slice(0, 180) : ''
    const id = url && F.titleID(source.id, url.pathname)
    if (!id || !title) return null
    const address = new URL(url.pathname, source.origin).href
    return {url: id, address, title, poster, provider: source.name,
      isSeries: Boolean(source.detail.seriesPrefix && url.pathname.startsWith(source.detail.seriesPrefix))}
  }

  async function homeOne(source) {
    const cached = homeCache.get(source.id)
    if (cached && cached.until > Date.now()) return cached.items
    const ticket = epoch
    const page = safeTree(await read(source.origin, catalogHosts(source)))
    if (source.listing.root && !pick(page, source.listing.root)) {
      throw Error('Die Quelle liefert nicht die erwartete Katalogstruktur.')
    }
    const results = new Map()
    for (const node of find(page, source.listing.items).slice(0, 200)) {
      const title = value(node) || node.getAttribute('title') || node.querySelector('img')?.getAttribute('alt') || ''
      const item = catalogTitle(source, node.getAttribute('href'), title, listingPoster(node, title, source.origin, source))
      if (item) results.set(item.url, item)
    }
    const items = [...results.values()]
    if (ticket === epoch) homeCache.set(source.id, {until: Date.now() + 120000, items})
    return items
  }

  async function home() {
    const ticket = epoch
    const responses = await Promise.allSettled([...catalogs.values()].map(homeOne))
    if (ticket !== epoch) throw Error('Der Katalog hat sich geändert. Öffne die Mediathek erneut.')
    const result = new Map([...media.values()].map(item => [item.url, item]))
    for (const response of responses) {
      if (response.status === 'fulfilled') for (const item of response.value) result.set(item.url, item)
    }
    if (!result.size && responses.length && responses.every(item => item.status === 'rejected')) {
      throw Error('Die Kataloge sind gerade nicht erreichbar.')
    }
    return [...result.values()]
  }

  async function readIndex(source) {
    if (!source.index) return []
    const cached = indexCache.get(source.id)
    if (cached && cached.until > Date.now()) return cached.items
    const ticket = epoch
    const xml = await read(source.index, catalogHosts(source), indexLimit)
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw Error('Der Suchindex enthält nicht unterstützte XML-Deklarationen.')
    const tree = new DOMParser().parseFromString(xml, 'application/xml')
    const root = tree.documentElement
    if (!root || root.localName !== 'urlset' || tree.getElementsByTagName('parsererror').length) {
      throw Error('Der Suchindex enthält kein gültiges URL-Verzeichnis.')
    }
    const results = new Map()
    let count = 0
    for (const element of root.children) {
      if (element.localName !== 'url' || element.namespaceURI !== root.namespaceURI) continue
      const loc = [...element.children].find(node => node.localName === 'loc' && node.namespaceURI === root.namespaceURI)
      if (!loc) continue
      if (++count > 80000) break
      const address = F.safeAddress(value(loc), source.origin, catalogHosts(source))
      if (!address) continue
      let label
      try {
        label = decodeURIComponent(address.pathname.split('/').filter(Boolean).pop() || '')
          .replace(/^\d+-/, '').replace(/\.[a-z]{2,5}$/i, '').replace(/[-_]+/g, ' ').trim()
      } catch { continue }
      if (!label) continue
      const item = catalogTitle(source, address.href, label[0]?.toLocaleUpperCase('de') + label.slice(1))
      if (item) results.set(item.url, item)
    }
    const items = [...results.values()]
    if (ticket === epoch) indexCache.set(source.id, {until: Date.now() + 120000, items})
    return items
  }

  async function search(query) {
    const input = typeof query === 'string' ? query.trim().slice(0, 125) : ''
    if (!input) return home()
    const ticket = epoch
    const responses = await Promise.allSettled([...catalogs.values()].flatMap(source => [homeOne(source), readIndex(source)]))
    if (ticket !== epoch) throw Error('Der Katalog hat sich geändert. Suche erneut.')
    const found = new Map([...media.values()].map(item => [item.url, item]))
    for (const response of responses) {
      if (response.status === 'fulfilled') for (const item of response.value) found.set(item.url, item)
    }
    const phrase = normalize(input), terms = phrase.split(/\s+/)
    const matches = [...found.values()].filter(item => terms.every(term => normalize(item.title).includes(term)))
    if (!matches.length && responses.length && responses.every(row => row.status === 'rejected')) {
      throw Error('Die Katalogsuche ist gerade nicht erreichbar.')
    }
    const rank = item => {
      const name = normalize(item.title)
      return name === phrase ? 0 : name.startsWith(phrase + ' ') ? 1 : name.includes(phrase) ? 2 : 3
    }
    return matches.sort((a, b) => rank(a) - rank(b) || a.title.length - b.title.length ||
      a.title.localeCompare(b.title, 'de')).slice(0, 80)
  }

  function matchPattern(pattern, texts, groups) {
    if (!pattern || !texts.length) return Promise.resolve([])
    return new Promise((resolve, reject) => {
      let worker
      let timeout
      function finish(error, matches) {
        clearTimeout(timeout)
        worker?.terminate()
        if (error) reject(error)
        else resolve(matches)
      }
      try {
        worker = new Worker('provider.js')
        timeout = setTimeout(() => finish(Error('Die Videoauswahl hat ihr Zeitlimit überschritten.')), 1200)
        worker.onerror = () => finish(Error('Die Videoauswahl konnte nicht gelesen werden.'))
        worker.onmessage = ({data}) => {
          if (data?.error || !Array.isArray(data?.result)) finish(Error('Die Auswahlregel für die Quelle ist ungültig.'))
          else finish(null, data.result)
        }
        worker.postMessage({type: 'kinotix-pattern', pattern, texts: texts.slice(0, groups === 1 ? 500 : 100), groups})
      } catch { finish(Error('Die sichere Videoauswahl ist auf diesem Gerät nicht verfügbar.')) }
    })
  }

  function literalSource(input) {
    if (typeof input !== 'string' || input.length > 2048) return null
    let text = ''
    for (let index = 0; index < input.length; index++) {
      let char = input[index]
      if (char === '\\') {
        char = input[++index]
        if (char === 'u' || char === 'x') {
          const length = char === 'u' ? 4 : 2
          const digits = input.slice(index + 1, index + length + 1)
          if (!new RegExp('^[a-f0-9]{' + length + '}$', 'i').test(digits)) return null
          char = String.fromCharCode(parseInt(digits, 16))
          index += length
        } else if (!['\\', '/', '"', "'"].includes(char)) return null
      }
      if (!char || /[\u0000-\u001f\u007f]/.test(char)) return null
      text += char
    }
    try { encodeURIComponent(text) } catch { return null }
    return text
  }

  // Reads only literal season arrays used by static episode widgets.
  function matrixSlots(scripts) {
    let remaining = 500000
    const slots = []
    for (const raw of scripts.slice(0, 24)) {
      if (remaining <= 0 || slots.length >= 500) break
      const text = raw.slice(0, Math.min(100000, remaining))
      remaining -= text.length
      let index = 0, candidates = 0
      const failed = () => { throw Error('Kein statisches Folgenverzeichnis.') }
      function trivia() {
        while (index < text.length) {
          if (/\s/.test(text[index])) index++
          else if (text.startsWith('//', index)) {
            while (index < text.length && !/[\r\n]/.test(text[index])) index++
          } else if (text.startsWith('/*', index)) {
            const end = text.indexOf('*/', index + 2)
            index = end < 0 ? text.length : end + 2
          } else break
        }
      }
      function take(char) {
        trivia()
        if (text[index] !== char) return false
        index++
        return true
      }
      function expect(char) { if (!take(char)) failed() }
      function string() {
        trivia()
        const quote = text[index++]
        if (quote !== '"' && quote !== "'") failed()
        let literal = ''
        while (index < text.length) {
          const char = text[index++]
          if (char === quote) return literalSource(literal)
          if (char === '\r' || char === '\n') failed()
          literal += char
          if (char === '\\') {
            if (index >= text.length) failed()
            const next = text[index++]
            if (next === '\r' || next === '\n') {
              literal = literal.slice(0, -1)
              if (next === '\r' && text[index] === '\n') index++
            } else literal += next
          }
          if (literal.length > 2048) failed()
        }
        failed()
      }
      function skipQuoted() {
        const quote = text[index++]
        while (index < text.length) {
          const char = text[index++]
          if (char === quote) return
          if (char === '\\') index++
        }
      }
      function call() {
        expect('(')
        trivia()
        const count = /^\d{1,4}(?!\d)/.exec(text.slice(index))
        if (!count) failed()
        index += count[0].length
        expect(',')
        expect('[')
        const result = []
        if (!take(']')) {
          for (let season = 1; season <= 999; season++) {
            expect('[')
            if (!take(']')) {
              for (let episode = 1; episode <= 9999; episode++) {
                trivia()
                let url
                if (text.startsWith('null', index)) { index += 4; url = null }
                else url = string()
                if (url && result.length < 500) result.push({season, episode, url})
                if (take(']')) break
                expect(',')
                if (take(']')) break
                if (episode === 9999) failed()
              }
            }
            if (take(']')) break
            expect(',')
            if (take(']')) break
            if (season === 999) failed()
          }
        }
        // Some static players append a numeric option (for example volume).
        // Accept only the literal, never expressions, callbacks or remote code.
        if (take(',')) {
          trivia()
          const option = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i.exec(text.slice(index))?.[0]
          if (!option || option.length > 32 || !Number.isFinite(Number(option))) failed()
          index += option.length
        }
        expect(')')
        return result
      }
      while (index < text.length) {
        trivia()
        if (['"', "'", '`'].includes(text[index])) { skipQuoted(); continue }
        const start = index++
        if (text[start] !== '.' || !text.startsWith('show', start + 1) ||
          !/[a-z0-9_$]/i.test(text.slice(0, start).trim().slice(-1))) continue
        if (++candidates > 12) break
        index = start + 5
        try {
          const found = call()
          if (found.length) { slots.push(...found.slice(0, 500 - slots.length)); break }
        } catch { index = start + 5 }
      }
    }
    return slots
  }

  function addEpisode(records, source, base, season, episode, raw) {
    if (!Number.isInteger(season) || season < 1 || season > 999 ||
      !Number.isInteger(episode) || episode < 1 || episode > 9999) return
    const url = F.safeAddress(raw, base, playbackHosts(source))
    if (!url) return
    const key = season + ':' + episode
    if (!records.has(key)) {
      if (records.size >= 500) return
      records.set(key, {season, episode, sources: []})
    }
    const row = records.get(key)
    if (row.sources.length < 6 && !row.sources.includes(url.href)) row.sources.push(url.href)
  }

  async function detail(item) {
    const id = item?.url
    if (F.isMediaID(id)) {
      const entry = media.get(id)
      if (!entry) throw Error('Dieser Videolink ist im Konto nicht verfügbar.')
      const episode = {id, season: 1, episode: 1, sources: [entry.address], titleURL: id}
      episodeSources.set(episode, {direct: entry.address})
      return {...entry, episodes: [episode], description: ''}
    }
    const {source, url} = titleSource(id)
    const cached = titleCache.get(id)
    if (cached && cached.until > Date.now()) return cached.item
    const ticket = epoch
    const page = safeTree(await read(url.href, catalogHosts(source)))
    const rules = source.detail
    const title = value(pick(page, rules.title)).slice(0, 180)
    if (!title) throw Error('Der Katalog hat keine Details für diesen Titel geliefert.')
    const imdb = pick(page, rules.imdb)?.getAttribute('href')?.match(/\btt\d{7,12}\b/)?.[0]
    const year = Number(title.match(/\b(?:19|20)\d{2}\b(?=[)\s]*$)/)?.[0]) || null
    const records = new Map()
    const groups = find(page, rules.groups).slice(0, 24)
    const controlRows = groups.flatMap(group => find(group, rules.controls)).slice(0, 500)
    let captured = []
    if (rules.embedPattern && controlRows.length) {
      captured = await matchPattern(rules.embedPattern,
        controlRows.map(row => row.getAttribute(rules.sourceAttribute) || ''), 1)
    }
    // Controls are normally short onclick attributes. Match each only when no pattern is declared.
    let captureIndex = 0
    for (const group of groups) {
      const buttons = find(group, rules.controls).filter(button => controlRows.includes(button))
      for (const button of buttons) {
        const numbers = (button.getAttribute(rules.episodeAttribute) || '').split(/[-:]/).map(Number)
        if (numbers.length !== 2) { captureIndex++; continue }
        let raw = button.getAttribute(rules.sourceAttribute) || ''
        if (rules.embedPattern) raw = captured[captureIndex] || ''
        captureIndex++
        const decoded = literalSource(raw)
        if (decoded) raw = decoded
        if (raw.trim().startsWith('<')) raw = pick(safeTree(raw), 'iframe[src],video[src],source[src]')?.getAttribute('src') || ''
        addEpisode(records, source, url, numbers[0], numbers[1], raw)
      }
      if (!buttons.length) {
        const iframe = pick(group, rules.iframe) || pick(group, 'video[src],source[src]')
        const address = F.safeAddress(iframe?.getAttribute('src'), url, playbackHosts(source))
        if (address) addEpisode(records, source, url, 1, 1, address.href)
        else {
          const scripts = find(group, 'script:not([src])').map(script => script.textContent || '')
          for (const row of matrixSlots(scripts)) addEpisode(records, source, url, row.season, row.episode, row.url)
        }
      }
    }
    if (!records.size) throw Error('Der Katalog hat keine verfügbaren Folgen oder Videos geliefert.')
    const episodes = [...records.values()].sort((a, b) => a.season - b.season || a.episode - b.episode)
    for (const episode of episodes) {
      episode.id = await F.episodeID(id, episode.season, episode.episode)
      episode.catalogId = source.id
      episode.titleURL = id
      episodeSources.set(episode, {source, links: episode.sources})
    }
    const desc = pick(page, rules.description)?.cloneNode(true)
    for (const node of find(desc || document.createElement('div'), 'script,style,img')) node.remove()
    const result = {
      title, url: id, address: url.href, imdb: imdbID.test(imdb || '') ? imdb : undefined, year,
      poster: image(pick(page, rules.poster), url, source) || item?.poster || '',
      description: value(desc).replace(/\s+/g, ' ').slice(0, 600), provider: source.name,
      isSeries: Boolean(rules.seriesPrefix && url.pathname.startsWith(rules.seriesPrefix)) || episodes.length > 1,
      episodes,
    }
    if (ticket !== epoch || catalogs.get(source.id) !== source) throw Error('Der Katalog hat sich geändert. Öffne den Titel erneut.')
    titleCache.set(id, {until: Date.now() + 600000, item: result})
    return result
  }

  function addVariant(result, seen, source, base, raw, height) {
    const url = F.safeAddress(raw, base, source.mediaHosts)
    if (!url || seen.has(url.href) || result.length >= 10) return
    seen.add(url.href)
    result.push({url: url.href, height: Number.isInteger(height) && height >= 0 && height <= 4320 ? height : 0})
  }

  async function playerVariants(source, input) {
    const address = F.https(input, playbackHosts(source))
    if (source.mediaHosts.includes(address.hostname) && mediaPath.test(address.pathname)) return [{url: address.href, height: 0}]
    const page = safeTree(await read(address.href, playbackHosts(source)))
    const variants = [], seen = new Set()
    if (source.player.variants) {
      const scripts = find(page, 'script:not([src])').slice(0, 100).map(script => script.textContent || '')
      for (const match of await matchPattern(source.player.variants, scripts, 2)) {
        addVariant(variants, seen, source, address, literalSource(match.url), match.height)
      }
    }
    for (const video of find(page, 'video[src],video source[src]').slice(0, 10)) {
      const height = Number((video.getAttribute('data-height') || video.getAttribute('height') ||
        video.getAttribute('label') || '0').replace(/[pP]$/, ''))
      addVariant(variants, seen, source, address, video.getAttribute('src'), height)
    }
    return variants.sort((a, b) => b.height - a.height)
  }

  async function sources(episode) {
    let entry = episodeSources.get(episode)
    if (!entry && F.isMediaID(episode?.titleURL)) {
      const item = media.get(episode.titleURL)
      if (item) entry = {direct: item.address}
    }
    if (!entry && episode?.catalogId && catalogs.has(episode.catalogId)) {
      const source = catalogs.get(episode.catalogId)
      entry = {source, links: episode.sources}
    }
    if (!entry) throw Error('Öffne den Titel erneut, um die Videoquellen zu laden.')
    if (entry.direct) return [{url: entry.direct, height: 0}]
    const {source} = entry
    const ticket = epoch
    const attempts = await Promise.allSettled((Array.isArray(entry.links) ? entry.links : []).slice(0, 6)
      .map(link => playerVariants(source, link)))
    if (ticket !== epoch || catalogs.get(source.id) !== source) throw Error('Die Quelle hat sich geändert. Öffne den Titel erneut.')
    const result = new Map()
    attempts.forEach((response, index) => {
      if (response.status === 'fulfilled') for (const variant of response.value) {
        if (!result.has(variant.url)) result.set(variant.url, {...variant, source: index, sourceName: 'Quelle ' + (index + 1)})
      }
    })
    if (!result.size) throw Error('Keine Katalogquelle enthält einen direkt abspielbaren Videostream.')
    return [...result.values()].sort((a, b) => b.height - a.height)
  }

  function markerInterval(raw, local) {
    const start = local && Array.isArray(raw) ? raw[0] : raw?.start_sec
    const end = local && Array.isArray(raw) ? raw[1] : raw?.end_sec
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > 86400 ||
      Array.isArray(raw) && raw.length !== 2) return null
    return [start, end]
  }

  function safeMarkers(remote, local) {
    const result = {}
    for (const type of markerTypes) {
      const own = local?.[type] != null
      const raw = own ? local[type] : remote?.[type]
      const range = markerInterval(raw, own)
      if (!range) continue
      if (type !== 'post_credits') {
        const confidence = own && Array.isArray(raw) ? 1 : raw?.confidence
        if (!Number.isFinite(confidence) || confidence < .75 || confidence > 1 ||
          !own && remote?.['no_' + type] || type !== 'outro' && range[1] > 1200) continue
      }
      result[type] = range
    }
    // A malformed known scene must never turn into permission to skip over it.
    if ((local?.post_credits ?? remote?.post_credits) != null && !result.post_credits) delete result.outro
    return result
  }

  function boundedCache(cache, key, value) {
    if (!cache.has(key) && cache.size >= 200) cache.delete(cache.keys().next().value)
    cache.set(key, value)
    return value
  }

  async function markerJSON(address, host) {
    // Public metadata only, with no catalog/player host, credentials, or remote code.
    const target = F.https(address, [host])
    let timer
    try {
      const data = await Promise.race([
        window.KinoTransport.text(target.href, {allowedHosts: [host], maxBytes: 256 * 1024,
          headers: {Accept: 'application/json'}}),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Zeitmarken nicht verfügbar.')), 4500) }),
      ])
      if (typeof data !== 'string' || new TextEncoder().encode(data).byteLength > 256 * 1024) return null
      return JSON.parse(data)
    } finally { clearTimeout(timer) }
  }

  async function markerIdentity(title) {
    if (imdbID.test(title?.imdb || '')) return title.imdb
    if (!title?.isSeries || typeof title.title !== 'string') return null
    const name = title.title.slice(0, 180).replace(/\s*\(\d{4}\).*$/, '').trim()
    if (!name) return null
    const year = Number.isInteger(title.year) && title.year >= 1800 && title.year <= 2199 ? title.year : null
    const key = JSON.stringify([name, year])
    if (!markerIdentities.has(key)) {
      const pending = (async () => {
        const shows = await markerJSON('https://api.tvmaze.com/search/shows?q=' + encodeURIComponent(name), 'api.tvmaze.com')
        if (!Array.isArray(shows) || shows.length > 100) return null
        const comparable = text => text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
          .replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
        const matches = shows.filter(row => typeof row?.show?.name === 'string' && row.show.name.length <= 180 &&
          comparable(row.show.name) === comparable(name) &&
          (!year || typeof row.show.premiered === 'string' && row.show.premiered.startsWith(String(year))))
        const id = matches.length === 1 ? matches[0].show.externals?.imdb : null
        return imdbID.test(id || '') ? id : null
      })().catch(() => null)
      boundedCache(markerIdentities, key, pending)
    }
    return markerIdentities.get(key)
  }

  async function markers(title, episode) {
    const local = episode?.segments
    try {
      if (title?.isSeries && (!Number.isInteger(episode?.season) || episode.season < 1 || episode.season > 999 ||
        !Number.isInteger(episode?.episode) || episode.episode < 1 || episode.episode > 9999)) return safeMarkers(null, local)
      const id = await markerIdentity(title)
      if (!id) return safeMarkers(null, local)
      const query = new URLSearchParams({imdb_id: id})
      if (title.isSeries) {
        query.set('season', episode.season)
        query.set('episode', episode.episode)
      } else query.set('is_movie', 'true')
      const key = query.toString()
      if (!markerResponses.has(key)) {
        const pending = markerJSON('https://api.introdb.app/segments?' + key, 'api.introdb.app').catch(() => null)
        boundedCache(markerResponses, key, pending)
      }
      const remote = await markerResponses.get(key)
      return safeMarkers(remote && !Array.isArray(remote) && typeof remote === 'object' ? remote : null, local)
    } catch { return safeMarkers(null, local) }
  }

  function diagnostics() {
    return [
      {label: 'Kataloge', value: String(catalogs.size)},
      {label: 'Videolinks', value: String(media.size)},
      {label: 'Letzter Abruf', value: lastRequest},
      ...(window.KinoTransport?.diagnostics?.() || []),
    ]
  }

  window.KinoProvider = {setCatalogs, setMedia, home, search, detail, sources, markers, diagnostics}
})()
