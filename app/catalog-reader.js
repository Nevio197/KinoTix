((rules, html, base = location.href) => {
  const doc = html === undefined ? document : new DOMParser().parseFromString(html, 'text/html')
  const text = element => element?.textContent?.trim() || ''
  const absolute = value => {
    try { return value ? new URL(value,base).href : '' } catch { return '' }
  }
  const decorative = /(?:^|[_.-])(?:logo|icon|placeholder|spacer|blank|spinner|no[-_]?image)(?=[_.-]|$)/i
  const image = node => {
    if (node && !node.matches('img')) node = node.querySelector('img')
    if (!node) return ''
    const sources = ['data-src','data-lazy-src','data-original'].map(key=>node.getAttribute(key))
    sources.push(node.currentSrc,node.getAttribute('src'))
    for (const candidate of (node.getAttribute('data-srcset') || node.getAttribute('srcset') || '').split(',').reverse()) {
      sources.push(candidate.trim().split(/\s+/)[0])
    }
    return sources.map(absolute).find(url=>url.startsWith('https:') &&
      !decorative.test(new URL(url).pathname.split('/').at(-1))) || ''
  }
  const pick = (root,selector) => selector ? root.querySelector(selector) : null
  const find = (root,selector) => selector ? [...root.querySelectorAll(selector)] : []
  const year = name => Number(name.match(/\b(?:19|20)\d{2}\b(?=[)\s]*$)/)?.[0]) || null
  const normalizeTitle = value => (value || '').normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase()
  const listingPoster = (node,title,address) => {
    const card = node.closest('article,.short') || node
    const titleName = normalizeTitle(title)
    let poster = '', best = -1
    for (const candidate of find(card,'img').slice(0,24)) {
      const url = image(candidate)
      if (!url) continue
      const matchesTitle = titleName && normalizeTitle(candidate.getAttribute('alt'))===titleName
      const matchesLink = address && absolute(candidate.closest('a[href]')?.getAttribute('href'))===address
      const displayed = absolute(candidate.currentSrc || candidate.getAttribute('src'))===url
      const width = (displayed && candidate.naturalWidth) || Number(candidate.getAttribute('width'))
      const height = (displayed && candidate.naturalHeight) || Number(candidate.getAttribute('height'))
      if (displayed && !matchesTitle && !matchesLink && width>0 && height>0 && Math.max(width,height)<64) continue
      const score = (matchesTitle?8:0)+(matchesLink?4:0)+(width>0 && height>width?2:0)+(Math.max(width,height)>=110?1:0)
      if (score<=best) continue
      best = score
      poster = url
    }
    return poster
  }
  if (rules.cover) {
    return image(pick(doc,rules.cover)) || absolute(pick(doc,'meta[property="og:image"]')?.getAttribute('content'))
  }
  if (rules.listing) {
    const {root,items} = rules.listing
    return {ready:root?Boolean(pick(doc,root)):html!==undefined || doc.readyState==='complete',
      items:find(doc,items).slice(0,200).map(node=>{
        const title=text(node) || node.getAttribute('title') || node.querySelector('img')?.getAttribute('alt') || ''
        const url=absolute(node.getAttribute('href'))
        return {title,url,poster:listingPoster(node,title,url),year:year(title)}
      })}
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

  if (rules.detail) {
    const field=rules.detail
    const title=text(pick(doc,field.title))
    const imdb=pick(doc,field.imdb)?.getAttribute('href')?.match(/tt\d{7,12}/)?.[0]
    const episodes=new Map()
    const add=(season,episode,value)=>{
      const url=absolute(value)
      if (!season || !episode || !url) return
      const key=season+':'+episode
      if (!episodes.has(key)) episodes.set(key,{season,episode,sources:[]})
      const row=episodes.get(key)
      if (!row.sources.includes(url)) row.sources.push(url)
    }
    for (const group of find(doc,field.groups).slice(0,24)) {
      const controls=find(group,field.controls)
      for (const node of controls.slice(0,500)) {
        const coordinates=(node.getAttribute(field.episodeAttribute || 'data-episode')||'').split(/[-:]/).map(Number)
        const raw=node.getAttribute(field.sourceAttribute || 'data-source') || ''
        let address=(field.embedPattern && raw.match(new RegExp(field.embedPattern))?.[1]) || raw
        if (address.trim().startsWith('<')) {
          const fragment=new DOMParser().parseFromString(address,'text/html')
          address=fragment.querySelector('iframe[src], video[src], source[src]')?.getAttribute('src')
        }
        add(coordinates[0],coordinates[1],address)
      }
      if (!controls.length) {
        const video=pick(group,field.iframe) || group.querySelector('video[src], video source[src]')
        const src=video?.getAttribute('src')
        if (src) add(1,1,src)
        else {
          const scripts=find(group,'script:not([src])').slice(0,24).map(node=>node.textContent)
          for (const slot of matrixSlots(scripts)) add(slot.season,slot.episode,slot.url)
        }
      }
    }
    const description=pick(doc,field.description)?.cloneNode(true)
    description?.querySelectorAll('script,style,img').forEach(node=>node.remove())
    return {ready:Boolean(title && (episodes.size || html!==undefined || doc.readyState==='complete')),title,year:year(title),imdb,
      poster:image(pick(doc,field.poster)) || absolute(pick(doc,'meta[property="og:image"]')?.getAttribute('content')),
      description:text(description).replace(/\s+/g,' ').slice(0,600),
      isSeries:Boolean(field.seriesPrefix && new URL(base).pathname.startsWith(field.seriesPrefix)) || episodes.size>1,
      episodes:[...episodes.values()]}
  }
  const result=[]
  if (rules.player.variants) {
    const pattern=new RegExp(rules.player.variants,'g')
    for (const script of find(doc,'script:not([src])').slice(0,100)) {
      for (const match of script.textContent.slice(0,100000).matchAll(pattern)) {
        result.push({height:Number(match[1]),url:absolute(match[2])})
        if (result.length>=20) break
      }
      if (result.length>=20) break
    }
  }
  for (const video of find(doc,'video, video source[src]').slice(0,20)) {
    const src=video.getAttribute('src') || video.currentSrc
    const label=video.getAttribute('label') || video.getAttribute('res') || video.getAttribute('height') || ''
    if (src) result.push({height:Number(label.match(/\d{2,4}/)?.[0]) || video.videoHeight || 0,url:absolute(src)})
  }
  return result
})
