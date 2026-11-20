const { request, status, platform } = window.kino
document.documentElement.dataset.platform = platform
const main = document.querySelector('#main')
const query = document.querySelector('#query')
const linkDialog = document.querySelector('#link-dialog')
let viewId = 0
let page = 1
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
function icon(name) {
  const namespace = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(namespace,'svg')
  const use = document.createElementNS(namespace,'use')
  svg.classList.add('icon')
  svg.setAttribute('aria-hidden','true')
  use.setAttribute('href','#icon-'+name)
  svg.append(use)
  return svg
}
function iconAction(name, text, handler, classes, showLabel = true) {
  const button = action(showLabel ? text : '',handler,classes)
  if (!showLabel) {
    button.setAttribute('aria-label',text)
    button.title = text
  }
  button.prepend(icon(name))
  return button
}
function imageFor(item, className = '', loading = 'lazy') {
  const image = make('img','',className)
  image.alt = ''
  image.loading = loading
  image.referrerPolicy = 'no-referrer'
  image.src = item.poster
  return image
}
function art(item) {
  const container = make('span', '', 'card-art')
  if (!item.poster) {
    container.append(icon('play'))
    return container
  }
  const image = imageFor(item)
  image.addEventListener('error', () => { container.replaceChildren(icon('play')) }, { once:true })
  container.append(image)
  return container
}
const lastEpisode = item => item?.last && item.episodes?.[item.last]
function progressFor(item) {
  const episode = lastEpisode(item)
  return episode && !episode.finished && episode.time > 0 && episode.time < episode.duration ? episode : null
}
function progressBar(episode, classes) {
  const rail = make('progress', '', classes)
  rail.max = episode.duration
  rail.value = episode.time
  rail.setAttribute('aria-label','Wiedergabefortschritt')
  return rail
}
function historyText(item) {
  const previous = lastEpisode(item)
  if (!previous) return ''
  const [season,episode] = item.last.split(':')
  if (item.isSeries) return 'Staffel ' + season + ' · Folge ' + episode
  return previous.finished ? 'Gesehen' : ''
}
function remaining(episode) {
  const minutes = Math.ceil((episode.duration - episode.time) / 60)
  if (minutes < 60) return 'Noch ' + minutes + ' Min.'
  const hours = Math.floor(minutes / 60)
  return 'Noch ' + hours + ' Std.' + (minutes % 60 ? ' ' + minutes % 60 + ' Min.' : '')
}
function heroArtwork(hero, item) {
  if (!item.poster) return
  const background = imageFor(item,'hero-media','eager')
  const poster = imageFor(item,'hero-poster','eager')
  hero.classList.add('has-art')
  background.addEventListener('error', () => {
    hero.classList.remove('has-art')
    background.remove()
    poster.remove()
  }, { once:true })
  hero.append(background,poster)
}
function feature(item, episode = null) {
  const hero = make('section','','hero')
  heroArtwork(hero,item)
  const body = make('div','','hero-content')
  if (episode) body.append(make('p','Weiterschauen','eyebrow'))
  body.append(make('h1',item.title,'hero-title'))
  const meta = episode ? historyText(item) : (item.isSeries ? 'Serie' : 'Film')
  if (meta) body.append(make('p',meta,'hero-meta'))
  if (episode) {
    const position = make('div','','progress-block')
    position.append(progressBar(episode),make('span',remaining(episode),'remain'))
    body.append(position)
  }
  const controls = make('div','','actions')
  if (episode) controls.append(
    iconAction('play','Fortsetzen',()=>openTitle(item,true),'primary'),
    action('Details',()=>openTitle(item)),
    iconAction('close','Aus Weiterschauen entfernen',async()=>{
      await request('hide',{url:item.url})
      await showHome(page)
    },'icon-button',false)
  )
  else controls.append(action('Details öffnen',()=>openTitle(item),'primary'))
  body.append(controls)
  hero.append(body)
  return hero
}
function emptyLibrary() {
  const hero = make('section','','hero')
  const body = make('div','','hero-content')
  body.append(make('h1','Deine Mediathek'),make('p','Füge eine Quelle per Webadresse oder Datei hinzu.','lead'))
  const controls = make('div','','actions')
  controls.append(iconAction('plus','Quelle hinzufügen',()=>openImport(),'primary'))
  body.append(controls)
  hero.append(body)
  return hero
}
function importShelf() {
  const section = make('section','','import-shelf')
  const grid = make('div','','import-cards')
  const choices = [
    ['link','Webadresse einfügen','Video oder KinoTix-Katalog',openImport],
    ['file','Datei auswählen','Video, Medienliste oder Katalogdatei',()=>{openImport();return chooseSourceFile()}],
  ]
  for (const [name,title,description,open] of choices) {
    const button = action('',open,'import-card')
    const symbol = make('span','','import-icon')
    symbol.append(icon(name))
    const label = make('span',title,'import-label')
    label.append(make('span',description))
    button.append(symbol,label,icon('chevron'))
    grid.append(button)
  }
  section.append(make('h2','Quellen hinzufügen','section-title'),grid)
  return section
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
      const position = progressFor(item)
      const caption = [historyText(item), position ? remaining(position) : ''].filter(Boolean).join(' · ')
      if (caption) label.append(make('span',caption,'caption'))
      if (position) label.append(progressBar(position,'history-progress'))
    }
    card.append(art(item), label)
    if (isHistory) {
      const shell = make('div','','history-card')
      const remove = iconAction('close','Aus Weiterschauen entfernen – '+item.title,
        async () => { await request('hide',{url:item.url}); await showHome(page) },'history-remove',false)
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
function catalogNotice(source,retry,titleRef) {
  const block=notice(source.name,source.issue,retry)
  const buttons=block.querySelector('.actions')
  if (source.issueCode==='browser-check') {
    buttons.append(action('Im Browser öffnen',()=>request('catalog-open-browser',{id:source.id,title:titleRef})))
  } else if (['dns','dns-blocked'].includes(source.issueCode)) {
    buttons.append(action('Verbindungseinstellungen',showNetworkSettings))
  } else buttons.append(action('Andere Quelle hinzufügen',openImport))
  return block
}
async function refreshLibrary() {
  library = await request('library')
  history = library.history
  const profile = document.querySelector('#profile')
  profile.querySelector('.profile-name').textContent = library.profile.name
  profile.querySelector('.profile-avatar').textContent = [...library.profile.name.trim()][0]?.toLocaleUpperCase('de-DE') || 'M'
  profile.setAttribute('aria-label','Profile · '+library.profile.name)
  return library
}
function reset(section = main.dataset.section || 'home') {
  viewId += 1
  observePlayer?.disconnect()
  observePlayer = null
  if (active) {
    active = null
    void request('close')
  }
  main.className = ''
  main.dataset.section = section
  for (const button of document.querySelectorAll('.main-nav [data-section]')) {
    if (button.dataset.section === section) button.setAttribute('aria-current','page')
    else button.removeAttribute('aria-current')
  }
  main.replaceChildren()
  main.scrollTop = 0
  return viewId
}
async function showHome(newPage = 1) {
  const id = reset('home')
  returnTo = () => showHome()
  page = newPage
  const remote = request('catalog-home').catch(()=>[])
  const own = request('home',{page}).then(items=>({items}),error=>({items:[],error}))
  const catalogState = request('catalog-state').catch(()=>({sources:[]}))
  await refreshLibrary()
  if (id !== viewId) return
  const watched = history.filter(item => !item.hidden && lastEpisode(item))
  const resume = watched.find(item => progressFor(item))
  if (resume) main.append(feature(resume,progressFor(resume)))
  const recent = watched.filter(item=>item!==resume)
  if (recent.length) main.append(group(resume ? 'Zuletzt angesehen' : 'Wiedergabeverlauf', recent.slice(0,36),
    item => openTitle(item, Boolean(progressFor(item))), true))
  const fresh = [...new Map(library.lists.flatMap(list => Object.values(list.items).filter(item => item.fresh).map(item => [item.url,item]))).values()]
  if (fresh.length) main.append(group('Neue Folgen',fresh,item => openTitle(item)))
  const catalog = make('section','','home-catalog')
  main.append(catalog)
  const [local,configured] = await Promise.all([own,catalogState])
  if (id!==viewId) return
  if (local.error) catalog.append(notice('Mediathek vorübergehend nicht erreichbar',cleanError(local.error),()=>showHome(page)))
  if (local.items.length) {
    if (!resume) main.prepend(feature(local.items[0]))
    catalog.append(group('Deine Medien',local.items,item=>openTitle(item)))
  }
  if (!resume && !local.items.length && !configured.sources.length && !local.error) {
    main.prepend(emptyLibrary())
    catalog.append(importShelf())
  }
  if (!configured.sources.length && configured.available) {
    catalog.prepend(action('Lokale Kataloge ins Konto übernehmen',copyDeviceCatalogs))
  }
  const loading = make('p','Kataloge werden geladen …','shelf-note')
  loading.setAttribute('role','status')
  if (configured.sources.length) catalog.append(loading)
  const sources = await remote
  if (id!==viewId) return
  loading.remove()
  const firstTitle = sources.find(source=>source.items.length)?.items[0]
  if (!resume && !local.items.length && firstTitle) main.prepend(feature(firstTitle))
  for (const source of sources) {
    if (source.items.length) main.append(group(source.name,source.items,item=>openTitle(item)))
    else if (source.issue) main.append(catalogNotice(source,()=>showHome(page)))
  }
  catalog.hidden = !catalog.childElementCount
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
  const id = reset('search')
  returnTo = () => showSearch(value)
  const results = make('section')
  main.append(results)
  try {
    const {items,issues} = await request('search', {query:value,reportIssues:true})
    if (id !== viewId) return
    if (items.length) results.append(group(value ? 'Ergebnisse für „'+value+'“' : 'Suchergebnisse',items,item => openTitle(item)))
    for (const source of issues) results.append(catalogNotice(source,()=>showSearch(value)))
    if (!items.length && !issues.length) results.append(notice('Keine Treffer', 'Suche nach einem Titel in deiner Medienbibliothek.'))
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
  const heading = make('h2',title)
  heading.id='settings-title'
  row.append(heading,iconAction('close','Schließen',() => settings.close(),'icon-button',false))
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
  const tools = make('section','','settings-section')
  tools.append(iconAction('cloud','Google-Konto',showAccount,'settings-row'),
    iconAction('grid','Kataloge',showCatalogs,'settings-row'),
    action('Verbindung',showNetworkSettings,'settings-row'))
  const updates = make('section','','settings-section')
  const progress = make('progress','','update-progress')
  progress.hidden = true
  progress.max = 100
  progress.setAttribute('aria-label','Downloadfortschritt')
  const controls = make('div','','actions')
  const check = action('Jetzt prüfen',async()=>updateView?.(await request('updates-check')))
  const install = action('Installieren und beenden',async()=>{
    install.disabled=true
    if (!await request('updates-install')) install.disabled=false
  },'primary')
  check.disabled = true
  install.hidden = true
  controls.append(check,install)
  updates.append(make('h3','Software-Updates'),report,progress,controls)
  updateView = state => {
    const messages={unconfigured:'Für automatische Updates installiere die GitHub-Ausgabe von KinoTix.',idle:'Sucht beim Start auf GitHub nach Updates.',
      checking:'Updates werden geprüft …',current:'KinoTix ist aktuell.',downloading:'Update '+(state.available||'')+' wird geladen · '+(state.percent??0)+' %',
      ready:'Version '+state.available+' ist bereit und wird beim Beenden installiert.',error:'Das Update konnte gerade nicht geladen werden.'}
    report.textContent='Version '+state.current+' · '+(messages[state.phase] || '')
    progress.hidden = state.phase !== 'downloading'
    progress.value = state.percent ?? 0
    check.hidden = state.phase === 'ready'
    check.disabled = ['unconfigured','checking','downloading'].includes(state.phase)
    install.hidden = state.phase !== 'ready'
  }
  dialog('Einstellungen',tools,updates)
  const state = await request('updates-state')
  if (report.isConnected) updateView?.(state)
}
async function showNetworkSettings() {
  const explanation = make('p','Im Automatikmodus verwendet KinoTix zuerst die DNS-Einstellung deines Systems. Bei einem Problem mit der Namensauflösung versucht die App es erneut mit verschlüsseltem DNS über Cloudflare.')
  const current = make('p')
  current.setAttribute('role','status')
  const label = make('label','','dns-option')
  const setting = selectInput('DNS-Modus',[
    ['automatic','Automatisch'],
    ['system','System-DNS'],
    ['secure','Immer sicheres DNS'],
  ])
  label.append(make('span','DNS-Modus'),setting)
  const restart = action('KinoTix neu starten',async()=>request('network-restart'),'primary')
  const controls=make('div','','actions')
  controls.append(action('Zurück',showAppSettings),restart)
  const card=make('section','','settings-section')
  card.append(explanation,label,current,controls)
  function render(state) {
    setting.value=state.mode
    restart.hidden=state.mode===state.activeMode
    current.textContent=restart.hidden
      ? (state.secureActive?'Sicheres DNS ist aktiv.':'KinoTix verwendet gerade das DNS deines Systems.')
      : 'Die Änderung wird beim nächsten Start wirksam.'
  }
  render(await request('network-state'))
  setting.addEventListener('change',async()=>{
    setting.disabled=true
    try { render(await request('network-set',{mode:setting.value})) }
    catch (error) {
      const state=await request('network-state').catch(()=>null)
      if (state) render(state)
      current.textContent=cleanError(error)
    }
    finally { setting.disabled=false }
  })
  dialog('Verbindung',card)
}
async function copyDeviceCatalogs() {
  await request('catalog-copy-local')
  if (settings.open) settings.close()
  await showHome()
}
async function showCatalogs() {
  const state=await request('catalog-state')
  const view=make('div','','stack')
  view.append(namedForm('Katalog-Domain, z. B. katalog.example.org','Domain hinzufügen',async domain=>{
    await request('catalog-add-domain',{domain})
    settings.close()
    await showHome()
  }))
  for (const source of state.sources) {
    const row=make('div','','catalog-row')
    const label=make('div')
    label.append(make('strong',source.name),make('span',new URL(source.origin).hostname))
    row.append(label,
      action('Entfernen',()=>{
        dialog('Katalog entfernen',make('p',source.name+' aus deiner Quellenliste entfernen?'),
          action('Entfernen',async()=>{await request('catalog-remove',{id:source.id});settings.close();await showHome()}),
          action('Zurück',showCatalogs))
      }))
    view.append(row)
  }
  if (state.available) view.append(action('Lokale Kataloge ins Konto übernehmen',copyDeviceCatalogs))
  view.append(action('Katalogdatei importieren',async()=>{
    if (await request('catalog-import')) { settings.close();await showHome() }
  },'primary'))
  dialog('Kataloge',view)
}

async function showLocalVideoLinks() {
  const items=await request('media-local-candidates')
  const choices=make('div','','stack')
  const ids=new Set()
  const copy=action('Auswahl ins Konto übernehmen',async()=>{
    copy.disabled=true
    try {
      const count=await request('media-copy-local',{ids:[...ids]})
      dialog('Videolinks übernommen',make('p',count===1?'Ein Videolink wurde ins Konto übernommen.':count+' Videolinks wurden ins Konto übernommen.'),
        action('Zur Mediathek',async()=>{settings.close(); await showHome()}))
    } finally { copy.disabled=ids.size===0 }
  },'primary')
  copy.disabled=true
  for (const item of items) {
    const check=make('input')
    check.type='checkbox'
    check.addEventListener('change',()=>{
      if (check.checked) ids.add(item.id)
      else ids.delete(item.id)
      copy.disabled=ids.size===0
    })
    const label=make('label','','dns-option')
    label.append(check,make('span',item.title+' · '+item.hostname))
    choices.append(label)
  }
  if (!items.length) choices.append(make('p','Auf diesem Gerät sind keine weiteren übertragbaren Videolinks vorhanden.'))
  dialog('Lokale Videolinks übernehmen',make('p','Wähle, welche Videolinks du auf deinen angemeldeten Geräten öffnen möchtest. Dateien, Medienlisten und der Gastverlauf bleiben lokal.'),
    choices,...(items.length?[copy]:[]),action('Zurück',showAccount))
}

async function showAccount() {
  const view=make('div','','stack')
  function render(state) {
    view.querySelector('.account-content')?.remove()
    const content=make('div','','account-content stack')
    view.prepend(content)
    if (state.connected) {
      content.append(make('p','Angemeldet als '+state.email),
        make('p',state.issue || (state.lastSync?'Kataloge, Videolinks und Fortschritt sind synchronisiert.':'Kataloge, Videolinks und Fortschritt werden synchronisiert …')),
        make('p','Der Fortschritt von „Mein Profil“ wird synchronisiert. Weitere Profile bleiben auf diesem Gerät.'),
        action('Jetzt synchronisieren',async()=>render(await request('sync-refresh'))),
        action('Lokale Videolinks ins Konto übernehmen',showLocalVideoLinks),
        action('Abmelden',async()=>{await request('sync-sign-out');settings.close();await showHome()}))
    } else {
      content.append(make('p','Ohne Konto bleiben Kataloge, Merkliste und Verlauf auf diesem Gerät. Mit Google kannst du Kataloge, Videolinks und den Wiedergabestand zwischen deinen angemeldeten Geräten synchronisieren.'))
      if (state.issue) content.append(make('p',state.issue,'inline-error'))
      if (!state.configured) content.append(make('p','Die Google-Anmeldung ist für diesen Build noch nicht eingerichtet.'))
      else if (state.restoring) content.append(make('p','Die gespeicherte Anmeldung wird geöffnet …'))
      else if (state.phone) {
        if (state.phone.email) {
          content.append(make('p',state.phone.email),action('Mit diesem Konto verbinden',()=>request('sync-phone-confirm'),'primary'))
        } else if (state.phone.image) {
          const image=make('img')
          image.src=state.phone.image
          image.alt='QR-Code für die Google-Anmeldung'
          image.className='sign-in-qr'
          content.append(image,make('p','Scanne den Code mit dem Handy und bestätige dein Konto anschließend hier.'))
        } else content.append(make('p','Anmeldecode wird angefordert …'))
        content.append(action('Abbrechen',()=>request('sync-phone-cancel')))
      }
      else if (state.signingIn) content.append(make('p','Schließe die Anmeldung im Browser ab.'))
      else content.append(action('Mit Google anmelden',async()=>{
        const next=await request('sync-sign-in')
        if (next.connected) { settings.close(); await showHome() }
      },'primary'),action('Mit Handy anmelden',async()=>{
        const next=await request('sync-sign-in',{method:'phone'})
        if (next.connected && settings.open) { settings.close(); await showHome() }
      }))
    }
  }
  dialog('Google-Konto',view)
  settings.addEventListener('close',()=>{void request('sync-phone-cancel')},{once:true})
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
  const id = reset('lists')
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
    const [data, records] = await Promise.all([request('title', {url:item.url,reportIssues:true}), request('history')])
    if (id !== viewId) return
    if (data.issue) {
      main.replaceChildren(action('← Zurück',goBack,'detail-bar'),
        catalogNotice({...data,name:item.title || 'Titel konnte nicht geladen werden'},()=>openTitle(item,resume),item.url))
      return
    }
    detail = data
    history = records
    void request('news-seen',{url:data.url}).catch(()=>{})
    const record = records.find(entry => entry.url === data.url)
    const previous = record && data.episodes.findIndex(ep => key(ep) === record.last)
    const index = Number.isInteger(previous) && previous >= 0 ?
      Math.min(previous + (record.episodes[record.last].finished ? 1 : 0), data.episodes.length-1) : 0
    const next = data.episodes[index]
    const hero = make('section', '', 'hero hero-detail')
    heroArtwork(hero,data)
    const info = make('div','','hero-content')
    info.append(make('h1', data.title,'hero-title'))
    const meta = [data.isSeries ? 'Serie' : 'Film',data.year && !data.title.includes(String(data.year)) ? data.year : ''].filter(Boolean).join(' · ')
    info.append(make('p',meta,'hero-meta'))
    if (data.description) info.append(make('p', data.description,'lead'))
    const controls = make('div', '', 'actions')
    if (next) {
      const label = data.isSeries ? 'Staffel ' + next.season + ' · Folge ' + next.episode : 'Abspielen'
      controls.append(iconAction('play',label,() => play(next),'primary'))
      if (platform==='win32') controls.append(tvButton(data,next))
    }
    controls.append(action('Merken',() => chooseLists(data)))
    if (data.url.startsWith('media:') && !data.accountLink) controls.append(action('Aus Mediathek entfernen',()=>{
      dialog('Titel entfernen',make('p','„'+data.title+'“ aus der Mediathek auf diesem PC entfernen? Videodateien bleiben auf der Festplatte.'),
        action('Entfernen',async()=>{await request('media-remove-local',{id:data.url}); settings.close(); await showHome()}),
        action('Abbrechen',()=>settings.close()))
    }))
    if (data.accountLink) controls.append(action('Videolink aus Konto entfernen',()=>{
      dialog('Videolink entfernen',make('p','Diesen Videolink aus deinem Konto und den angemeldeten Geräten entfernen? Eine lokale Kopie bleibt erhalten.'),
        action('Aus Konto entfernen',async()=>{await request('media-remove-link',{id:data.url}); settings.close(); await showHome()}),
        action('Abbrechen',()=>settings.close()))
    }))
    const watchedFilm=record?.episodes[record.last]?.finished
    if (!data.isSeries && next) controls.append(action(watchedFilm ? 'Als ungesehen markieren' : 'Als gesehen markieren',async () => {
      await request('mark',{url:data.url,season:next.season,episode:next.episode,finished:!watchedFilm})
      await openTitle(data)
    }))
    info.append(controls)
    hero.append(info)
    main.replaceChildren(iconAction('back','Zurück',goBack,'detail-bar'), hero)
    if (data.isSeries && next) main.append(episodeSection(data, record, next.season))
    if (!next) main.append(notice('Keine Quelle verfügbar', 'KinoTix hat für diesen Titel gerade keinen Player geliefert.'))
    if (resume && next) play(next)
  } catch (e) {
    if (id === viewId) main.replaceChildren(action('← Zurück', goBack, 'detail-bar'), notice('Titel konnte nicht geladen werden', cleanError(e), () => openTitle(item, resume)))
  }
}
function key(episode) { return episode.season + ':' + episode.episode }
function tvButton(title,episode) {
  const show = async () => {
    const body=make('div','','stack')
    const report=make('p','Suche nach DLNA-Fernsehern im selben Netzwerk …')
    body.append(report)
    dialog('Auf Fernseher abspielen',body)
    try {
      const devices=await request('tv-devices')
      report.textContent=devices.length ? 'Wähle den Fernseher für '+title.title+'.' : 'Kein DLNA-Fernseher gefunden. Schalte den Fernseher ein und aktiviere bei Bedarf die Medienwiedergabe im Heimnetz.'
      if (!devices.length) body.append(action('Erneut suchen',show))
      for (const device of devices) {
        body.append(action(device.name,async()=>{
          for (const button of body.querySelectorAll('button')) button.disabled=true
          report.textContent='Wiedergabe wird angefordert …'
          try {
            const result=await request('tv-play',{url:title.url,season:episode.season,episode:episode.episode,target:device.id})
            report.textContent=result.name+' hat den Wiedergabebefehl angenommen.'+(result.resumed?' Die gespeicherte Position wurde übernommen.':'')
          } catch(error) { report.textContent=cleanError(error) }
          finally { for (const button of body.querySelectorAll('button')) button.disabled=false }
        }))
      }
    } catch(error) { report.textContent=cleanError(error); body.append(action('Erneut suchen',show)) }
  }
  return action('Auf Fernseher abspielen',show)
}
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
      if (platform==='win32') row.append(tvButton(data,ep))
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
  if (message.type === 'account-library') { void showHome(); return }
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
document.querySelector('#home-tab').addEventListener('click', () => showHome())
enableSearchSuggestions(query, term => request('search', {query:term}), item => openTitle(item))
document.querySelector('#search').addEventListener('submit', event => {
  event.preventDefault()
  void showSearch(query.value.trim())
})
function openImport() {
  if (active) { void request('close'); active = null; void showHome() }
  linkDialog.showModal()
  sourceURL.focus()
}
document.querySelector('#from-link').addEventListener('click',openImport)
document.querySelector('#cancel-link').addEventListener('click', () => linkDialog.close())
const addForm = document.querySelector('#link-form')
const sourceURL = addForm.elements.url
const sourceCheck = document.querySelector('#source-check')
const sourceResult = document.querySelector('#source-result')
const sourceDetails = document.querySelector('#source-details')
const sourceActions = document.querySelector('#source-actions')
const sourceSave = document.querySelector('#source-save')
const sourceDomain = document.querySelector('#domain-save')
const sourceNetwork = document.querySelector('#source-network')
const sourceFile = document.querySelector('#file-open')
let sourceRevision = 0
let checkedSource

function showSourceResult(kind, title, message, code) {
  sourceResult.hidden = false
  sourceResult.dataset.kind = kind
  sourceResult.querySelector('#source-kind').textContent = title
  sourceResult.querySelector('#source-message').textContent = message || ''
  sourceNetwork.hidden = code !== 'dns-blocked'
  sourceSave.hidden = !checkedSource
  sourceActions.hidden = sourceSave.hidden && sourceNetwork.hidden
  sourceDetails.hidden = checkedSource?.kind !== 'video'
}
function resetSourcePreview() {
  sourceRevision++
  checkedSource = undefined
  sourceResult.hidden = true
  sourceCheck.disabled = false
}
function sourceFailure(error) {
  checkedSource = undefined
  showSourceResult('invalid','Quelle konnte nicht hinzugefügt werden',cleanError(error))
}
async function checkSource() {
  const revision = ++sourceRevision
  checkedSource = undefined
  sourceCheck.disabled = true
  showSourceResult('checking','Adresse wird geprüft')
  try {
    const result = await request('source-preview',{url:sourceURL.value.trim()})
    if (revision !== sourceRevision || !linkDialog.open) return
    if (['video','catalog','domain'].includes(result.kind)) checkedSource = result
    const titles = {
      video:'Video erkannt',catalog:result.name || 'KinoTix-Katalog erkannt',domain:result.name,
      website:'Webseite erkannt',unreachable:'Quelle nicht erreichbar',invalid:'Adresse prüfen',
    }
    showSourceResult(result.kind,titles[result.kind],result.message,result.code)
    if (checkedSource) sourceSave.focus()
  } catch (error) {
    if (revision === sourceRevision) sourceFailure(error)
  } finally {
    if (revision === sourceRevision) sourceCheck.disabled = false
  }
}
async function addSource(method, value) {
  if (sourceFile.disabled) return
  sourceDomain.disabled = sourceFile.disabled = sourceCheck.disabled = sourceSave.disabled = sourceURL.disabled = true
  try {
    const result = await request(method,value)
    if (!result) return
    linkDialog.close()
    addForm.reset()
    if (result.kind === 'video') await openTitle(result.item)
    else await showHome()
  } catch (error) {
    if (linkDialog.open) sourceFailure(error)
  } finally {
    sourceDomain.disabled = sourceFile.disabled = sourceCheck.disabled = sourceSave.disabled = sourceURL.disabled = false
  }
}
function chooseSourceFile() { return addSource('source-file',{}) }
addForm.addEventListener('submit',event=>{event.preventDefault(); void checkSource()})
sourceURL.addEventListener('input',resetSourcePreview)
sourceFile.addEventListener('click',()=>void chooseSourceFile())
sourceDomain.addEventListener('click',()=>{
  if (sourceURL.reportValidity()) void addSource('catalog-add-domain',{domain:sourceURL.value.trim()})
})
sourceSave.addEventListener('click',()=>{
  if (checkedSource?.kind==='domain') void addSource('catalog-add-domain',{domain:sourceURL.value.trim()})
  else if (checkedSource) void addSource('source-add',{url:sourceURL.value.trim(),title:addForm.elements.title.value,imdb:addForm.elements.imdb.value})
})
sourceNetwork.addEventListener('click',()=>{
  linkDialog.close()
  void showNetworkSettings().catch(error=>dialog('Verbindung',make('p',cleanError(error))))
})
linkDialog.addEventListener('close',resetSourcePreview)
document.querySelector('#catalog-open').addEventListener('click',()=>{
  linkDialog.close()
  void showCatalogs().catch(error=>dialog('Kataloge',make('p',cleanError(error))))
})
void showHome()
