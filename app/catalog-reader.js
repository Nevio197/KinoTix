(rules => {
  const text = element => element?.textContent?.trim() || ''
  const absolute = value => {
    try { return value ? new URL(value,location.href).href : '' } catch { return '' }
  }
  const decorative = /(?:^|[_.-])(?:logo|icon|placeholder|spacer|blank|spinner|no[-_]?image)(?=[_.-]|$)/i
  const image = node => {
    if (!node) return ''
    const sources = ['data-src','data-lazy-src','data-original'].map(key=>node.getAttribute(key))
    sources.push(node.currentSrc,node.getAttribute('src'))
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
  if (rules.listing) {
    const {root,items} = rules.listing
    return {ready:root?Boolean(pick(document,root)):document.readyState==='complete',
      items:find(document,items).slice(0,200).map(node=>{
        const title=text(node) || node.getAttribute('title') || node.querySelector('img')?.getAttribute('alt') || ''
        const url=absolute(node.getAttribute('href'))
        return {title,url,poster:listingPoster(node,title,url),year:year(title)}
      })}
  }
  if (rules.detail) {
    const field=rules.detail
    const title=text(pick(document,field.title))
    const imdb=pick(document,field.imdb)?.getAttribute('href')?.match(/tt\d{7,12}/)?.[0]
    const episodes=new Map()
    const add=(season,episode,value)=>{
      const url=absolute(value)
      if (!season || !episode || !url) return
      const key=season+':'+episode
      if (!episodes.has(key)) episodes.set(key,{season,episode,sources:[]})
      const row=episodes.get(key)
      if (!row.sources.includes(url)) row.sources.push(url)
    }
    for (const group of find(document,field.groups).slice(0,24)) {
      const controls=find(group,field.controls)
      for (const node of controls.slice(0,500)) {
        const coordinates=(node.getAttribute(field.episodeAttribute)||'').split(/[-:]/).map(Number)
        const raw=node.getAttribute(field.sourceAttribute) || ''
        const address=field.embedPattern?raw.match(new RegExp(field.embedPattern))?.[1]:raw
        add(coordinates[0],coordinates[1],address)
      }
      if (!controls.length) add(1,1,pick(group,field.iframe)?.getAttribute('src'))
    }
    const description=pick(document,field.description)?.cloneNode(true)
    description?.querySelectorAll('script,style,img').forEach(node=>node.remove())
    return {ready:Boolean(title && (episodes.size || document.readyState==='complete')),title,year:year(title),imdb,
      poster:image(pick(document,field.poster)),description:text(description).replace(/\s+/g,' ').slice(0,600),
      isSeries:Boolean(field.seriesPrefix && location.pathname.startsWith(field.seriesPrefix)) || episodes.size>1,
      episodes:[...episodes.values()]}
  }
  const result=[]
  if (rules.player.variants) {
    const pattern=new RegExp(rules.player.variants,'g')
    for (const script of [...document.scripts].slice(0,100)) {
      for (const match of script.textContent.slice(0,100000).matchAll(pattern)) {
        result.push({height:Number(match[1]),url:absolute(match[2])})
        if (result.length>=20) break
      }
      if (result.length>=20) break
    }
  }
  for (const video of [...document.querySelectorAll('video')].slice(0,5)) {
    if (video.currentSrc || video.src) result.push({height:video.videoHeight || 0,url:absolute(video.currentSrc || video.src)})
  }
  return result
})
