const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { createHash } = require('node:crypto')
const { Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const { MANIFEST, SIGNATURE, installerName, newerVersion, verifiedManifest } = require('./windows-update-format.cjs')

const REDIRECTS = new Set([301, 302, 303, 307, 308])
const ASSET_HOSTS = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com'])

async function request(fetcher, source, { asset = false, signal, allowMissing = false } = {}) {
  const origin = new URL(source)
  let url = origin
  for (let redirects = 0; redirects <= 4; redirects++) {
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        (url.href !== origin.href && (!asset || !ASSET_HOSTS.has(url.hostname)))) {
      throw Error('Die Update-Adresse befindet sich außerhalb von GitHub.')
    }
    const response = await fetcher(url, {
      signal, redirect:'manual', headers: { Accept:asset ? 'application/octet-stream' : 'application/vnd.github+json' },
    })
    if (response.ok && response.body) return response
    await response.body?.cancel()
    if (response.status === 404 && allowMissing) return null
    if (!REDIRECTS.has(response.status)) throw Error('GitHub HTTP ' + response.status)
    const next = response.headers.get('location')
    if (!next) throw Error('Die GitHub-Weiterleitung ist unvollständig.')
    url = new URL(next, url)
  }
  throw Error('Zu viele GitHub-Weiterleitungen.')
}

async function limitedBytes(response, maximum) {
  const chunks = []
  let length = 0
  for await (const chunk of response.body) {
    length += chunk.length
    if (length > maximum) throw Error('Die Update-Daten sind zu groß.')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, length)
}

function correctInstaller(file, manifest) {
  let descriptor
  try {
    const entry = fs.lstatSync(file)
    if (!entry.isFile() || entry.size !== manifest.size) return false
    descriptor = fs.openSync(file, 'r')
    const hash = createHash('sha256')
    const data = Buffer.allocUnsafe(1024 * 1024)
    let length = 0
    for (let count; (count = fs.readSync(descriptor, data, 0, data.length, null)) > 0;) {
      length += count
      if (length > manifest.size) return false
      hash.update(data.subarray(0, count))
    }
    return length === manifest.size && hash.digest('hex') === manifest.sha256
  } catch {
    return false
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

async function downloadInstaller(fetcher, url, file, manifest, progress) {
  const folder = await fs.promises.mkdtemp(path.join(path.dirname(file), 'transfer-'))
  const temporary = path.join(folder, manifest.file)
  try {
    const signal = AbortSignal.timeout(15 * 60 * 1000)
    const response = await request(fetcher, url, { asset:true, signal })
    let length = 0
    const hash = createHash('sha256')
    const checked = new Transform({
      transform(chunk, _encoding, done) {
        length += chunk.length
        if (length > manifest.size) return done(Error('Die Größe des Installers stimmt nicht.'))
        hash.update(chunk)
        progress(Math.floor(length * 100 / manifest.size))
        done(null, chunk)
      },
    })
    await pipeline(response.body, checked, fs.createWriteStream(temporary, { flags:'wx', mode:0o700 }), { signal })
    if (length !== manifest.size || hash.digest('hex') !== manifest.sha256) throw Error('Die Prüfsumme des Installers stimmt nicht.')
    await fs.promises.rename(temporary, file)
  } finally {
    await fs.promises.rm(temporary, { force:true }).catch(()=>{})
    await fs.promises.rmdir(folder).catch(()=>{})
  }
}

function createWindowsUpdater({ app, notify, config, fetcher = fetch, launch = spawn }) {
  const current = app.getVersion()
  const cache = path.join(app.getPath('userData'), 'kinotix-updates')
  let state = { current, phase:'idle' }
  let pending
  let installRequested = false
  let timer
  const publish = (phase, extra = {}) => notify({ type:'updater', ...(state = { current, phase, ...extra }) })
  const asset = (version, file) => 'https://github.com/' + config.repository + '/releases/download/v' + version + '/' + file

  async function check() {
    if (['checking', 'downloading', 'ready'].includes(state.phase)) return state
    publish('checking')
    try {
      const response = await request(fetcher, 'https://api.github.com/repos/' + config.repository + '/releases/latest', {
        signal:AbortSignal.timeout(10000), allowMissing:true,
      })
      const release = response && JSON.parse((await limitedBytes(response, 1024 * 1024)).toString('utf8'))
      const version = typeof release?.tag_name === 'string' && release.tag_name.startsWith('v') && release.tag_name.slice(1)
      if (!version || release.draft !== false || release.prerelease !== false || !newerVersion(version, current)) {
        publish('current')
        return state
      }
      const signal = AbortSignal.timeout(15000)
      const [bytes, signature] = await Promise.all([MANIFEST, SIGNATURE].map(async name =>
        limitedBytes(await request(fetcher, asset(version, name), { asset:true, signal }), 4096)))
      const manifest = verifiedManifest(bytes, signature.toString('ascii'), config.key, version)
      const file = path.join(cache, installerName(version))
      const url = asset(version, manifest.file)
      await fs.promises.mkdir(cache, { recursive:true, mode:0o700 })
      if (!correctInstaller(file, manifest)) {
        await fs.promises.rm(file, { force:true })
        publish('downloading', { available:version, percent:0 })
        await downloadInstaller(fetcher, url, file, manifest, percent=>{
          if (state.percent !== percent) publish('downloading', { available:version, percent })
        })
      }
      pending = { file, url, manifest }
      publish('ready', { available:version })
    } catch (error) {
      pending = undefined
      console.warn('KinoTix-Update:', error.message)
      publish('error')
    }
    return state
  }

  app.once('quit', (_event, code)=>{
    if (code !== 0 || !pending || !correctInstaller(pending.file, pending.manifest)) return
    try {
      // Preserve Windows zone information for a download from the Internet.
      fs.writeFileSync(pending.file + ':Zone.Identifier', '[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=' + pending.url + '\r\n')
      const child = launch(pending.file, ['--updated', '/S'], { detached:true, stdio:'ignore', windowsHide:true, cwd:cache })
      child.on('error', error=>console.warn('KinoTix-Update:', error.message))
      child.unref()
    } catch (error) {
      console.warn('KinoTix-Update:', error.message)
    }
  })

  return {
    state:()=>state,
    start() {
      if (!timer) {
        timer=setTimeout(()=>void check(), 1500)
        timer.unref?.()
      }
    },
    check,
    install() {
      if (state.phase !== 'ready' || installRequested) return false
      installRequested = true
      setImmediate(()=>app.quit())
      return true
    },
  }
}

module.exports = { createWindowsUpdater }
