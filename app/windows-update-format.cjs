const { createPublicKey, verify } = require('node:crypto')

const APP_ID = 'de.kinotix.desktop'
const MANIFEST = 'kinotix-windows-x64.json'
const SIGNATURE = MANIFEST + '.sig'
const MAX_INSTALLER = 1024 * 1024 * 1024

function versionParts(value) {
  return typeof value === 'string' && value.length <= 32
    ? /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value)?.slice(1).map(BigInt)
    : undefined
}

function newerVersion(candidate, current) {
  const next = versionParts(candidate)
  const previous = versionParts(current)
  if (!next || !previous) return false
  const differingPart = next.findIndex((part, index) => part !== previous[index])
  return differingPart >= 0 && next[differingPart] > previous[differingPart]
}

function installerName(version) {
  if (!versionParts(version)) throw Error('Ungültige Update-Version.')
  return 'KinoTix-' + version + '-Windows-x64-Setup.exe'
}

function decodeBase64(value, length) {
  if (typeof value !== 'string' || value.length !== Math.ceil(length / 3) * 4) throw Error('Ungültige Signaturdaten.')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length !== length || bytes.toString('base64') !== value) throw Error('Ungültige Signaturdaten.')
  return bytes
}

function updateConfig(config) {
  const { repository, publicKey } = config ?? {}
  if (typeof repository !== 'string' ||
      !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?\/[a-z\d._-]{1,100}$/i.test(repository) ||
      /\/\.{1,2}$/.test(repository)) {
    throw Error('Ungültiges Update-Repository.')
  }
  const key = createPublicKey({ key: decodeBase64(publicKey, 44), format: 'der', type: 'spki' })
  if (key.asymmetricKeyType !== 'ed25519') throw Error('Ungültiger Update-Schlüssel.')
  return { repository, key }
}

function validateManifest(manifest, version) {
  if (manifest?.schema !== 1 || manifest.appId !== APP_ID || manifest.platform !== 'win32' ||
      manifest.arch !== 'x64' || manifest.version !== version || manifest.file !== installerName(version) ||
      !Number.isSafeInteger(manifest.size) || manifest.size < 1 || manifest.size > MAX_INSTALLER ||
      typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.sha256)) {
    throw Error('Das Update-Manifest passt nicht zur App.')
  }
  return manifest
}

function verifiedManifest(bytes, signature, key, version) {
  if (!verify(null, bytes, key, decodeBase64(signature.trim(), 64))) throw Error('Ungültige Update-Signatur.')
  return validateManifest(JSON.parse(bytes.toString('utf8')), version)
}

module.exports = { APP_ID, MANIFEST, SIGNATURE, installerName, newerVersion, updateConfig, validateManifest, verifiedManifest }
