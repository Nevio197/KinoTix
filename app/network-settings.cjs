const fs = require('node:fs')
const path = require('node:path')

function openNetworkSettings(folder, app) {
  const filename = path.join(folder, 'network.json')
  let secureDns = false
  let active = false
  try { secureDns = JSON.parse(fs.readFileSync(filename, 'utf8'))?.secureDns === true } catch {}

  if (secureDns) {
    try {
      app.configureHostResolver({
        secureDnsMode: 'secure',
        secureDnsServers: ['https://cloudflare-dns.com/dns-query'],
      })
      active = true
    } catch (error) {
      console.warn('KinoTix – verschlüsseltes DNS:', error.message)
    }
  }

  const state = () => ({ secureDns, active })
  return {
    state,
    set(value) {
      if (typeof value !== 'boolean') throw Error('Ungültige DNS-Einstellung.')
      if (value !== secureDns) {
        fs.writeFileSync(filename + '.tmp', JSON.stringify({ secureDns: value }), { mode: 0o600 })
        fs.renameSync(filename + '.tmp', filename)
        secureDns = value
      }
      return state()
    },
  }
}

module.exports = { openNetworkSettings }
