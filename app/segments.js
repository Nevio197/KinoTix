;(() => {
  const automatic = new Set(['intro', 'outro'])
  const segmentKey = mark => mark.type+':'+mark.start+':'+mark.end
  const validID = value => typeof value === 'string' && /^tt\d{7,12}$/.test(value)
  const normalize = name => name.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

  function interval(value) {
    const start = value?.start_sec
    const end = value?.end_sec
    return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start ? {start,end} : null
  }

  function readSegments(response, local = {}) {
    const markers = []
    for (const type of ['intro','recap','outro']) {
      const raw = local[type] ?? response?.[type]
      const provider = local[type] ? 'Medienliste' : 'IntroDB'
      const mark = interval(raw)
      if ((!local[type] && response?.['no_' + type]) || !mark || !Number.isFinite(raw.confidence) || raw.confidence < .75) continue
      if (type !== 'outro') {
        if (mark.end <= 1200) markers.push({type,provider,...mark})
        continue
      }
      // Preserve a known post-credits scene even when its confidence is low.
      const post = local.post_credits ?? response?.post_credits
      if (post != null) {
        const scene = interval(post)
        if (!scene) continue
        const before = Math.min(mark.end, scene.start)
        const after = Math.max(mark.start, scene.end)
        if (before > mark.start) markers.push({type,provider,start:mark.start,end:before,creditsEnd:mark.end})
        if (mark.end > after) markers.push({type,provider,start:after,end:mark.end})
      } else markers.push({type,provider,...mark})
    }
    return markers
  }

  function destination(mark, time, duration) {
    if (!Number.isFinite(time) || !Number.isFinite(duration) || time < mark.start || (mark.creditsEnd ?? mark.end) > duration + 2) return null
    if (mark.type === 'outro' && mark.start < duration / 2) return null
    const target = Math.min(mark.end, duration - .1)
    return target - time > .5 ? target : null
  }

  function autoSkip(markers, skipped, time, duration) {
    for (const mark of markers) {
      if (!automatic.has(mark.type) || skipped.has(segmentKey(mark))) continue
      const target = destination(mark, time, duration)
      if (target !== null) return {mark,target}
    }
    return null
  }

  function markerService(load) {
    const identities = new Map()
    const cache = new Map()
    async function findID(title) {
      if (!title.isSeries) return null
      const name = title.title.replace(/\s*\(\d{4}\).*$/, '').trim()
      const shows = await load('https://api.tvmaze.com/search/shows?q=' + encodeURIComponent(name))
      if (!Array.isArray(shows)) return null
      const matches = shows.filter(({show}) => typeof show?.name === 'string' &&
        normalize(show.name) === normalize(name) && (!title.year || show.premiered?.startsWith(String(title.year))))
      return matches.length === 1 ? matches[0].show.externals?.imdb : null
    }
    return async (title, episode, local) => {
      try {
        let id = title.imdb
        if (!validID(id)) {
          if (!identities.has(title.url)) {
            const match = await findID(title)
            if (validID(match)) identities.set(title.url, match)
          }
          id = identities.get(title.url)
        }
        if (!validID(id)) return readSegments(null,local)
        const query = new URLSearchParams({imdb_id:id})
        if (title.isSeries) {
          query.set('season', episode.season)
          query.set('episode', episode.episode)
        } else query.set('is_movie', 'true')
        const key = query.toString()
        let response = cache.get(key)
        if (!response) {
          response = await load('https://api.introdb.app/segments?' + key)
          if (response) cache.set(key,response)
        }
        return readSegments(response,local)
      } catch { return readSegments(null,local) }
    }
  }

  const api = { autoSkip, destination, markerService, readSegments, segmentKey }
  if (typeof module === 'object' && module.exports) module.exports = api
  else window.KinoSegments = api
})()
