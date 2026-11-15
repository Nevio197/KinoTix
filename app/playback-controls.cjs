const actions = {
  'toggle': 'if(video.paused) await video.play(); else video.pause()',
  'pause': 'video.pause()',
  'play': 'await video.play()',
  'seek': 'video.currentTime=Math.max(0,Math.min(video.duration-0.1,value))',
  'jump': 'video.currentTime=Math.max(0,Math.min(video.duration-0.1,video.currentTime+value))',
  'set-volume': 'video.volume=value; video[Symbol.for("kinotix-volume-ready")]=true',
  'pip': 'if(document.pictureInPictureElement) await document.exitPictureInPicture(); else await video.requestPictureInPicture()',
}
function controller(playerScript) {
  return async (frame, action, value = 0) => {
    if (!frame || !Object.hasOwn(actions, action)) return false
    try {
      return await frame.executeJavaScript(`(async () => {
        const video = ${playerScript};
        if (!video) return false;
        const value = ${Number(value) || 0};
        ${actions[action]};
        return true;
      })()`, true)
    } catch { return false }
  }
}
function keyAction(input) {
  if (input.type !== 'keyDown' || input.meta || input.control || input.alt) return null
  return ({
    ' ': ['toggle'], 'MediaPlayPause':['toggle'], 'MediaPlay':['play'], 'MediaPause':['pause'],
    'ArrowLeft':['jump',-10], 'ArrowRight':['jump',10], 'MediaRewind':['jump',-10], 'MediaFastForward':['jump',10],
    'ArrowUp':['volume',.1], 'ArrowDown':['volume',-.1], 'm':['mute'], 'f':['fullscreen'], 'p':['pip'],
  })[input.key]
}
const qualityTargets = [{height:2160,rate:18},{height:1080,rate:6},{height:720,rate:3},{height:480,rate:1.4},{height:360,rate:.65}]
function chooseQuality(variants, estimate, preference) {
  const options = [...variants].sort((a,b) => b.height-a.height)
  const limit = preference === 'high' ? Infinity : preference === 'data' ? 480 :
    qualityTargets.find(target => estimate >= target.rate)?.height ?? 360
  return options.find(item => item.height <= limit) ?? options.at(-1)
}
module.exports = { controller, keyAction, chooseQuality }
