const {test} = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const {pathToFileURL} = require('node:url')
const {createTvPlayback} = require('../app/tv-playback.cjs')

test('sends the selected video to a renderer and serves only the requested file and range', async t=>{
  const commands=[]
  let mediaURL
  const receiver=http.createServer(async(req,res)=>{
    let body=''
    for await (const chunk of req) body+=chunk
    commands.push(req.headers.soapaction.split('#')[1].replace('"',''))
    if (body.includes('<CurrentURI>')) mediaURL=body.match(/<CurrentURI>([^<]+)</)[1]
    if (body.includes('<Target>')) assert.ok(body.includes('<Target>00:01:05</Target>'))
    res.writeHead(200).end()
  })
  await new Promise(resolve=>receiver.listen(0,'127.0.0.1',resolve))
  t.after(()=>receiver.close())
  const device={name:'Testfernseher',remote:'127.0.0.1',local:'127.0.0.1',control:'http://127.0.0.1:'+receiver.address().port,
    type:'urn:schemas-upnp-org:service:AVTransport:1'}
  const tv=createTvPlayback(async()=>[device])
  t.after(()=>tv.close())
  const [target]=await tv.list()
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'kinotix-tv-test-'))
  t.after(()=>fs.rm(dir,{recursive:true,force:true}))
  const file=path.join(dir,'Film.mp4')
  await fs.writeFile(file,'demovideo')
  assert.deepEqual(await tv.play(target.id,pathToFileURL(file),'Film',65),{name:device.name,resumed:true})
  assert.deepEqual(commands,['SetAVTransportURI','Play','Seek'])
  const response=await fetch(mediaURL,{headers:{Range:'bytes=2-5'}})
  assert.equal(response.status,206)
  assert.equal(response.headers.get('content-range'),'bytes 2-5/9')
  assert.equal(await response.text(),'movi')
  assert.equal((await fetch(new URL('/andere-datei',mediaURL))).status,404)
  assert.equal((await fetch(mediaURL,{headers:{Range:'bytes=100-'}})).status,416)
  const direct='https://example.org/film.mp4'
  await tv.play(target.id,direct,'Film',0)
  assert.equal(mediaURL,direct)
  await assert.rejects(tv.play('unknown',direct,'Film',0))
})
