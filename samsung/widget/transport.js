(() => {
  'use strict'

  const maximumBytes = 16 * 1024 * 1024
  const dnsCache = new Map()
  const redirects = new Set([301, 302, 303, 307, 308])
  const retryable = new Set([5, 6, 7, 28, 35, 51, 60])
  const forbiddenHeaders = /^(?:host|cookie2?|content-length|connection|upgrade|transfer-encoding|proxy-.*|sec-.*|te|trailer)$/i
  let workerState
  let serial = Promise.resolve()
  let nextId = 0

  function address(value, hosts) {
    const url = new URL(value)
    if (typeof value !== 'string' || value.length > 8192 || url.protocol !== 'https:' ||
        url.username || url.password || url.port || url.hash || !hosts.has(url.hostname)) {
      throw Error('Diese HTTPS-Adresse ist für die Quelle nicht freigegeben.')
    }
    return url
  }

  function hostSet(values) {
    if (!Array.isArray(values) || !values.length || values.length > 80) throw Error('Die Quelle hat keine gültige Hostliste.')
    const hosts = new Set()
    for (const host of values) {
      if (typeof host !== 'string' || host.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) {
        throw Error('Die Hostliste der Quelle ist ungültig.')
      }
      hosts.add(host)
    }
    return hosts
  }

  function headersOf(value) {
    const headers = Object.create(null)
    if (value == null) return headers
    if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 30) throw Error('Ungültige Anfrage-Header.')
    let size = 0
    for (const [name, data] of Object.entries(value)) {
      if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name) || forbiddenHeaders.test(name) ||
          typeof data !== 'string' || /[\x00-\x1f\x7f]/.test(data)) throw Error('Ungültige Anfrage-Header.')
      size += name.length + data.length + 3
      if (size > 16384) throw Error('Die Anfrage-Header sind zu groß.')
      headers[name] = data
    }
    return headers
  }

  function reset(state, message) {
    if (workerState !== state) return
    workerState = undefined
    clearTimeout(state.deadline)
    state.worker.terminate()
    state.rejectReady(Error(message))
    for (const pending of state.pending.values()) {
      clearTimeout(pending.deadline)
      pending.reject(Error(message))
    }
    state.pending.clear()
  }

  function openWorker() {
    if (workerState) return workerState
    const worker = new Worker('tizen-fetch.js')
    const state = { worker, pending: new Map() }
    state.ready = new Promise((resolve, reject) => {
      state.rejectReady = reject
      state.deadline = setTimeout(() => reset(state, 'Der HTTPS-Dienst konnte nicht gestartet werden.'), 15000)
      worker.onmessage = ({ data }) => {
        if (data.type === 'kinotix-transport-ready') {
          clearTimeout(state.deadline)
          resolve()
          return
        }
        if (data.type !== 'kinotix-response') return
        const pending = state.pending.get(data.id)
        if (!pending) return
        state.pending.delete(data.id)
        clearTimeout(pending.deadline)
        if (data.result) {
          const error = Error(data.result === 23 ? 'Die Antwort der Quelle ist zu groß.' : `HTTPS-Verbindung fehlgeschlagen (${data.result}).`)
          error.nativeCode = data.result
          pending.reject(error)
        } else pending.resolve(data)
      }
      worker.onerror = () => reset(state, 'Der HTTPS-Dienst wurde beendet. Versuche es erneut.')
    })
    workerState = state
    return state
  }

  async function nativeRequest(url, options, ipv4) {
    const state = openWorker()
    await state.ready
    const id = ++nextId
    return await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reset(state, 'Zeitlimit für die HTTPS-Verbindung.'), 15000)
      state.pending.set(id, { resolve, reject, deadline })
      state.worker.postMessage({
        type: 'kinotix-request', id, url: url.href,
        address: ipv4 ? `${url.hostname}:443:${ipv4}` : '', method: options.method,
        headers: Object.entries(options.headers).map(([name, data]) => `${name}: ${data}`).join('\n'),
        body: options.body, maxBytes: options.maxBytes, responseType: options.responseType,
      })
    })
  }

  function publicIPv4(value) {
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(value)) return false
    const [a, b, c, d] = value.split('.').map(Number)
    if ([a, b, c, d].some(part => part > 255) || a === 0 || a === 10 || a === 127 || a >= 224) return false
    return !(a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 ||
      a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19))
  }

  async function resolve(host) {
    const cached = dnsCache.get(host)
    if (cached && cached.until > Date.now()) return cached.values
    const response = await fetch('https://cloudflare-dns.com/dns-query?type=A&name=' + encodeURIComponent(host), {
      headers: { Accept: 'application/dns-json' }, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) throw Error('Sicheres DNS ist gerade nicht erreichbar.')
    const answer = await response.json()
    const records = (Array.isArray(answer.Answer) ? answer.Answer : []).filter(row => row.type === 1 && publicIPv4(row.data))
    const values = [...new Set(records.map(row => row.data))].slice(0, 2)
    if (!values.length) throw Error('Für die HTTPS-Quelle wurde keine Adresse gefunden.')
    const ttl = Math.min(...records.map(row => Math.max(10, Math.min(300, Number(row.TTL) || 30))))
    dnsCache.set(host, { values, until: Date.now() + ttl * 1000 })
    return values
  }

  async function fetchHop(url, options) {
    if (options.dns !== 'secure') {
      try { return await nativeRequest(url, options) }
      catch (error) { if (options.dns === 'system' || !retryable.has(error.nativeCode)) throw error }
    }
    let failure
    for (const ipv4 of await resolve(url.hostname)) {
      try { return await nativeRequest(url, options, ipv4) }
      catch (error) {
        failure = error
        if (!retryable.has(error.nativeCode)) throw error
      }
    }
    throw failure
  }

  async function perform(value, options) {
    let url = address(value, options.hosts)
    let headers = options.headers
    for (let count = 0; count <= 5; count++) {
      const response = await fetchHop(url, { ...options, headers })
      if (!redirects.has(response.status)) return { status: response.status, body: response.body, url: url.href }
      if (options.redirect === 'error' || options.method === 'POST') throw Error('Diese Anfrage erlaubt keine Weiterleitung.')
      if (!response.location || count === 5) throw Error('Die Quelle leitet zu oft oder ohne gültige Adresse weiter.')
      const next = address(new URL(response.location, url).href, options.hosts)
      if (next.origin !== url.origin) headers = Object.fromEntries(Object.entries(headers).filter(([name]) => /^(?:accept|range)$/i.test(name)))
      url = next
    }
  }

  function request(value, settings = {}) {
    let options
    try {
      const method = settings.method ?? 'GET'
      const body = settings.body ?? ''
      const maxBytes = settings.maxBytes ?? 2 * 1024 * 1024
      const dns = settings.dns === false ? 'system' : settings.dns ?? 'automatic'
      const redirect = settings.redirect ?? 'follow'
      const responseType = settings.responseType ?? 'text'
      if (!['GET', 'POST'].includes(method) || typeof body !== 'string' || body.includes('\0') ||
          new TextEncoder().encode(body).byteLength > 2 * 1024 * 1024 || method === 'GET' && body ||
          !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > maximumBytes ||
          !['automatic', 'system', 'secure'].includes(dns) || !['follow', 'error'].includes(redirect) ||
          !['text', 'bytes'].includes(responseType) || responseType === 'bytes' && method !== 'GET') {
        throw Error('Ungültige HTTPS-Anfrage.')
      }
      options = { method, body, maxBytes, dns, redirect, responseType,
        hosts: hostSet(settings.allowedHosts), headers: headersOf(settings.headers) }
      address(value, options.hosts)
    } catch (error) { return Promise.reject(error) }
    const pending = serial.then(() => perform(value, options))
    serial = pending.catch(() => {})
    return pending
  }

  async function text(value, options) {
    const response = await request(value, { ...options, responseType: 'text' })
    if (response.status < 200 || response.status >= 300) throw Error(`Die Quelle antwortet mit HTTP ${response.status}.`)
    return response.body
  }

  window.KinoTransport = { request, text }
})()
