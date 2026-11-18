(function () {
  'use strict'

  const root = document.getElementById('view')
  const nav = document.querySelector('nav')
  const playerControlsTimeout = 4000
  const keyNames = {
    13: 'Enter', 19: 'MediaPause', 27: 'Back', 37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight',
    40: 'ArrowDown', 412: 'MediaRewind', 413: 'MediaStop', 415: 'MediaPlay',
    417: 'MediaFastForward', 10009: 'Back', 10252: 'MediaPlayPause',
  }
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
  let route = { name: 'home' }
  let stack = []
  let generation = 0
  let playing = null
  let catalog = null
  let searchResults = null
  const posterLookups = new Map()
  const posterImages = new Map()
  let posterGeneration = 0
  let store
  let library = { bookmarks: [], views: [] }
  let account
  let accountPoll
  let syncState = {}
  let activeEpisodeID = null
  let bindingAccount = false
  let sleepDeadline = 0
  let sleepAfterEpisode = false
  let preferences
  try { preferences = JSON.parse(localStorage.getItem('kinotix.samsung.settings.v1')) } catch {}
  preferences = { autoNext: true, autoSkip: true, ...preferences }

  function savePreferences() {
    try { localStorage.setItem('kinotix.samsung.settings.v1', JSON.stringify(preferences)) } catch {}
  }
  let sync = null
  let refreshSyncSettings = null

  function persist() {
    try { store?.persist() }
    catch { root.prepend(status('Die Änderungen konnten auf diesem Fernseher nicht gespeichert werden.')) }
  }

  function storedTitle(title) {
    return { title: title.title, url: title.url, poster: title.poster || '', isSeries: Boolean(title.isSeries) }
  }

  function episodeKey(episode) {
    return Number(episode.season) + ':' + Number(episode.episode)
  }

  function historyFor(title) {
    return library.views.find(view => view.title.url === title.url)
  }

  function lastViewed(title, episode) {
    return historyFor(title)?.positions?.[episodeKey(episode)]
  }

  function timeLabel(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0))
    const hours = Math.floor(total / 3600)
    const minutes = Math.floor(total / 60) % 60
    const remainder = String(total % 60).padStart(2, '0')
    return hours ? hours + ':' + String(minutes).padStart(2, '0') + ':' + remainder : minutes + ':' + remainder
  }

  function safeURL(value) {
    try {
      const url = new URL(value)
      return url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)
        ? url.href : ''
    } catch {
      return ''
    }
  }

  function registerRemote() {
    try {
      const api = window.tizen && window.tizen.tvinputdevice
      if (!api) return
      const names = ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaFastForward', 'MediaRewind']
      const supported = api.getSupportedKeys().map(key => key.name)
      names.filter(name => supported.includes(name)).forEach(name => {
        try { api.registerKey(name) } catch {}
      })
    } catch {}
  }

  function el(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  function button(label, callback, options = {}) {
    const node = el('button', options.className || 'action', label)
    node.type = 'button'
    if (options.focus) node.dataset.focus = options.focus
    if (options.aria) node.setAttribute('aria-label', options.aria)
    node.addEventListener('click', callback)
    return node
  }

  function status(label, className = 'status loading') {
    const node = el('p', className, label)
    node.setAttribute('role', 'status')
    return node
  }

  function message(title, detail, retry) {
    const box = el('section', 'message')
    box.append(el('h2', '', title), el('p', '', detail))
    if (retry) box.append(button('Erneut versuchen', retry, { className: 'action primary', focus: 'retry' }))
    return box
  }

  function errorText(error, fallback) {
    const text = typeof error?.message === 'string' ? error.message.trim() : ''
    return text && !/^(?:Failed to fetch$|NetworkError)/i.test(text) ? text : fallback
  }

  function focusElement(node) {
    if (!node) return
    node.focus({ preventScroll: true })
    node.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  function focusKey(key, fallback) {
    const picked = key && Array.from(document.querySelectorAll('[data-focus]')).find(node => node.dataset.focus === key)
    focusElement(picked || fallback || document.querySelector('nav [aria-current="page"]'))
  }

  function memory() {
    return { ...route, focus: document.activeElement?.dataset.focus }
  }

  function navigate(next, options = {}) {
    if (options.reset) stack = []
    else if (!options.replace && route.name !== 'player') stack.push(memory())
    if (playing) releasePlayer()
    route = next
    show()
  }

  function back() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {})
      return
    }
    if (route.name === 'home') {
      focusKey('nav-home')
      return
    }
    const previous = stack.pop() || { name: 'home' }
    navigate(previous, { replace: true })
  }

  function show() {
    const id = ++generation
    refreshSyncSettings = null
    document.body.classList.toggle('playing', route.name === 'player')
    const activeNav = ['home', 'search', 'library', 'settings'].includes(route.name) ? route.name : ''
    nav.querySelectorAll('button').forEach(node => {
      if (node.dataset.action === activeNav) node.setAttribute('aria-current', 'page')
      else node.removeAttribute('aria-current')
    })
    root.replaceChildren()
    window.scrollTo(0, 0)
    if (route.name === 'home') void renderHome(id)
    else if (route.name === 'search') renderSearch()
    else if (route.name === 'detail') void renderDetail(id)
    else if (route.name === 'player') void renderPlayer(id)
    else if (route.name === 'library') renderLibrary()
    else if (route.name === 'settings') renderSettings()
    else if (route.name === 'sync') renderSyncSettings()
    else if (route.name === 'profiles') renderProfiles()
    else if (route.name === 'sources') renderSources()
    else if (route.name === 'add-source') renderAddSource()
    else if (route.name === 'diagnostics') void renderDiagnostics(id)
  }

  async function nativePoster(address) {
    if (posterImages.has(address)) return posterImages.get(address)
    const ownerGeneration = posterGeneration
    const pending = (async () => {
      const url = KinoFormats.https(address)
      const response = await KinoTransport.request(url.href, {
        allowedHosts: [url.hostname], maxBytes: 2 * 1024 * 1024, responseType: 'bytes'
      })
      if (response.status !== 200 || !(response.body instanceof Uint8Array) || response.body.length < 12 ||
          ownerGeneration !== posterGeneration) return ''
      const bytes = response.body
      const magic = String.fromCharCode(...bytes.subarray(0, 12))
      const mime = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg' :
        magic.startsWith('\x89PNG\r\n\x1a\n') ? 'image/png' : /^GIF8[79]a/.test(magic) ? 'image/gif' :
          magic.startsWith('RIFF') && magic.slice(8) === 'WEBP' ? 'image/webp' : ''
      return mime ? URL.createObjectURL(new Blob([bytes], {type: mime})) : ''
    })().catch(() => '')
    posterImages.set(address, pending)
    if (posterImages.size > 80) {
      const first = posterImages.keys().next().value
      void posterImages.get(first).then(blob => { if (blob) URL.revokeObjectURL(blob) })
      posterImages.delete(first)
    }
    return pending
  }

  function clearPosters() {
    posterGeneration++
    posterLookups.clear()
    for (const pending of posterImages.values()) void pending.then(blob => { if (blob) URL.revokeObjectURL(blob) })
    posterImages.clear()
  }

  function poster(title) {
    const frame = el('span', 'poster')
    frame.setAttribute('aria-hidden', 'true')
    const image = safeURL(title.poster)
    let refreshed = false
    const recovered = new Set()
    const placeholder = () => {
      frame.replaceChildren(el('span', 'poster-placeholder', '▶'))
      if (refreshed || !KinoFormats.decodeTitle(title.url)) return
      refreshed = true
      if (!posterLookups.has(title.url)) {
        if (posterLookups.size >= 100) posterLookups.delete(posterLookups.keys().next().value)
        posterLookups.set(title.url, KinoProvider.detail(title).then(detail => safeURL(detail.poster)).catch(() => ''))
      }
      void posterLookups.get(title.url).then(address => {
        if (!address || !frame.isConnected) return
        title.poster = address
        persist()
        showImage(address)
      })
    }
    function showImage(address) {
      const picture = el('img')
      picture.src = address
      picture.alt = ''
      picture.loading = 'lazy'
      picture.addEventListener('error', () => {
        if (!address.startsWith('https:') || recovered.has(address)) { placeholder(); return }
        recovered.add(address)
        void nativePoster(address).then(blob => {
          if (!frame.isConnected) return
          if (blob) showImage(blob)
          else placeholder()
        })
      }, { once: true })
      frame.replaceChildren(picture)
    }
    if (image) showImage(image)
    else placeholder()
    return frame
  }

  function grid(titles, context, history = false) {
    const list = el('div', 'grid ' + (history ? 'history-grid' : 'poster-grid'))
    titles.forEach(value => {
      const title = history ? value.title : value
      const node = button('', () => navigate({ name: 'detail', title }), {
        className: 'card' + (history ? ' history-card' : ''), focus: context + ':' + title.url, aria: title.title,
      })
      const meta = el('span', 'card-meta')
      meta.append(el('span', 'title-text', title.title))
      if (history) {
        const latest = value.positions[value.lastEpisode]
        const episode = latest && title.isSeries ? 'S' + latest.season + ' · F' + latest.episode + '  •  ' : ''
        if (latest) {
          meta.append(el('span', 'caption', episode + (latest.finished ? 'Nächste Folge' : timeLabel(latest.seconds))))
          if (!latest.finished && latest.duration > 0) {
            const track = el('span', 'progress-track')
            const fill = el('span')
            fill.style.width = Math.min(100, latest.seconds / latest.duration * 100) + '%'
            track.append(fill)
            meta.append(track)
          }
        }
      }
      node.append(poster(title), meta)
      list.append(node)
    })
    return list
  }

  function headingSection(heading, content) {
    const section = el('section')
    section.append(el('h2', 'section-title', heading), content)
    return section
  }

  async function renderHome(id) {
    const history = library.views.filter(entry => !entry.hidden)
      .filter(entry => entry.title.isSeries || !entry.positions[entry.lastEpisode]?.finished)
      .sort((a, b) => b.updated - a.updated)
    if (history.length) root.append(headingSection('Weiterschauen', grid(history.slice(0, 8), 'history', true)))
    const feed = el('section')
    root.append(feed)
    if (!catalog) {
      feed.append(status('Katalog wird geladen …'))
      focusKey(route.focus, document.querySelector('nav [data-action="home"]'))
    }
    try {
      if (!catalog) {
        const result = await window.KinoProvider.home()
        if (id !== generation) return
        catalog = Array.isArray(result) ? result : []
      }
      feed.replaceChildren(catalog.length ? headingSection('Neu im Katalog', grid(catalog, 'home')) :
        message('Deine Mediathek ist leer', 'Melde dich mit deinem Google-Konto an, um deine Quellen zu übernehmen.', () => navigate({ name: 'sync' })))
    } catch (error) {
      if (id !== generation) return
      feed.replaceChildren(message('Katalog gerade nicht erreichbar', errorText(error, 'Prüfe die Internetverbindung des Fernsehers.'), reloadCatalog))
    }
    const current = document.activeElement
    if (!current || current === document.body || !current.closest('#view') && current.dataset.action === 'home') {
      focusKey(route.focus, root.querySelector('button'))
    }
  }

  function reloadCatalog() {
    catalog = null
    show()
  }

  function renderSearch() {
    root.append(el('h1', 'page-title', 'Suche'))
    const form = el('form', 'search-entry')
    const field = el('input')
    field.type = 'search'
    field.placeholder = 'Film oder Serie'
    field.value = route.query || ''
    field.dataset.focus = 'search-input'
    field.autocomplete = 'off'
    field.setAttribute('aria-label', 'Film oder Serie')
    const submit = el('button', 'action primary', 'Suchen')
    submit.type = 'submit'
    submit.dataset.focus = 'submit-search'
    form.append(field, submit)
    const layout = el('section', 'search-layout')
    const keys = el('div', 'search-keys')
    keys.setAttribute('aria-label', 'Bildschirmtastatur')
    const output = el('div', 'search-results')
    layout.append(keys, output)
    root.append(form, layout)
    const set = text => {
      field.value = text
      route.query = text
      searchResults = null
    }
    'ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÜ0123456789'.split('').forEach(char => {
      keys.append(button(char, () => set(field.value + char), { className: '', focus: 'key-' + char }))
    })
    keys.append(
      button('Leerzeichen', () => set(field.value + ' '), { className: 'wide-key', focus: 'spacing' }),
      button('← Löschen', () => set(field.value.slice(0, -1)), { className: 'wide-key', focus: 'delete' }),
      button('Leeren', () => set(''), { className: 'wide-key', focus: 'clear' })
    )
    field.addEventListener('input', () => set(field.value))
    form.addEventListener('submit', event => {
      event.preventDefault()
      void search()
    })
    async function search() {
      const query = field.value.trim()
      route.query = field.value
      if (query.length < 2) {
        output.replaceChildren(message('Film oder Serie suchen', 'Gib mindestens zwei Zeichen ein.'))
        return
      }
      const id = ++generation
      output.replaceChildren(status('Suche läuft …'))
      try {
        const items = await window.KinoProvider.search(query)
        if (id !== generation || route.name !== 'search') return
        searchResults = { query, items: Array.isArray(items) ? items : [] }
        results()
        focusElement(output.querySelector('button') || submit)
      } catch (error) {
        if (id !== generation || route.name !== 'search') return
        output.replaceChildren(message('Suche nicht verfügbar', errorText(error, 'Die Verbindung zum Katalog ist fehlgeschlagen.'), search))
        focusElement(output.querySelector('button'))
      }
    }
    function results() {
      const match = searchResults && searchResults.query === (route.query || '').trim() ? searchResults.items : null
      if (match?.length) output.replaceChildren(headingSection('Suchergebnisse', grid(match, 'result')))
      else if (match) output.replaceChildren(message('Keine Treffer', 'Probiere einen anderen Titel oder eine kürzere Suche.'))
      else output.replaceChildren(status('Gib einen Filmtitel oder Seriennamen ein.', 'status'))
    }
    results()
    focusKey(route.focus, keys.querySelector('button'))
  }

  function renderLibrary() {
    root.append(el('h1', 'page-title', 'Merkliste'))
    if (library.bookmarks.length > 1) {
      root.append(button('Zufällig auswählen', () => navigate({
        name: 'detail', title: library.bookmarks[Math.floor(Math.random() * library.bookmarks.length)]
      }), { focus: 'random-saved', className: 'action primary' }))
    }
    root.append(library.bookmarks.length ? grid(library.bookmarks, 'saved') :
      message('Deine Merkliste ist leer', 'Merke Filme oder Serien auf ihrer Titelseite.'))
    focusKey(route.focus, root.querySelector('button'))
  }

  function sortedEpisodes(title) {
    return (Array.isArray(title.episodes) ? title.episodes : []).slice().sort((a, b) => a.season - b.season || a.episode - b.episode)
  }

  async function renderDetail(id) {
    const selected = route.title
    const tools = el('div', 'detail-controls action-row')
    tools.append(button('← Zurück', back, { focus: 'back' }))
    root.append(tools, status('Titel wird geladen …'))
    try {
      const title = route.detail || await window.KinoProvider.detail(selected)
      if (id !== generation) return
      if (!title || typeof title.title !== 'string') throw new Error('Es sind keine Titelangaben verfügbar.')
      route.detail = title
      const episodes = sortedEpisodes(title)
      const history = historyFor(title)
      const latest = history?.positions?.[history.lastEpisode]
      const previousIndex = latest ? episodes.findIndex(episode => episodeKey(episode) === history.lastEpisode) : -1
      const suggested = previousIndex >= 0 ? episodes[previousIndex + (latest.finished ? 1 : 0)] || episodes[previousIndex] : episodes[0]
      root.replaceChildren(tools)
      const description = el('div', 'hero-content')
      description.append(el('div', 'badge', title.isSeries ? 'Serie' : 'Film'), el('h1', '', title.title))
      if (title.description) description.append(el('p', '', title.description))
      const actions = el('div', 'action-row')
      if (suggested) {
        const position = lastViewed(title, suggested)
        const label = position && !position.finished ? 'Fortsetzen bei ' + timeLabel(position.seconds) : '▶ Abspielen'
        const play = button(label, () => navigate({ name: 'player', title, episode: suggested }), {
          className: 'action primary', focus: 'play',
        })
        if (title.isSeries) play.setAttribute('aria-label', label + ', Staffel ' + suggested.season + ' Folge ' + suggested.episode)
        actions.append(play)
      }
      const marked = () => library.bookmarks.some(item => item.url === title.url)
      const bookmark = button(marked() ? '✓ Gemerkt' : '+ Merken', () => {
        if (marked()) library.bookmarks = library.bookmarks.filter(item => item.url !== title.url)
        else library.bookmarks.unshift(storedTitle(title))
        bookmark.textContent = marked() ? '✓ Gemerkt' : '+ Merken'
        bookmark.setAttribute('aria-pressed', String(marked()))
        persist()
      }, { focus: 'bookmark' })
      bookmark.setAttribute('aria-pressed', String(marked()))
      actions.append(bookmark)
      description.append(actions)
      const hero = el('section', 'hero')
      hero.append(poster(title), description)
      root.append(hero)
      if (!episodes.length) root.append(message('Derzeit keine Quelle', 'Versuche es später erneut.', () => {
        route.detail = null
        show()
      }))
      else if (title.isSeries) renderEpisodes(title, episodes, suggested.season)
      focusKey(route.focus, root.querySelector('[data-focus="play"]') || bookmark)
    } catch (error) {
      if (id !== generation) return
      root.replaceChildren(tools, message('Titel konnte nicht geladen werden', errorText(error, 'Prüfe die Internetverbindung.'), show))
      focusKey(route.focus, root.querySelector('[data-focus="retry"]'))
    }
  }

  function renderEpisodes(title, episodes, initialSeason) {
    const section = el('section')
    const choices = el('div', 'seasons')
    const episodeGrid = el('div', 'grid episodes')
    const seasons = Array.from(new Set(episodes.map(episode => episode.season)))
    section.append(el('h2', 'section-title', 'Folgen'))
    if (seasons.length > 1) section.append(choices)
    section.append(episodeGrid)
    root.append(section)
    function select(season) {
      route.season = season
      Array.from(choices.children).forEach(choice => choice.setAttribute('aria-pressed', String(Number(choice.dataset.season) === season)))
      episodeGrid.replaceChildren()
      episodes.filter(episode => episode.season === season).forEach(episode => {
        const saved = lastViewed(title, episode)
        const node = button('Folge ' + episode.episode, () => navigate({ name: 'player', title, episode }), {
          className: 'episode', focus: 'episode:' + episodeKey(episode),
        })
        if (saved) node.append(el('span', 'caption', saved.finished ? 'Gesehen' : 'Bei ' + timeLabel(saved.seconds)))
        episodeGrid.append(node)
      })
    }
    seasons.forEach(season => {
      const choice = button('Staffel ' + season, () => select(season), { focus: 'season:' + season })
      choice.dataset.season = String(season)
      choices.append(choice)
    })
    select(seasons.includes(route.season) ? route.season : initialSeason)
  }

  function renderSettings() {
    root.append(el('h1', 'page-title', 'Einstellungen'))
    const row = el('div', 'action-row')
    row.append(button(store.profile(), () => navigate({ name: 'profiles' }), { focus: 'profile' }))
    row.append(button('Google-Konto', () => navigate({ name: 'sync' }), { focus: 'sync' }))
    row.append(button('Quellen und Kataloge', () => navigate({ name: 'sources' }), { focus: 'sources' }))
    row.append(button('Netzwerkdiagnose', () => navigate({ name: 'diagnostics' }), { focus: 'diagnose' }))
    root.append(row)
    const playbackOptions = el('div', 'action-row')
    const autoNext = button('Nächste Folge automatisch · ' + (preferences.autoNext ? 'An' : 'Aus'), () => {
      preferences.autoNext = !preferences.autoNext
      savePreferences()
      show()
    }, { focus: 'auto-next' })
    const autoSkip = button('Intro und Abspann automatisch · ' + (preferences.autoSkip ? 'An' : 'Aus'), () => {
      preferences.autoSkip = !preferences.autoSkip
      savePreferences()
      show()
    }, { focus: 'auto-skip' })
    playbackOptions.append(autoNext, autoSkip)
    root.append(playbackOptions, el('p', 'caption', 'KinoTix 0.2.1 · Samsung TV'))
    root.append(el('p', 'caption', 'Zeitmarken von IntroDB · ODbL. Serieninformationen von TVmaze · CC BY-SA.'))
    focusKey(route.focus, row.querySelector('button'))
  }

  function renderProfiles() {
    root.append(el('h1', 'page-title', 'Profile'))
    root.append(button('← Zurück', back, { focus: 'back' }))
    const choices = el('div', 'action-row')
    for (const name of store.profiles()) {
      const choice = button(name, () => { store.setProfile(name); navigate({ name: 'home' }, { reset: true }) }, { focus: 'profile:' + name })
      choice.setAttribute('aria-pressed', String(name === store.profile()))
      choices.append(choice)
    }
    const form = el('form', 'search-entry')
    const field = el('input')
    field.type = 'text'
    field.placeholder = 'Neues Profil'
    field.maxLength = 40
    field.setAttribute('aria-label', 'Neuer Profilname')
    field.dataset.focus = 'profile-name'
    const submit = button('Profil hinzufügen', () => {}, { focus: 'add-profile' })
    submit.type = 'submit'
    form.append(field, submit)
    form.addEventListener('submit', event => {
      event.preventDefault()
      try {
        store.addProfile(field.value)
        navigate({ name: 'home' }, { reset: true })
      } catch (error) { root.append(status(errorText(error, 'Das Profil konnte nicht hinzugefügt werden.'))) }
    })
    root.append(choices, form,
      el('p', 'caption', 'Mein Profil synchronisiert deinen Wiedergabestand. Weitere Profile speichern ihre Merkliste und ihren Verlauf auf diesem Fernseher.'))
    focusKey(route.focus, choices.querySelector('button'))
  }

  function renderSyncSettings() {
    const tools = el('div', 'action-row detail-controls')
    tools.append(button('← Zurück', back, { focus: 'back' }))
    const section = el('section', 'sync-panel')
    root.append(tools, el('h1', 'page-title', 'Google-Konto'), section)
    const indicator = status(syncState.message || 'Konto wird geprüft …', 'status')
    section.append(indicator)
    refreshSyncSettings = () => {
      const before = [syncState.connected, syncState.awaitingConfirmation, Boolean(syncState.qrUrl)].join('|')
      const after = account.status()
      const next = [after.connected, after.awaitingConfirmation, Boolean(after.qrUrl)].join('|')
      syncState = after
      if (before !== next) show()
      else indicator.textContent = syncState.message || ''
    }
    if (syncState.connected) {
      section.append(el('p', '', syncState.email || 'Google-Konto verbunden'))
      section.append(el('p', '', 'Kataloge, Videolinks und der Wiedergabestand werden mit deinen angemeldeten Geräten synchronisiert.'))
      const refresh = button('Jetzt synchronisieren', () => { void account.exchange() }, { focus: 'sync-now', className: 'action primary' })
      section.append(refresh, button('Abmelden', () => runAccount(() => account.signOut()), { focus: 'sign-out' }))
      focusKey(route.focus, refresh)
    } else if (syncState.awaitingConfirmation) {
      section.append(el('p', '', syncState.email || 'Konto bestätigen'))
      const confirm = button('Mit diesem Konto verbinden', () => runAccount(() => account.confirmSignIn()), { focus: 'confirm-account', className: 'action primary' })
      section.append(confirm, button('Abbrechen', () => runAccount(() => account.cancelSignIn()), { focus: 'cancel-sign-in' }))
      focusKey(route.focus, confirm)
    } else if (syncState.qrUrl) {
      const qr = qrcode(0, 'M')
      qr.addData(syncState.qrUrl)
      qr.make()
      const code = el('div', 'qr-code')
      code.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 4, scalable: true })
      section.append(code, el('p', '', 'Scanne den QR-Code mit deinem Handy und melde dich mit demselben Google-Konto wie auf deinen anderen Geräten an. Bestätige anschließend das Konto hier am Fernseher.'))
      const cancel = button('Abbrechen', () => runAccount(() => account.cancelSignIn()), { focus: 'cancel-sign-in' })
      section.append(cancel)
      focusKey(route.focus, cancel)
    } else {
      section.append(el('p', '', 'Deine Quellen und der Wiedergabestand kommen über dein KinoTix-Konto auf den Fernseher.'))
      const signIn = button('Mit Handy anmelden', () => runAccount(() => account.beginSignIn()), { focus: 'sign-in', className: 'action primary' })
      signIn.disabled = !syncState.configured || syncState.restoring
      section.append(signIn)
      focusKey(route.focus, signIn)
    }
  }

  async function runAccount(operation) {
    const target = generation
    const controls = root.querySelectorAll('button')
    controls.forEach(node => { node.disabled = true })
    try {
      await operation()
      syncState = account.status()
      if (route.name === 'sync' && target === generation) show()
    } catch (error) {
      syncState = account.status()
      if (target === generation) {
        controls.forEach(node => { node.disabled = false })
        root.append(status(errorText(error, 'Das Konto ist gerade nicht erreichbar.'), 'status'))
      }
    }
  }

  function renderSources() {
    root.append(el('h1', 'page-title', 'Quellen und Kataloge'))
    const actions = el('div', 'action-row')
    actions.append(button('← Zurück', back, { focus: 'back' }),
      button('Quelle hinzufügen', () => navigate({ name: 'add-source' }), { focus: 'add-source', className: 'action primary' }))
    root.append(actions)
    const list = el('section', 'source-list')
    for (const source of store.sources()) {
      const item = el('article', 'source-row')
      item.append(el('h2', '', source.name), el('p', 'caption', new URL(source.origin).hostname),
        button('Entfernen', async () => {
          try { await store.removeCatalog(source.id); await account.exchange(); show() }
          catch (error) { root.append(status(errorText(error, 'Die Quelle konnte nicht entfernt werden.'))) }
        }, { focus: 'remove:' + source.id }))
      list.append(item)
    }
    if (!list.children.length) list.append(el('p', '', 'Dein Konto hat noch keinen Katalog.'))
    root.append(list)
    focusKey(route.focus, actions.querySelector('[data-focus="add-source"]'))
  }

  function renderAddSource() {
    root.append(el('h1', 'page-title', 'Quelle hinzufügen'))
    root.append(button('← Zurück', back, { focus: 'back' }))
    const form = el('form', 'source-form')
    const field = el('textarea')
    field.placeholder = 'HTTPS-Videolink, Katalogadresse oder KinoTix-Katalogdatei als JSON'
    field.setAttribute('aria-label', 'Video- oder Katalogquelle')
    field.dataset.focus = 'source-address'
    field.rows = 4
    const report = status('', 'status')
    const submit = button('Quelle übernehmen', () => {}, { focus: 'source-submit', className: 'action primary' })
    submit.type = 'submit'
    form.append(field, submit, report)
    form.addEventListener('submit', async event => {
      event.preventDefault()
      if (submit.disabled) return
      submit.disabled = true
      report.textContent = 'Quelle wird geprüft …'
      try {
        const text = field.value.trim()
        if (text.startsWith('{')) await store.addCatalog(JSON.parse(text))
        else {
          const url = KinoFormats.https(text)
          if (/\.(?:mp4|m4v|webm|mov|ogv|m3u8)$/i.test(url.pathname)) await store.addMedia(url.href)
          else {
            const body = await KinoTransport.text(url.href, { allowedHosts: [url.hostname], maxBytes: 65536 })
            await store.addCatalog(JSON.parse(body))
          }
        }
        await account.exchange()
        navigate({ name: 'sources' }, { replace: true })
      } catch (error) {
        report.textContent = errorText(error, 'Die Quelle konnte nicht hinzugefügt werden.')
        submit.disabled = false
      }
    })
    root.append(form)
    focusElement(field)
  }

  async function renderDiagnostics(id) {
    root.append(el('h1', 'page-title', 'Netzwerkdiagnose'))
    const tools = el('div', 'action-row')
    const run = button('Erneut prüfen', show, { focus: 'recheck' })
    tools.append(button('← Zurück', back, { focus: 'back' }), run)
    const result = el('section')
    result.append(status('Verbindung wird geprüft …'))
    root.append(tools, result)
    focusKey(route.focus, run)
    try {
      let rows = [{ label: 'Internetstatus', value: navigator.onLine ? 'Online' : 'Offline' }]
      if (typeof window.KinoProvider?.diagnostics === 'function') {
        const extra = await window.KinoProvider.diagnostics()
        rows = rows.concat(Array.isArray(extra) ? extra : Object.keys(extra || {}).map(label => ({ label, value: extra[label] })))
      }
      if (id !== generation) return
      const display = el('dl', 'diag')
      rows.forEach(({ label, value }) => display.append(el('dt', '', String(label)), el('dd', '', String(value))))
      result.replaceChildren(display)
    } catch (error) {
      if (id !== generation) return
      result.replaceChildren(message('Verbindungsprüfung fehlgeschlagen', errorText(error, 'Der Fernseher konnte den Katalog nicht erreichen.')))
    }
  }

  function savePosition(session, finished = session.finished, allowStart = false) {
    const { video, title, episode } = session
    const duration = Number(video.duration)
    const seconds = Number(video.currentTime)
    if (!session.ready || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(seconds) || seconds < 1 && !finished && !allowStart) return
    const key = episodeKey(episode)
    let entry = historyFor(title)
    if (!entry) {
      entry = { title: storedTitle(title), positions: {}, updated: 0, hidden: false }
      library.views.push(entry)
    }
    entry.lastEpisode = key
    entry.updated = Math.max(Date.now(), entry.updated + 1)
    entry.hidden = false
    const position = { season: episode.season, episode: episode.episode, seconds, duration, finished, updatedAt: entry.updated }
    entry.positions[key] = position
    session.lastSave = seconds
    persist()
    const update = { title: entry.title, ...position }
    void store.recordProgress(update).then(() => account.exchange()).catch(() => {})
  }

  function releasePlayer() {
    if (!playing) return
    const session = playing
    playing = null
    activeEpisodeID = null
    savePosition(session)
    sync?.flush()
    clearTimeout(session.deadline)
    clearTimeout(session.controlsTimer)
    clearInterval(session.countdownId)
    if (document.fullscreenElement === session.panel) document.exitFullscreen().catch(() => {})
    session.video.pause()
    session.video.removeAttribute('src')
    session.video.load()
  }

  async function renderPlayer(id) {
    const { title, episode } = route
    const nextActiveID = KinoFormats.decodeTitle(title.url) ?
      await KinoFormats.episodeID(title.url, episode.season, episode.episode) : title.url
    if (id !== generation) return
    activeEpisodeID = nextActiveID
    const panel = el('section', 'player')
    panel.tabIndex = -1
    const heading = title.title + (title.isSeries ? '  ·  Staffel ' + episode.season + ' Folge ' + episode.episode : '')
    const video = el('video')
    video.preload = 'metadata'
    video.playsInline = true
    video.setAttribute('aria-label', 'Videowiedergabe')
    const overlay = status('Quelle wird geladen …', 'overlay status')
    const countdown = el('aside', 'countdown')
    countdown.hidden = true
    const titleBar = el('header', 'player-title')
    titleBar.append(el('h1', '', heading))
    const position = el('div', 'progress-track')
    const fill = el('span')
    position.append(fill)
    const clock = el('div', 'time')
    const elapsed = el('span', '', '0:00')
    const remaining = el('span', '', '–:––')
    clock.append(elapsed, remaining)
    const meter = el('div')
    meter.append(position, clock)
    const controls = el('div', 'player-controls')
    const tools = el('div', 'action-row')
    const play = button('Pause', togglePlayback, { className: 'action primary', focus: 'pause' })
    const qualityButton = button('Qualität: Auto', toggleQuality, { focus: 'quality' })
    qualityButton.hidden = true
    const sleepMenu = el('div', 'quality-menu')
    sleepMenu.hidden = true
    const sleep = button('Schlaftimer', () => {
      sleepMenu.hidden = !sleepMenu.hidden
      showControls()
      if (!sleepMenu.hidden) focusElement(sleepMenu.querySelector('button'))
    }, { focus: 'sleep' })
    for (const minutes of [0,15,30,45,60,90,-1]) {
      sleepMenu.append(button(minutes === 0 ? 'Aus' : minutes === -1 ? 'Nach dieser Folge' : minutes + ' Minuten', () => {
        sleepDeadline = minutes > 0 ? Date.now() + minutes * 60000 : 0
        sleepAfterEpisode = minutes === -1
        sleep.textContent = minutes === 0 ? 'Schlaftimer' : minutes === -1 ? 'Timer · Folgenende' : 'Timer · ' + minutes + ' Min.'
        sleepMenu.hidden = true
        focusElement(sleep)
        scheduleHide()
      }, { focus: 'sleep:' + minutes }))
    }
    const availableEpisodes = sortedEpisodes(title)
    const nextIndex = availableEpisodes.findIndex(item => episodeKey(item) === episodeKey(episode)) + 1
    const following = title.isSeries && nextIndex > 0 ? availableEpisodes[nextIndex] : null
    const skip = button('Intro überspringen', () => {
      if (session.undo && Date.now() < session.undo.until) {
        seekTo(session.undo.position)
        session.undo = null
        updateSkip()
      } else if (session.activeMarker) {
        session.undo = { position: video.currentTime, until: Date.now() + 7000 }
        session.usedMarkers.add(session.activeMarker.key)
        seekTo(session.activeMarker.range[1])
        session.activeMarker = null
        updateSkip()
      }
    }, { focus: 'skip', className: 'action primary' })
    skip.hidden = true
    const quality = el('div', 'quality-menu')
    quality.hidden = true
    tools.append(button('← Zurück', back, { focus: 'back' }), play,
      button('−10 s', () => seekBy(-10), { focus: 'rewind' }),
      button('+10 s', () => seekBy(10), { focus: 'ahead' }),
      qualityButton, skip, sleep)
    if (following) tools.append(button('Nächste Folge', () => navigate({
      name: 'player', title, episode: following
    }, { replace: true }), { focus: 'next-episode' }))
    if (typeof panel.requestFullscreen === 'function') {
      tools.append(button('Vollbild', () => {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
        else panel.requestFullscreen().catch(() => {})
      }, { focus: 'fullscreen' }))
    }
    controls.append(meter, tools, quality, sleepMenu)
    panel.append(video, titleBar, controls, overlay, countdown)
    root.append(panel)
    focusElement(play)

    const session = playing = {
      video, panel, title, episode, variants: [], tried: [], selected: null, manual: false, ready: false, finished: false,
      lastSave: -5, position: 0, deadline: null, countdownId: null, controlsTimer: null, playing: false,
      showControls, handleMediaKey, setPlayback, seekTo,
      markers: {}, usedMarkers: new Set(), activeMarker: null, undo: null,
    }
    panel.addEventListener('pointerdown', () => showControls())
    panel.addEventListener('pointermove', () => showControls())
    panel.addEventListener('fullscreenchange', () => showControls())
    const saved = lastViewed(title, episode)
    session.position = route.position ?? (saved && !saved.finished ? saved.seconds : 0)
    session.playing = true
    video.addEventListener('loadedmetadata', () => {
      if (playing !== session) return
      clearTimeout(session.deadline)
      if (session.position > 0 && Number.isFinite(video.duration)) {
        video.currentTime = Math.min(session.position, Math.max(0, video.duration - .25))
      }
      session.ready = true
      Array.from(video.textTracks || []).forEach(track => { track.mode = 'disabled' })
      const german = Array.from(video.audioTracks || []).find(track => /^(de|ger|deu)(-|$)/i.test(track.language || ''))
      if (german) Array.from(video.audioTracks).forEach(track => { track.enabled = track === german })
      if (session.playing) void video.play().catch(() => {
        if (playing !== session) return
        overlay.hidden = false
        overlay.textContent = 'Drücke Abspielen, um zu starten.'
        play.textContent = '▶ Abspielen'
        showControls()
      })
    })
    video.addEventListener('timeupdate', () => {
      if (playing !== session) return
      elapsed.textContent = timeLabel(video.currentTime)
      if (Number.isFinite(video.duration)) {
        remaining.textContent = timeLabel(video.duration)
        fill.style.width = Math.min(100, Math.max(0, video.currentTime / video.duration * 100)) + '%'
      }
      updateSkip()
      if (sleepDeadline && Date.now() >= sleepDeadline) {
        sleepDeadline = 0
        session.playing = false
        video.pause()
        showControls()
      }
      if (Math.abs(video.currentTime - session.lastSave) >= 5) savePosition(session)
    })
    video.addEventListener('playing', () => {
      if (playing !== session) return
      clearTimeout(session.deadline)
      overlay.hidden = true
      play.textContent = 'Pause'
      scheduleHide()
      sync?.flush()
    })
    video.addEventListener('pause', () => {
      if (playing !== session) return
      clearTimeout(session.deadline)
      play.textContent = '▶ Abspielen'
      savePosition(session)
      showControls()
      sync?.flush()
    })
    video.addEventListener('waiting', () => {
      if (playing !== session || !session.playing) return
      overlay.hidden = false
      overlay.textContent = 'Wird geladen …'
      if (session.manual || !session.ready) return
      clearTimeout(session.deadline)
      session.deadline = setTimeout(lowerQuality, 9500)
    })
    video.addEventListener('error', () => {
      if (playing === session && session.selected) useFallback()
    })
    video.addEventListener('ended', () => {
      if (playing !== session) return
      session.finished = true
      session.playing = false
      play.textContent = '↻ Erneut abspielen'
      showControls()
      savePosition(session, true)
      sync?.flush()
      const episodes = sortedEpisodes(title)
      const index = episodes.findIndex(value => episodeKey(value) === episodeKey(episode))
      const next = title.isSeries && episodes[index + 1]
      if (sleepAfterEpisode) { sleepAfterEpisode = false; return }
      if (next && preferences.autoNext) nextEpisode(next)
    })

    function requestMarkers() {
      if (typeof KinoProvider.markers !== 'function') return
      void KinoProvider.markers(title, episode).then(markers => {
        if (playing === session) { session.markers = markers; updateSkip() }
      }).catch(() => {})
    }

    function updateSkip() {
      if (playing !== session || !session.ready) return
      const now = video.currentTime
      const duration = video.duration
      const labels = { intro: 'Intro überspringen', recap: 'Rückblick überspringen', outro: 'Abspann überspringen' }
      if (session.undo && Date.now() < session.undo.until) {
        skip.textContent = 'Sprung rückgängig'
        skip.hidden = false
        return
      }
      session.undo = null
      session.activeMarker = null
      for (const name of ['recap','intro','outro']) {
        const range = session.markers[name]
        if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite) ||
            range[0] < 0 || range[1] <= range[0] || !Number.isFinite(duration) || range[1] > duration + 2 ||
            name === 'outro' && range[0] < duration / 2) continue
        const post = session.markers.post_credits
        let parts = [range]
        if (name === 'outro' && Array.isArray(post) && post.length === 2 && post.every(Number.isFinite) &&
            post[0] >= 0 && post[1] > post[0] && post[0] < range[1] && post[1] > range[0]) {
          parts = [[range[0], Math.min(range[1], post[0])], [Math.max(range[0], post[1]), range[1]]]
        }
        const segment = parts.find(part => part[1] > part[0] && now >= part[0] && now < part[1] &&
          !session.usedMarkers.has(name + ':' + part[0]))
        if (!segment) continue
        const key = name + ':' + segment[0]
        const end = segment[1]
        session.activeMarker = { name, key, range: segment }
        if (preferences.autoSkip && name !== 'recap' && !video.paused) {
          session.usedMarkers.add(key)
          session.undo = { position: now, until: Date.now() + 7000 }
          seekTo(end)
          showControls()
          skip.textContent = 'Sprung rückgängig'
        } else skip.textContent = labels[name]
        skip.hidden = false
        return
      }
      if (document.activeElement === skip) focusElement(play)
      skip.hidden = true
    }

    try {
      const received = await window.KinoProvider.sources(episode)
      if (id !== generation || playing !== session) return
      session.variants = (Array.isArray(received) ? received : []).map(item => ({ url: safeURL(item.url), height: Number(item.height) || 0 }))
        .filter(item => item.url)
        .sort((a, b) => b.height - a.height)
      if (!session.variants.length) throw new Error('Für diese Auswahl ist gerade keine abspielbare Quelle verfügbar.')
      qualityButton.hidden = session.variants.length < 2
      buildQuality()
      const downlink = Number(navigator.connection?.downlink)
      const target = navigator.connection?.saveData ? 480 : !downlink || downlink >= 25 ? Infinity : downlink >= 10 ? 1080 : downlink >= 5 ? 720 : 480
      load(session.variants.find(variant => variant.height <= target) || session.variants[session.variants.length - 1], session.playing)
      requestMarkers()
    } catch (error) {
      if (id !== generation || playing !== session) return
      showPlaybackError(errorText(error, 'Die Videoquelle ist nicht verfügbar.'))
    }

    function load(variant, shouldPlay) {
      clearTimeout(session.deadline)
      if (session.ready) session.position = video.currentTime
      session.ready = false
      session.selected = variant
      session.playing = shouldPlay
      session.tried.push(variant.url)
      overlay.hidden = false
      overlay.textContent = 'Quelle wird geladen …'
      showControls()
      qualityButton.textContent = session.manual ? 'Qualität: ' + variant.height + 'p' : 'Qualität: Auto'
      video.src = variant.url
      video.load()
      session.deadline = setTimeout(useFallback, 18000)
    }

    function useFallback() {
      if (playing !== session) return
      const candidate = session.variants.find(variant => !session.tried.includes(variant.url))
      if (candidate) {
        session.manual = false
        load(candidate, session.playing)
      } else showPlaybackError('Die verfügbaren Quellen konnten nicht abgespielt werden.')
    }

    function lowerQuality() {
      if (playing !== session) return
      const candidate = session.variants.find(variant => variant.height < session.selected.height && !session.tried.includes(variant.url))
      if (candidate) load(candidate, true)
    }

    function showPlaybackError(text) {
      clearTimeout(session.deadline)
      session.ready = false
      session.playing = false
      play.disabled = true
      overlay.hidden = false
      overlay.replaceChildren(el('p', '', text), button('Erneut versuchen', showPlayer, { className: 'action primary', focus: 'retry' }))
      showControls()
      focusElement(overlay.querySelector('button'))
    }

    function showPlayer() {
      navigate({ name: 'player', title, episode }, { replace: true })
    }

    function scheduleHide() {
      clearTimeout(session.controlsTimer)
      if (playing !== session || video.paused || !quality.hidden || !sleepMenu.hidden || !countdown.hidden) return
      session.controlsTimer = setTimeout(() => {
        if (playing !== session || video.paused) return
        if (controls.contains(document.activeElement)) panel.focus({ preventScroll: true })
        titleBar.hidden = true
        controls.hidden = true
      }, playerControlsTimeout)
    }

    function showControls() {
      if (playing !== session) return false
      const wasHidden = controls.hidden
      titleBar.hidden = false
      controls.hidden = false
      if (wasHidden && !play.disabled) focusElement(play)
      scheduleHide()
      return wasHidden
    }

    function handleMediaKey(key) {
      if (key === 'MediaStop') {
        back()
        return
      }
      showControls()
      if (key === 'MediaPlayPause' || key === 'MediaPlay' && video.paused) togglePlayback()
      else if (key === 'MediaPause' && !video.paused) togglePlayback()
      else if (key === 'MediaRewind' || key === 'MediaFastForward') seekBy(key === 'MediaRewind' ? -10 : 10)
    }

    function togglePlayback() {
      if (!session.selected) return
      setPlayback(video.paused)
    }

    function setPlayback(shouldPlay) {
      session.playing = shouldPlay
      if (!session.ready) return
      if (shouldPlay) {
        if (session.finished) {
          clearInterval(session.countdownId)
          countdown.hidden = true
          session.finished = false
          video.currentTime = 0
        }
        void video.play().catch(() => {})
      } else {
        video.pause()
      }
    }

    function seekBy(offset) {
      if (!session.ready || !Number.isFinite(video.duration)) return
      seekTo(video.currentTime + offset)
    }

    function seekTo(seconds) {
      session.position = Math.max(0, seconds)
      if (!session.ready || !Number.isFinite(video.duration)) return
      video.currentTime = Math.min(Math.max(0, video.duration - .25), session.position)
      savePosition(session, false, true)
      sync?.flush()
    }

    function toggleQuality() {
      quality.hidden = !quality.hidden
      focusElement(quality.hidden ? qualityButton : quality.querySelector('button'))
      scheduleHide()
    }

    function buildQuality() {
      quality.append(button('Automatisch', () => {
        session.manual = false
        quality.hidden = true
        qualityButton.textContent = 'Qualität: Auto'
        focusElement(qualityButton)
        scheduleHide()
      }))
      session.variants.forEach(variant => {
        quality.append(button(variant.height ? variant.height + 'p' : 'Original', () => {
          session.manual = true
          session.tried = []
          quality.hidden = true
          if (session.selected?.url !== variant.url) load(variant, session.playing)
          else qualityButton.textContent = 'Qualität: ' + variant.height + 'p'
          focusElement(qualityButton)
          scheduleHide()
        }))
      })
    }

    function nextEpisode(next) {
      let seconds = 8
      const heading = el('h2', '')
      const tick = () => { heading.textContent = 'Nächste Folge in ' + seconds + ' s' }
      const open = () => navigate({ name: 'player', title, episode: next }, { replace: true })
      const actions = el('div', 'action-row')
      actions.append(button('Jetzt abspielen', open, { className: 'action primary', focus: 'play-next' }),
        button('Abbrechen', () => {
          clearInterval(session.countdownId)
          countdown.hidden = true
          focusElement(play)
        }, { focus: 'cancel-next' }))
      countdown.replaceChildren(heading, actions)
      countdown.hidden = false
      tick()
      focusElement(actions.querySelector('button'))
      session.countdownId = setInterval(() => {
        seconds--
        if (seconds <= 0) open()
        else tick()
      }, 1000)
    }
  }

  function focusDirectional(direction, includeOffscreen) {
    const directionVector = arrows[direction]
    const active = document.activeElement
    const candidates = Array.from(document.querySelectorAll('button:not([disabled]), input')).filter(node => {
      return node !== active && node.getClientRects().length && !node.closest('[hidden]')
        && (!document.fullscreenElement || document.fullscreenElement.contains(node))
    })
    if (!active || active === document.body) {
      focusElement(candidates[0])
      return
    }
    const current = active.getBoundingClientRect()
    const x = current.x + current.width / 2
    const y = current.y + current.height / 2
    const score = candidates.map(node => {
      const box = node.getBoundingClientRect()
      if (!includeOffscreen && (box.bottom < 0 || box.top > window.innerHeight)) return null
      const dx = box.x + box.width / 2 - x
      const dy = box.y + box.height / 2 - y
      const primary = dx * directionVector[0] + dy * directionVector[1]
      const offset = Math.abs(dx * directionVector[1] + dy * directionVector[0])
      return primary > 5 ? { node, rank: primary + offset * 2.85 } : null
    }).filter(Boolean).sort((a, b) => a.rank - b.rank)
    if (score.length) focusElement(score[0].node)
    else if (!includeOffscreen) focusDirectional(direction, true)
  }

  document.addEventListener('keydown', event => {
    const key = keyNames[event.keyCode] || event.key
    const session = playing
    if (session && (key === 'Enter' || arrows[key])) {
      if (key === 'Enter' && event.repeat) {
        event.preventDefault()
        return
      }
      if (session.showControls()) {
        event.preventDefault()
        return
      }
    }
    if (arrows[key]) {
      if (event.target.tagName === 'INPUT' && (key === 'ArrowLeft' || key === 'ArrowRight')) return
      event.preventDefault()
      focusDirectional(key, false)
      return
    }
    if (['Escape', 'Back', 'GoBack', 'BrowserBack'].includes(key)) {
      if (route.name === 'home' && !document.fullscreenElement) return
      event.preventDefault()
      back()
      return
    }
    if (key === 'Enter' && event.target.tagName === 'BUTTON' && !event.repeat) {
      event.preventDefault()
      event.target.click()
      return
    }
    if (!session || !session.selected) return
    if (['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaRewind', 'MediaFastForward'].includes(key)) {
      event.preventDefault()
      if (!event.repeat || key === 'MediaRewind' || key === 'MediaFastForward') session.handleMediaKey(key)
    }
  })
  document.getElementById('chrome').addEventListener('click', event => {
    const target = event.target.closest('[data-action]')
    if (target) navigate({ name: target.dataset.action }, { reset: true })
  })
  window.addEventListener('pagehide', () => { if (playing) savePosition(playing) })
  document.addEventListener('visibilitychange', () => { if (document.hidden && playing) savePosition(playing) })
  store = KinoLibrary.create({
    getActive: () => activeEpisodeID,
    onChange: () => {
      library = store.view()
      catalog = null
      searchResults = null
      if (!bindingAccount && route.name !== 'player' && route.name !== 'detail' && route.name !== 'sync') show()
    }
  })
  library = store.view()
  account = KinoAccount.create({
    async onAccount(owner) {
      bindingAccount = true
      try {
        if (playing) releasePlayer()
        clearPosters()
        await store.setAccount(owner)
        library = store.view()
        catalog = null
        searchResults = null
        if (route.name !== 'sync') { route = { name: 'home' }; stack = []; show() }
      } finally { bindingAccount = false }
    },
    onRows: rows => store.applyRows(rows),
    getPending: () => store.pending(),
    acknowledge: rows => store.acknowledge(rows),
    onChange(state) {
      if (refreshSyncSettings) refreshSyncSettings()
      else syncState = state
    }
  })
  sync = { flush: () => account.exchange() }
  accountPoll = setInterval(() => {
    if (!document.hidden && account.status().qrUrl) {
      void account.pollSignIn().catch(error => {
        if (route.name === 'sync') root.append(status(errorText(error, 'Anmeldung gerade nicht erreichbar.')))
      })
    }
  }, 2500)
  window.addEventListener('pagehide', () => { clearInterval(accountPoll); account.close?.() })
  registerRemote()
  show()
  void store.setAccount(null).then(() => account.start()).catch(error => {
    syncState = account.status()
    if (route.name === 'sync') root.append(status(errorText(error, 'Das Konto konnte nicht geöffnet werden.')))
  })
})()
