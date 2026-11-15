const { request, status, platform } = window.kino
document.documentElement.dataset.platform = platform
const main = document.querySelector('#main')
const query = document.querySelector('#query')
const linkDialog = document.querySelector('#link-dialog')
let viewId = 0
let page = 1
let homeItems = []
let history = []
let library
let updateView
let syncView
let detail
let active
let observePlayer
let returnTo = () => showHome()

function make(tag, text, classes) {
  const node = document.createElement(tag)
  if (text) node.textContent = text
  if (classes) node.className = classes
  return node
}
function action(text, handler, classes) {
  const node = make('button', text, classes)
  node.type = 'button'
  node.addEventListener('click', () => Promise.resolve(handler()).catch(error => {
    const message = make('p', cleanError(error), 'inline-error')
    message.setAttribute('role','alert')
    node.after(message)
  }))
  return node
}
function art(item) {
  const container = make('span', '', 'card-art')
  if (!item.poster) {
    container.textContent = '▶'
    return container
  }
  const image = make('img')
  image.alt = ''
  image.loading = 'lazy'
  image.referrerPolicy = 'no-referrer'
  image.src = item.poster
  image.addEventListener('error', () => { container.textContent = '▶' }, { once:true })
  container.append(image)
  return container
}
function group(title, items, callback, isHistory = false) {
  const section = make('section')
  const heading = make('h2', title, 'section-title')
  const grid = make('div', '', isHistory ? 'cards history' : 'cards')
  for (const item of items) {
    const card = action('', () => callback(item), 'card')
    const label = make('span', item.title, 'card-title')
    if (!isHistory && (item.fresh || item.year || item.language || item.isSeries != null)) {
      const info = [item.isSeries == null ? '' : item.isSeries ? 'Serie' : 'Film', item.year && !item.title.includes(String(item.year)) ? item.year : '', item.language].filter(Boolean)
      const labelText = item.fresh ? 'Neue Folge · S'+item.fresh.season+' F'+item.fresh.episode : info.join(' · ')
      if (labelText) label.append(make('span',labelText,'caption'))
    }
    if (isHistory) {
      const [s,e] = item.last.split(':')
      const previous = item.episodes[item.last]
      label.append(make('span', item.isSeries ? 'Staffel ' + s + ' · Folge ' + e + (previous.finished ? ' gesehen' : '') : previous.finished ? 'Gesehen' : formatTime(previous.time), 'caption'))
    }
    card.append(art(item), label)
    if (isHistory) {
      const shell = make('div','','history-card')
      const remove = action('×', async () => { await request('hide',{url:item.url}); await showHome(page) },'history-remove')
      remove.setAttribute('aria-label','Aus Weiterschauen entfernen – '+item.title)
      shell.append(card,remove)
      grid.append(shell)
    } else grid.append(card)
  }
  section.append(heading, grid)
  return section
}
function notice(title, description, retry) {
  const block = make('div', '', 'notice')
  block.append(make('h2', title), make('p', description))
  if (retry) {
    const actions = make('div', '', 'actions')
    actions.append(action('Erneut versuchen', retry))
    block.append(actions)
  }
  return block
}
async function refreshLibrary() {
  library = await request('library')
  history = library.history
  document.querySelector('#profile').textContent = library.profile.name
  return library
}
function reset() {
  viewId += 1
  observePlayer?.disconnect()
  observePlayer = null
  if (active) {
    active = null
    void request('close')
  }
  main.className = ''
  main.replaceChildren()
  main.scrollTop = 0
  return viewId
}
async function showHome(newPage = 1, refresh = false) {
  const id = reset()
  returnTo = () => showHome()
  if (newPage !== page || refresh) homeItems = []
  page = newPage
  await refreshLibrary()
  if (id !== viewId) return
  const watched = history.filter(item => !item.hidden)
  if (watched.length) main.append(group('Weiterschauen', watched.slice(0,36), item => openTitle(item, true), true))
  const fresh = [...new Map(library.lists.flatMap(list => Object.values(list.items).filter(item => item.fresh).map(item => [item.url,item]))).values()]
  if (fresh.length) main.append(group('Neue Folgen',fresh,item => openTitle(item)))
  const catalog = make('section','','home-catalog')
  main.append(catalog)
  const add = items => {
    if (!items.length) {
      catalog.replaceChildren(notice('Deine Medienbibliothek ist leer', 'Füge eine Videodatei oder einen direkten HTTPS-Videolink hinzu.'))
      return
    }
    catalog.replaceChildren(group('Deine Medien',items,item=>openTitle(item)))
  }
  catalog.append(notice('Bibliothek wird geladen', 'Deine Medien werden geöffnet.'))
  try {
    const items = await request('home', { page })
    if (id !== viewId) return
    homeItems = items
    add(items)
  } catch (e) {
    if (id === viewId) catalog.replaceChildren(notice('Katalog vorübergehend nicht erreichbar', cleanError(e), () => showHome(page, true)))
  }
  const sources=await request('catalog-home').catch(()=>[])
  if (id!==viewId) return
  for (const source of sources) {
    if (source.items.length) main.append(group(source.name,source.items,item=>openTitle(item)))
    else if (source.issue) main.append(notice(source.name,source.issue,()=>showHome(page,true)))
  }
}
function cleanError(error) { return (error?.message || 'Unbekannter Fehler.').replace(/^Error invoking remote method '[^']+': Error: /, '') }
function searchable(value) { return value.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '') }
function selectInput(label, options) {
  const select = make('select')
  select.setAttribute('aria-label',label)
  for (const [value,text] of options) {
    const option = make('option',text)
    option.value = value
    select.append(option)
  }
  return select
}
async function showSearch(value) {
  const id = reset()
  returnTo = () => showSearch(value)
  const results = make('section')
  main.append(results)
  try {
    const entries = await request('search', {query:value})
    if (id !== viewId) return
    results.replaceChildren(entries.length ? group(value ? 'Ergebnisse für „'+value+'“' : 'Suchergebnisse',entries,item => openTitle(item))
      : notice('Keine Treffer', 'Suche nach einem Titel in deiner Medienbibliothek.'))
  } catch (e) {
    if (id === viewId) results.replaceChildren(notice('Suche fehlgeschlagen',cleanError(e),()=>showSearch(value)))
  }
}
const settings = document.querySelector('#settings-dialog')
function dialog(title, ...content) {
  if (title !== 'Einstellungen') updateView = undefined
  syncView = undefined
  const body = document.querySelector('#settings-content')
  const row = make('div','','dialog-header')
  row.append(make('h2',title),action('Schließen',() => settings.close()))
  body.replaceChildren(row,...content)
  if (!settings.open) settings.showModal()
}
function namedForm(label, buttonText, submit) {
  const form = make('form','','named-form')
  const field = make('input')
  field.placeholder = label
  field.setAttribute('aria-label',label)
  field.required = true
  const button = make('button',buttonText,'primary')
  button.type='submit'
  form.addEventListener('submit',event => {
    event.preventDefault()
    Promise.resolve(submit(field.value.trim())).catch(error => {
      form.querySelector('.inline-error')?.remove()
      form.append(make('p',cleanError(error),'inline-error'))
    })
  })
  form.append(field,button)
  return form
}
async function showAppSettings() {
  const report=make('p')
  report.setAttribute('role','status')
  updateView = state => {
    const messages={unconfigured:'Dieser Build hat keine Update-Quelle.',idle:'Sucht beim Start automatisch nach Updates.',
      checking:'Updates werden geprüft …',current:'KinoTix ist aktuell.',downloading:'Update wird geladen · '+(state.percent??0)+' %',
      ready:'Update ist bereit. Es wird beim Beenden installiert.',error:'Das Update konnte gerade nicht geladen werden.'}
    report.textContent='Version '+state.current+' · '+messages[state.phase]
  }
  dialog('Einstellungen',action('Google-Konto',showAccount),action('Kataloge',showCatalogs),make('h3','Software-Updates'),report,
    action('Nach Updates suchen',async()=>updateView?.(await request('updates-check'))))
  updateView(await request('updates-state'))
}
async function showCatalogs() {
  const state=await request('catalog-state')
  const view=make('div','','stack')
  for (const source of state.sources) {
    const row=make('div','','actions')
    row.append(make('strong',source.name),make('span',new URL(source.origin).hostname),
      action('Entfernen',()=>{
        dialog('Katalog entfernen',make('p',source.name+' aus deiner Quellenliste entfernen?'),
          action('Entfernen',async()=>{await request('catalog-remove',{id:source.id});settings.close();await showHome()}),
          action('Zurück',showCatalogs))
      }))
    view.append(row)
  }
  if (state.available) view.append(action('Lokale Kataloge ins Konto übernehmen',async()=>{
    await request('catalog-copy-local')
    settings.close()
    await showHome()
  }))
  view.append(action('Katalogdatei importieren',async()=>{
    if (await request('catalog-import')) { settings.close();await showHome() }
  },'primary'))
  dialog('Kataloge',make('p','Eine Katalogdatei verbindet KinoTix mit einer von dir gewählten Medienquelle.'),view)
}

async function showAccount() {
  const view=make('div','','stack')
  function render(state) {
    view.querySelector('.account-content')?.remove()
    const content=make('div','','account-content stack')
    view.prepend(content)
    if (state.connected) {
      content.append(make('p','Angemeldet als '+state.email),
        make('p',state.issue || (state.lastSync?'Kataloge und Fortschritt sind synchronisiert.':'Kataloge und Fortschritt werden synchronisiert …')),
        make('p','Der Fortschritt von „Mein Profil“ wird synchronisiert. Weitere Profile bleiben auf diesem Gerät.'),
        action('Jetzt synchronisieren',async()=>render(await request('sync-refresh'))),
        action('Abmelden',async()=>{await request('sync-sign-out');settings.close();await showHome()}))
    } else {
      content.append(make('p','Ohne Konto bleiben Kataloge, Merkliste und Verlauf auf diesem Gerät. Mit Google kannst du Kataloge und Wiedergabestand zwischen Windows und Mac synchronisieren.'))
      if (state.issue) content.append(make('p',state.issue,'inline-error'))
      if (!state.configured) content.append(make('p','Die Google-Anmeldung ist für diesen Build noch nicht eingerichtet.'))
      else if (state.signingIn) content.append(make('p','Schließe die Anmeldung im Browser ab.'))
      else content.append(action('Mit Google anmelden',async()=>{
        const next=await request('sync-sign-in')
        if (next.connected) { settings.close(); await showHome() }
      },'primary'))
    }
  }
  dialog('Google-Konto',view)
  syncView=render
  render(await request('sync-state'))
}

async function showProfiles() {
  await refreshLibrary()
  const body = make('div','','stack')
  for (const profile of library.profiles) body.append(action(profile.name + (profile.id === library.profile.id ? ' · aktiv' : ''),async () => {
    await request('profile-select',{id:profile.id})
    settings.close()
    await showHome()
  }))
  body.append(namedForm('Profilname','Profil anlegen',async name => {
    await request('profile-new',{name})
    settings.close()
    await showHome()
  }))
  dialog('Profile',body)
}
async function chooseLists(title) {
  await refreshLibrary()
  const body = make('div','','stack')
  for (const list of library.lists) {
    body.append(action((list.items[title.url] ? '✓ Aus Liste entfernen: ' : '+ Zu Liste hinzufügen: ')+list.name,async () => {
      await request('list-toggle',{list:list.id,url:title.url})
      await chooseLists(title)
    }))
  }
  body.append(namedForm('Listenname','Liste anlegen',async name => {
    const result=await request('list-add',{name})
    await request('list-toggle',{list:result.lists.at(-1).id,url:title.url})
    await chooseLists(title)
  }))
  dialog('In einer Liste merken',body)
}
async function showLists(selected = 'default') {
  const id = reset()
  returnTo = () => showLists(selected)
  await refreshLibrary()
  if (id !== viewId) return
  const list = library.lists.find(entry => entry.id === selected) ?? library.lists[0]
  const switcher = selectInput('Liste',library.lists.map(({id,name})=>[id,name]))
  switcher.value = list.id
  switcher.addEventListener('change', () => void showLists(switcher.value))
  const tools=make('div','','actions filter-row')
  const items=Object.values(list.items)
  const unwatched=items.filter(item => !library.history.some(entry => entry.url===item.url && Object.values(entry.episodes).some(ep => ep.finished)))
  const random=action('Überrasch mich',() => {
    const genre = make('input')
    genre.placeholder='Genre (optional)'
    genre.setAttribute('aria-label','Genre für Zufallsauswahl')
    const maximum = make('input')
    maximum.type='number'
    maximum.min=1
    maximum.max=600
    maximum.placeholder='Max. Minuten (optional)'
    maximum.setAttribute('aria-label','Maximale Laufzeit')
    const pick=action('Titel ziehen',async () => {
      const term=genre.value.trim().toLowerCase()
      const limit=Number(maximum.value)
      const options=unwatched.filter(item => (!term || item.genres?.some(value=>value.toLowerCase().includes(term))) && (!limit || !item.isSeries && item.runtime && item.runtime<=limit))
      if (!options.length) throw Error('In dieser Liste passt kein ungesehener Titel zu den Filtern.')
      settings.close()
      await openTitle(options[Math.floor(Math.random()*options.length)])
    },'primary')
    dialog('Überrasch mich',genre,maximum,pick)
  },'primary')
  random.disabled = !unwatched.length
  const check=action('Nach neuen Folgen suchen',async () => {
    check.disabled=true
    check.textContent='Folgen werden geprüft …'
    await request('list-check')
    if (id===viewId) await showLists(list.id)
  })
  tools.append(switcher,random,check,action('Neue Liste',() => dialog('Neue Liste',namedForm('Listenname','Anlegen',async name => {
    const data=await request('list-add',{name})
    settings.close()
    await showLists(data.lists.at(-1).id)
  }))))
  main.append(tools,items.length ? group(list.name,items,item => openTitle(item)) : notice('Die Liste ist leer','Öffne einen Film oder eine Serie und wähle „Merken“.'))
}
async function openTitle(item, resume = false) {
  const id = reset()
  const goBack = returnTo
  main.append(action('← Zurück', goBack, 'detail-bar'), notice('Titel wird geladen', item.title || 'Verbindung zu KinoTix wird aufgebaut.'))
  try {
    const [data, records] = await Promise.all([request('title', {url:item.url}), request('history')])
    if (id !== viewId) return
    detail = data
    history = records
    void request('news-seen',{url:data.url}).catch(()=>{})
    const record = records.find(entry => entry.url === data.url)
    const previous = record && data.episodes.findIndex(ep => key(ep) === record.last)
    const index = Number.isInteger(previous) && previous >= 0 ?
      Math.min(previous + (record.episodes[record.last].finished ? 1 : 0), data.episodes.length-1) : 0
    const next = data.episodes[index]
    const hero = make('section', '', 'hero')
    const info = make('div')
    info.append(make('h1', data.title))
    if (data.description) info.append(make('p', data.description))
    const controls = make('div', '', 'actions')
    if (next) {
      const label = data.isSeries ? '▶ Staffel ' + next.season + ' · Folge ' + next.episode : '▶ Abspielen'
      controls.append(action(label, () => play(next), 'primary'))
    }
    controls.append(action('Merken',() => chooseLists(data)))
    const watchedFilm=record?.episodes[record.last]?.finished
    if (!data.isSeries && next) controls.append(action(watchedFilm ? 'Als ungesehen markieren' : 'Als gesehen markieren',async () => {
      await request('mark',{url:data.url,season:next.season,episode:next.episode,finished:!watchedFilm})
      await openTitle(data)
    }))
    info.append(controls)
    hero.append(art(data), info)
    main.replaceChildren(action('← Zurück', goBack, 'detail-bar'), hero)
    if (data.isSeries && next) main.append(episodeSection(data, record, next.season))
    if (!next) main.append(notice('Keine Quelle verfügbar', 'KinoTix hat für diesen Titel gerade keinen Player geliefert.'))
    if (resume && next) play(next)
  } catch (e) {
    if (id === viewId) main.replaceChildren(action('← Zurück', goBack, 'detail-bar'), notice('Titel konnte nicht geladen werden', cleanError(e), () => openTitle(item, resume)))
  }
}
function key(episode) { return episode.season + ':' + episode.episode }
function episodeSection(data, record, initialSeason) {
  const section = make('section')
  const heading = make('div', '', 'episode-header')
  const seasons = make('select')
  seasons.setAttribute('aria-label', 'Staffel')
  const list = make('div', '', 'episode-list')
  for (const number of new Set(data.episodes.map(ep => ep.season))) {
    const choice = make('option', 'Staffel ' + number)
    choice.value = number
    seasons.append(choice)
  }
  const update = () => {
    list.replaceChildren()
    for (const ep of data.episodes.filter(ep => ep.season === Number(seasons.value))) {
      const watched = record?.episodes[key(ep)]
      const title = 'Folge ' + ep.episode + (watched?.finished ? ' · Gesehen' : watched ? ' · ' + formatTime(watched.time) : '')
      const row = make('div','','episode-row')
      const mark = action(watched?.finished ? '↶' : '✓',async () => {
        await request('mark',{url:data.url,season:ep.season,episode:ep.episode,finished:!watched?.finished})
        await openTitle(data)
      })
      mark.setAttribute('aria-label',(watched?.finished ? 'Als ungesehen markieren' : 'Als gesehen markieren')+' – Folge '+ep.episode)
      row.append(action(title,()=>play(ep)),mark)
      list.append(row)
    }
  }
  heading.append(make('h2','Folgen'), seasons)
  section.append(heading, list)
  seasons.value = initialSeason
  seasons.addEventListener('change', update)
  update()
  return section
}
function formatTime(value) {
  const minutes = Math.floor(value / 60)
  const seconds = Math.floor(value % 60)
  return minutes + ':' + String(seconds).padStart(2,'0')
}
function bounds(node) {
  const b = node.getBoundingClientRect()
  return {x:b.x,y:b.y,width:b.width,height:b.height}
}
function runVideo(action,value) { return request('video',{action,value}) }
async function play(episode) {
  if (!active) reset()
  observePlayer?.disconnect()
  const context = active = {episode}
  main.className='player-page'
  const screen=make('div')
  screen.id='screen'
  const report=make('p','Video wird geladen …')
  report.setAttribute('role','status')
  screen.append(report)
  main.replaceChildren(screen)
  observePlayer=new ResizeObserver(()=>{
    if (active===context && !settings.open) void request('bounds',bounds(screen))
  })
  observePlayer.observe(screen)
  try {
    return await request('play',{url:detail.url,season:episode.season,episode:episode.episode,bounds:bounds(screen)})
  } catch (error) {
    if (active===context) report.textContent=cleanError(error)
    return false
  }
}
status(message => {
  if (message.type === 'updater') { if (settings.open) updateView?.(message); return }
  if (message.type === 'sync') { if(settings.open) syncView?.(message); return }
  if (message.type === 'library') { if (!active && document.querySelector('#main .home-catalog')) void showHome(page); return }
  if (active && message.type==='player-back') void openTitle(detail)
})
document.addEventListener('keydown', event => {
  if (!active || settings.open || linkDialog.open || event.altKey || event.metaKey || event.ctrlKey || /INPUT|SELECT|TEXTAREA|BUTTON/.test(event.target.tagName)) return
  const commands={' ':['toggle'],'ArrowLeft':['jump',-10],'ArrowRight':['jump',10],'ArrowUp':['volume',.1],'ArrowDown':['volume',-.1],'m':['mute'],'f':['fullscreen'],'p':['pip']}
  const command = commands[event.key]
  if (command) { event.preventDefault(); void runVideo(...command) }
})
document.querySelector('#app-settings').addEventListener('click',()=> {
  if (active) {
    const screen = document.querySelector('#screen')
    void request('bounds',{x:0,y:0,width:0,height:0})
    settings.addEventListener('close',()=> { if (active && screen?.isConnected) void request('bounds',bounds(screen)) },{once:true})
  }
  void showAppSettings().catch(error=>dialog('Einstellungen',make('p',cleanError(error))))
})
document.querySelector('#profile').addEventListener('click',() => { if (!active) void showProfiles() })
document.querySelector('#account').addEventListener('click',() => {
  if (active) {
    const screen=document.querySelector('#screen')
    void request('bounds',{x:0,y:0,width:0,height:0})
    settings.addEventListener('close',()=>{if(active && screen?.isConnected) void request('bounds',bounds(screen))},{once:true})
  }
  void showAccount().catch(error=>dialog('Google-Konto',make('p',cleanError(error))))
})
document.querySelector('#collections').addEventListener('click',() => void showLists())
document.querySelector('#home').addEventListener('click', () => showHome())
document.querySelector('#search').addEventListener('submit', event => {
  event.preventDefault()
  void showSearch(query.value.trim())
})
document.querySelector('#from-link').addEventListener('click', event => {
  event.preventDefault()
  if (active) { void request('close'); active = null; void showHome() }
  linkDialog.showModal()
  document.querySelector('#url').focus()
})
document.querySelector('#cancel-link').addEventListener('click', () => linkDialog.close())
const addForm=document.querySelector('#link-form')
async function addMedia(local) {
  const feedback=addForm.querySelector('[role=status]')
  try {
    const item=await request('media-add',{local,url:addForm.elements.url.value.trim(),
      title:addForm.elements.title.value,imdb:addForm.elements.imdb.value})
    if (item) { linkDialog.close(); addForm.reset(); return await openTitle(item) }
  } catch (error) { feedback.textContent=cleanError(error) }
}
addForm.addEventListener('submit',event=>{event.preventDefault(); void addMedia(false)})
document.querySelector('#file-open').addEventListener('click',()=>void addMedia(true))
document.querySelector('#catalog-open').addEventListener('click',()=>{
  linkDialog.close()
  void showCatalogs().catch(error=>dialog('Kataloge',make('p',cleanError(error))))
})
void showHome()
