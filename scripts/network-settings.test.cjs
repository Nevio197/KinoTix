const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { openNetworkSettings } = require('../app/network-settings.cjs')
const { checkSource, isDnsError } = require('../app/source-check.cjs')

function setup(t, stored) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'kinotix-network-'))
  t.after(() => fs.rmSync(folder, { recursive:true, force:true }))
  if (stored) fs.writeFileSync(path.join(folder, 'network.json'), JSON.stringify(stored))
  const modes = []
  const app = { configureHostResolver:options => modes.push(options.secureDnsMode) }
  const network = openNetworkSettings(folder, app)
  return { network, modes, restart:() => openNetworkSettings(folder, app) }
}

test('automatic starts with system DNS and simultaneous failures switch once', async t => {
  const { network, modes } = setup(t)
  assert.deepEqual(network.state(), { mode:'automatic', activeMode:'automatic', secureActive:false })
  assert.deepEqual(modes, ['off'])
  let release
  const pending = new Promise(resolve => { release = resolve })
  let thrownCalls = 0
  let returnedCalls = 0
  const thrown = network.withDnsFallback(async () => {
    if (++thrownCalls === 1) {
      await pending
      throw Object.assign(new Error('DNS error'), { code:'dns' })
    }
    return 'loaded'
  })
  const returned = network.withDnsFallback(async () => {
    if (++returnedCalls === 1) await pending
    return { code:'dns-blocked' }
  })
  release()
  assert.deepEqual(await Promise.all([thrown, returned]), ['loaded', { code:'dns-blocked' }])
  assert.deepEqual([thrownCalls, returnedCalls], [2, 2])
  assert.deepEqual(modes, ['off', 'secure'])
  assert.equal(network.state().secureActive, true)
  assert.equal(network.retryDns('dns', true), false)
})

test('legacy preferences persist and changes apply after restart', t => {
  const { network, modes, restart } = setup(t, { secureDns:false })
  assert.deepEqual(network.state(), { mode:'system', activeMode:'system', secureActive:false })
  assert.equal(network.retryDns('dns', false), false)
  assert.deepEqual(network.set('secure'), { mode:'secure', activeMode:'system', secureActive:false })
  assert.deepEqual(modes, ['off'])
  assert.deepEqual(restart().state(), { mode:'secure', activeMode:'secure', secureActive:true })
  assert.deepEqual(modes, ['off', 'secure'])
  assert.throws(() => network.set(true), /Ungültige DNS-Einstellung/)
  assert.equal(setup(t, { secureDns:true }).network.state().mode, 'secure')
})

test('source checks retry DNS errors only, never certificates or HTTP denials', async t => {
  const { network, modes } = setup(t)
  const calls = []
  const check = (address, fetcher) => checkSource(address, {
    detectBlock:() => false,
    withDnsFallback:network.withDnsFallback,
    fetcher(url) { calls.push(url); return fetcher() },
  })
  const origin = 'https://fixture.example'
  const denial = await check(origin + '/restricted', () => new Response(null, {status:451}))
  const certificate = await check(origin + '/cert', () => { throw Error('net::ERR_CERT_DATE_INVALID') })
  assert.equal(denial.code, 'blocked')
  assert.equal(certificate.code, 'certificate')
  assert.deepEqual(modes, ['off'])
  assert.equal(isDnsError("net::ERR_FAILED (-2) loading 'https://fixture.example/ERR_NAME_NOT_RESOLVED'"), false)

  const media = origin + '/video.mp4'
  const video = await check(media, () => {
    if (!network.state().secureActive) throw Error('net::ERR_NAME_NOT_RESOLVED')
    return new Response('video', { headers:{'content-type':'video/mp4'} })
  })
  assert.equal(video.kind, 'video')
  assert.deepEqual(calls, [origin + '/restricted', origin + '/cert', media, media])
  assert.deepEqual(modes, ['off', 'secure'])
})
