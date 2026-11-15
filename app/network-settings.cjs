const fs = require('node:fs')
const path = require('node:path')

const modes = new Set(['automatic', 'system', 'secure'])
const dnsFailure = code => code === 'dns' || code === 'dns-blocked'

function openNetworkSettings(folder, app) {
  const filename = path.join(folder, 'network.json')
  let settings
  try { settings = JSON.parse(fs.readFileSync(filename, 'utf8')) } catch {}
  const activeMode = modes.has(settings?.mode) ? settings.mode :
    settings?.secureDns === true ? 'secure' : settings?.secureDns === false ? 'system' : 'automatic'
  let mode = activeMode
  let secureActive = false
  let secureAttempted = false

  function activateSecureDns() {
    if (secureAttempted) return secureActive
    secureAttempted = true
    try {
      app.configureHostResolver({
        secureDnsMode: 'secure',
        secureDnsServers: ['https://cloudflare-dns.com/dns-query'],
      })
      secureActive = true
    } catch (error) {
      console.warn('KinoTix – verschlüsseltes DNS:', error.message)
    }
    return secureActive
  }

  if (activeMode === 'secure') activateSecureDns()
  else app.configureHostResolver({ enableBuiltInResolver: false, secureDnsMode: 'off' })

  const state = () => ({ mode, activeMode, secureActive })
  const retryDns = (code, startedWithSecureDns) =>
    activeMode === 'automatic' && !startedWithSecureDns && dnsFailure(code) && activateSecureDns()
  return {
    state,
    retryDns,
    set(nextMode) {
      if (!modes.has(nextMode)) throw Error('Ungültige DNS-Einstellung.')
      if (nextMode !== mode) {
        fs.writeFileSync(filename + '.tmp', JSON.stringify({ mode: nextMode }), { mode: 0o600 })
        fs.renameSync(filename + '.tmp', filename)
        mode = nextMode
      }
      return state()
    },
    async withDnsFallback(operation, resultCode = result => result?.code) {
      const startedWithSecureDns = secureActive
      let result
      try {
        result = await operation()
      } catch (error) {
        if (retryDns(error?.code, startedWithSecureDns)) return operation()
        throw error
      }
      if (retryDns(resultCode(result), startedWithSecureDns)) return operation()
      return result
    },
  }
}

module.exports = { openNetworkSettings }
