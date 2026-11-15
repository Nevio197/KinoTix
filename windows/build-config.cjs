const localMac = process.platform === 'darwin' && process.env.KINOTIX_MAC_LOCAL === '1'
const repository = localMac ? undefined : process.env.KINOTIX_PUBLIC_REPOSITORY
if (repository && !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
  throw Error('KINOTIX_PUBLIC_REPOSITORY muss OWNER/REPO enthalten.')
}
const [owner,repo] = repository?.split('/') ?? []
const publisher = process.env.KINOTIX_WINDOWS_PUBLISHER?.trim()
if (repository && process.platform==='win32' && !publisher) throw Error('KINOTIX_WINDOWS_PUBLISHER fehlt.')

module.exports = {
  appId:'de.kinotix.desktop',
  productName:'KinoTix',
  electronVersion:'45.3.2',
  directories:{app:'../app',output:'../dist'},
  forceCodeSigning:Boolean(repository),
  publish:repository ? [{provider:'github',owner,repo,private:false}] : null,
  win:{
    icon:'../assets/KinoTix.png',
    target:'nsis',
    artifactName:'KinoTix-${version}-Windows-${arch}-Setup.${ext}',
    ...(publisher ? {signtoolOptions:{publisherName:[publisher]}} : {}),
  },
  nsis:{oneClick:false,allowElevation:false,createDesktopShortcut:false,deleteAppDataOnUninstall:false},
  mac:{
    icon:'../assets/KinoTix.icns',
    target:['dmg','zip'],
    category:'public.app-category.entertainment',
    hardenedRuntime:Boolean(repository),
    notarize:Boolean(repository),
    ...(!repository ? {identity:'-'} : {}),
    artifactName:'KinoTix-${version}-macOS-${arch}.${ext}',
  },
}
