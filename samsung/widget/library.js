(() => {
  'use strict'

  const keyPattern = /^[a-z0-9][a-z0-9-]{0,30}$/
  const mediaPattern = /^media:[a-f0-9]{64}$/
  const ownerPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
  const primaryProfile = 'Mein Profil'
  const formats = () => window.KinoFormats
  const empty = () => ({ rows: {}, pending: {}, bookmarks: [], views: [], profileData: [] })
  const rowKey = row => row.kind + ':' + row.item_id
  const clock = () => Date.now()

  function read(key) {
    try {
      const data = JSON.parse(localStorage.getItem(key))
      if (!data || !data.rows || !data.pending || !Array.isArray(data.bookmarks) || !Array.isArray(data.views)) return empty()
      data.profileData = (Array.isArray(data.profileData) ? data.profileData : []).filter(profile =>
        typeof profile?.name === 'string' && profile.name.trim() && profile.name !== primaryProfile &&
        Array.isArray(profile.bookmarks) && Array.isArray(profile.views)).slice(0, 10)
      return data
    } catch { return empty() }
  }

  function shareable(url) {
    return Boolean(formats().accountVideoURL(url))
  }

  function create({ onChange = () => {}, getActive = () => null } = {}) {
    let owner = null
    let revision = 0
    let storageKey = 'kinotix.samsung.guest.v1'
    let data = read(storageKey)
    let activeProfile = primaryProfile

    function view() {
      const profile = data.profileData.find(item => item.name === activeProfile)
      return profile ? {
        rows: data.rows, pending: data.pending,
        get bookmarks() { return profile.bookmarks },
        set bookmarks(value) { profile.bookmarks = value },
        get views() { return profile.views },
        set views(value) { profile.views = value }
      } : data
    }

    function setProfile(name) {
      if (name !== primaryProfile && !data.profileData.some(item => item.name === name)) throw Error('Dieses Profil ist nicht verfügbar.')
      activeProfile = name
      onChange()
    }

    function addProfile(name) {
      const title = typeof name === 'string' ? name.trim() : ''
      if (!title || title.length > 40 || /[\u0000-\u001f\u007f]/.test(title)) throw Error('Gib einen Profilnamen mit höchstens 40 Zeichen ein.')
      if (data.profileData.length >= 10) throw Error('Auf diesem Gerät sind bereits zehn zusätzliche Profile gespeichert.')
      if ([primaryProfile, ...data.profileData.map(item => item.name)].some(item => item.toLocaleLowerCase('de') === title.toLocaleLowerCase('de'))) {
        throw Error('Dieser Profilname ist bereits vergeben.')
      }
      data.profileData.push({ name: title, bookmarks: [], views: [] })
      persist()
      setProfile(title)
    }

    function persist() {
      localStorage.setItem(storageKey, JSON.stringify(data))
    }

    function sources() {
      return Object.values(data.rows).filter(row => row.kind === 'catalog' && !row.value.removed)
        .map(row => row.value.source)
    }

    async function updateProvider() {
      const scope = revision
      window.KinoProvider.setCatalogs(sources())
      await window.KinoProvider.setMedia(Object.values(data.rows).filter(row => row.kind === 'media'))
      if (scope === revision) onChange()
    }

    async function valid(row) {
      if (!row || !['catalog', 'media', 'progress'].includes(row.kind) || typeof row.item_id !== 'string' ||
          !Number.isSafeInteger(row.updated_at) || row.updated_at <= 0 || row.updated_at > clock() + 300000 ||
          !row.value || typeof row.value !== 'object' || Array.isArray(row.value)) return false
      const value = row.value
      if (row.kind === 'catalog') {
        if (!keyPattern.test(row.item_id)) return false
        if (value.removed === true) return true
        try { return formats().config(value.source).id === row.item_id } catch { return false }
      }
      if (!mediaPattern.test(row.item_id)) return false
      if (row.kind === 'media') {
        if (value.removed === true) return true
        return shareable(value.url) && typeof value.title === 'string' && value.title.trim() &&
          value.title.length <= 150 && !/[\u0000-\u001f\u007f]/.test(value.title) &&
          await formats().mediaID(value.url) === row.item_id
      }
      if (!Number.isFinite(value.time) || !Number.isFinite(value.duration) || value.time < 0 ||
          value.duration < 0 || value.duration > 86400 || value.time > value.duration + .5 ||
          typeof value.finished !== 'boolean') return false
      if (value.catalog != null) {
        const ref = value.catalog
        if (!formats().decodeTitle(ref.url) || typeof ref.title !== 'string' || !ref.title.trim() ||
            ref.title.length > 180 || !formats().episodeOf(ref) ||
            await formats().episodeID(ref.url, ref.season, ref.episode) !== row.item_id) return false
      }
      return true
    }

    function rebuildHistory() {
      const known = new Map(data.views.map(view => [view.title.url, view.title]))
      const result = new Map()
      for (const row of Object.values(data.rows).filter(row => row.kind === 'progress').sort((a, b) => a.updated_at - b.updated_at)) {
        const value = row.value
        const ref = value.catalog
        let title
        let season = 1
        let episode = 1
        if (ref) {
          const decoded = formats().decodeTitle(ref.url)
          if (!decoded || !sources().some(source => source.id === decoded.id)) continue
          title = { url: ref.url, title: ref.title, poster: known.get(ref.url)?.poster || '', isSeries: ref.isSeries }
          season = ref.season
          episode = ref.episode
        } else {
          const direct = data.rows['media:' + row.item_id]
          if (!direct || direct.value.removed) continue
          title = { url: row.item_id, title: direct.value.title, poster: '', isSeries: false }
        }
        const previous = known.get(title.url)
        const entry = result.get(title.url) || {
          title: { ...previous, ...title, poster: title.poster || previous?.poster || '' },
          positions: {}, updated: 0, hidden: false
        }
        const key = season + ':' + episode
        entry.positions[key] = {
          season, episode, seconds: value.time, duration: value.duration,
          finished: value.finished, updatedAt: row.updated_at
        }
        entry.lastEpisode = key
        entry.updated = row.updated_at
        result.set(title.url, entry)
      }
      for (const entry of data.views) {
        if (!result.has(entry.title.url) && !formats().decodeTitle(entry.title.url) && !mediaPattern.test(entry.title.url)) {
          result.set(entry.title.url, entry)
        }
      }
      data.views = [...result.values()]
    }

    async function applyRows(rows) {
      const scope = revision
      let changed = false
      for (const row of Array.isArray(rows) ? rows : []) {
        if (!await valid(row) || scope !== revision) continue
        const key = rowKey(row)
        if ((data.rows[key]?.updated_at || 0) >= row.updated_at) continue
        if (row.kind === 'progress' && row.item_id === getActive()) continue
        data.rows[key] = row
        changed = true
      }
      if (scope !== revision || !changed) return
      rebuildHistory()
      persist()
      await updateProvider()
    }

    async function put(kind, id, value, scope = revision) {
      if (scope !== revision) throw Error('Das Konto hat sich geändert. Versuche es erneut.')
      const key = kind + ':' + id
      const row = { kind, item_id: id, value,
        updated_at: Math.max(clock(), (data.rows[key]?.updated_at || 0) + 1) }
      if (!await valid(row) || scope !== revision) throw Error('Die Angabe konnte nicht gespeichert werden.')
      row.updated_at = Math.max(row.updated_at, (data.rows[key]?.updated_at || 0) + 1)
      data.rows[key] = row
      if (owner) data.pending[key] = row
      persist()
      return row
    }

    async function recordProgress(item) {
      const scope = revision
      if (activeProfile !== primaryProfile) { persist(); return }
      const title = formats().titleOf(item?.title)
      const episode = formats().episodeOf(item)
      if (!title || !episode || !Number.isFinite(item.seconds) || !Number.isFinite(item.duration) ||
          item.seconds < 0 || item.duration <= 0 || item.duration > 86400) return
      const decoded = formats().decodeTitle(title.url)
      const id = decoded ? await formats().episodeID(title.url, episode.season, episode.episode) : title.url
      if (!mediaPattern.test(id)) return
      const value = { time: Math.min(item.seconds, item.duration), duration: item.duration, finished: item.finished === true }
      if (decoded) value.catalog = { url: title.url, title: title.title, ...episode, isSeries: Boolean(title.isSeries) }
      await put('progress', id, value, scope)
    }

    return {
      view,
      profile: () => activeProfile,
      profiles: () => [primaryProfile, ...data.profileData.map(item => item.name)],
      setProfile,
      addProfile,
      persist,
      sources,
      pending: () => Object.values(data.pending),
      acknowledge(rows) {
        for (const row of rows) {
          const key = rowKey(row)
          if (data.pending[key]?.updated_at === row.updated_at) delete data.pending[key]
        }
        persist()
      },
      async setAccount(next) {
        if (next && !ownerPattern.test(next.id)) throw Error('Das Konto hat keine gültige Kennung.')
        owner = next
        activeProfile = primaryProfile
        revision++
        storageKey = 'kinotix.samsung.' + (owner ? owner.id.toLowerCase() : 'guest') + '.v1'
        data = read(storageKey)
        await updateProvider()
      },
      applyRows,
      recordProgress,
      async addCatalog(source) {
        const checked = formats().config(source)
        const current = sources().find(item => item.id === checked.id)
        if (current && new URL(current.origin).origin !== new URL(checked.origin).origin) {
          throw Error('Diese Katalogkennung ist bereits mit einer anderen Adresse verbunden.')
        }
        await put('catalog', checked.id, { source: checked })
        await updateProvider()
      },
      async removeCatalog(id) {
        if (!sources().some(source => source.id === id)) return
        await put('catalog', id, { removed: true })
        rebuildHistory()
        persist()
        await updateProvider()
      },
      async addMedia(address, title) {
        const scope = revision
        const url = formats().accountVideoURL(address)
        if (!url) throw Error('Verwende einen HTTPS-Videolink ohne Zugangsdaten.')
        const href = url.href
        await put('media', await formats().mediaID(href), {
          url: href, title: String(title || new URL(href).pathname.split('/').pop() || 'Video').trim().slice(0, 150)
        }, scope)
        await updateProvider()
      }
    }
  }

  window.KinoLibrary = { create }
})()
