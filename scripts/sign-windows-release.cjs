const fs = require('node:fs')
const path = require('node:path')
const { createHash, createPrivateKey, createPublicKey, sign } = require('node:crypto')
const { APP_ID, MANIFEST, SIGNATURE, installerName, updateConfig, validateManifest } = require('../app/windows-update-format.cjs')

async function main() {
  const [installer, privateKeyFile] = process.argv.slice(2)
  if (!installer || !privateKeyFile) throw Error('Usage: node scripts/sign-windows-release.cjs <setup.exe> <private-key.pem>')
  const { version } = require('../app/package.json')
  const file = installerName(version)
  if (path.basename(installer) !== file || !fs.lstatSync(installer).isFile()) throw Error('Installer name does not match the app version.')
  const config = updateConfig(require('../app/windows-update.json'))
  const privateKey = createPrivateKey(fs.readFileSync(privateKeyFile))
  const derivedKey = createPublicKey(privateKey)
  if (!derivedKey.equals(config.key)) throw Error('Release key does not match the update key configured for the build.')

  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of fs.createReadStream(installer)) {
    size += chunk.length
    hash.update(chunk)
  }
  const manifest = validateManifest({ schema:1, appId:APP_ID, platform:'win32', arch:'x64',
    version, file, size, sha256:hash.digest('hex') }, version)
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n')
  const directory = path.dirname(installer)
  fs.writeFileSync(path.join(directory, MANIFEST), bytes)
  fs.writeFileSync(path.join(directory, SIGNATURE), sign(null, bytes, privateKey).toString('base64') + '\n')
  console.log('Signed Windows update manifest for ' + version)
}

main().catch(error=>{
  console.error(error.message)
  process.exitCode = 1
})
