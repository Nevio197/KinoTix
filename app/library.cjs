const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

function openLibrary(folder) {
  const file = path.join(folder, 'bibliothek.json')
  const read = filename => {
    try { return JSON.parse(fs.readFileSync(filename, 'utf8')) } catch { return null }
  }
  const create = (name, history = {}) => ({ id: randomUUID(), name, history, lists: [{id: 'default', name: 'Merkliste', items: {}}], sources: {} })
  const first = create('Mein Profil', read(path.join(folder, 'fortschritt.json')) ?? {})
  const state = read(file) ?? { active: first.id, profiles: [first] }
  const audio = () => ({
    level: Number.isFinite(state.audio?.level) ? Math.max(0,Math.min(1,state.audio.level)) : 1,
    muted: state.audio?.muted === true,
  })
  const setAudio = value => { state.audio = value }
  const audioLanguage = () => typeof state.audioLanguage === 'string' ? state.audioLanguage : ''
  const setAudioLanguage = value => {
    if (value === audioLanguage()) return
    state.audioLanguage = value
    save()
  }
  const profile = () => state.profiles.find(p => p.id === state.active) ?? state.profiles[0]
  function save() {
    fs.writeFileSync(file + '.tmp', JSON.stringify(state), { mode: 0o600 })
    fs.renameSync(file + '.tmp', file)
  }
  function snapshot() {
    const p = profile()
    return {
      profile: { id: p.id, name: p.name },
      profiles: state.profiles.map(({id,name}) => ({id,name})),
      lists: p.lists,
      history: Object.values(p.history).sort((a,b) => b.updatedAt-a.updatedAt),
    }
  }
  function addProfile(name) {
    if (!name || name.length > 35 || state.profiles.some(p => p.name.toLowerCase() === name.toLowerCase())) throw Error('Wähle einen neuen Profilnamen mit höchstens 35 Zeichen.')
    const p = create(name)
    state.profiles.push(p)
    state.active = p.id
    save()
    return snapshot()
  }
  function select(id) {
    if (!state.profiles.some(p => p.id === id)) throw Error('Das Profil wurde nicht gefunden.')
    state.active = id
    save()
    return snapshot()
  }
  function addList(name) {
    const p = profile()
    if (!name || name.length > 50 || p.lists.some(list => list.name.toLowerCase() === name.toLowerCase())) throw Error('Wähle einen neuen Listennamen mit höchstens 50 Zeichen.')
    p.lists.push({id:randomUUID(),name,items:{}})
    save()
    return snapshot()
  }
  function toggle(list, title) {
    if (list.items[title.url]) delete list.items[title.url]
    else list.items[title.url] = {
      ...display(title),
      latest: title.episodes?.length ? {season:title.episodes.at(-1).season,episode:title.episodes.at(-1).episode} : null,
      lastChecked: Date.now(),
    }
    save()
    return snapshot()
  }
  function display({ title, url, poster, isSeries, year, genres, language, runtime }) {
    return { title, url, poster, isSeries, year, genres, language, runtime }
  }
  function record(p, title, episode, {time,duration,ended,finished:explicit}, options = {}) {
    const key = episode.season + ':' + episode.episode
    const current = p.history[title.url] ?? { ...display(title), episodes: {} }
    const previous = current.episodes[key]
    const finished = explicit ?? (ended || (duration > 0 && time / duration >= 0.97))
    if (time < 1 && !previous && !finished && !options.force) return
    if (ended && previous?.finished && !options.force) return
    if (options.remote && previous?.updatedAt >= options.remote) return
    const updatedAt = options.remote || Date.now()
    current.episodes[key] = {time, duration, finished: Boolean(finished), updatedAt}
    if (!current.updatedAt || updatedAt >= current.updatedAt) {
      current.updatedAt = updatedAt
      current.last = key
      if (!options.keepHidden) current.hidden = false
    }
    p.history[title.url] = current
    if (options.save!==false) save()
    return current.episodes[key]
  }
  function newEpisodes(p, title) {
    const newest = title.episodes?.at(-1)
    if (!newest || !title.isSeries) return
    let changed = false
    for (const list of p.lists) {
      const item = list.items[title.url]
      if (!item) continue
      const previous = item.latest
      const advanced = previous && (newest.season > previous.season || (newest.season === previous.season && newest.episode > previous.episode))
      if (advanced) item.fresh = { season: newest.season, episode: newest.episode }
      if (advanced || !previous) item.latest = { season: newest.season, episode: newest.episode }
      item.lastChecked = Date.now()
      changed = true
    }
    if (changed) save()
  }
  function viewed(url) {
    for (const list of profile().lists) if (list.items[url]) delete list.items[url].fresh
    save()
    return snapshot()
  }
  return { profile, primaryProfile: () => state.profiles[0], save, audio, setAudio, audioLanguage, setAudioLanguage, snapshot, addProfile, select, addList, toggle,
    record, newEpisodes, viewed, find: id => state.profiles.find(p => p.id === id) }
}
module.exports = { openLibrary }
