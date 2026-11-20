const {test} = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {createHash} = require('node:crypto')
const {createAccountSync} = require('../app/account-sync.cjs')
const {openMedia,openAccountMedia} = require('../app/media.cjs')

test('phone sign-in requires confirmation and syncs only portable media',async t=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'kinotix-phone-test-'))
  t.after(()=>fs.rmSync(folder,{recursive:true,force:true}))
  const config={url:'https://fixture.supabase.co',publishableKey:'sb_publishable_fixture'}
  const id='11111111-1111-4111-8111-111111111111', ticket='x'.repeat(22)
  const hash=s=>createHash('sha256').update(s).digest('base64url')
  let start, merged=[], latest=[]
  const device=openMedia(folder), media=openAccountMedia(folder,device)
  const portable=device.addURL('https://example.org/video.mp4',{title:'Beispiel'})
  device.addURL('https://example.org/private.mp4?token=123',{})
  const fetcher=async(address,options)=>{
    const url=new URL(address)
    const body=options.body && JSON.parse(options.body)
    if (url.pathname.endsWith('/start')) {
      start=body
      return Response.json({id:ticket,url:config.url+'/functions/v1/kinotix-tv-auth/login/'+ticket+'/'+'y'.repeat(43),expiresIn:60})
    }
    if (url.pathname.endsWith('/poll')) {
      assert.equal(hash(body.readToken),start.readHash)
      return Response.json({status:'ready',code:'test-code'})
    }
    if (url.pathname.endsWith('/token')) {
      assert.equal(hash(body.code_verifier),start.challenge)
      return Response.json({access_token:'access',refresh_token:'refresh',expires_in:3600})
    }
    if (url.pathname.endsWith('/user')) return Response.json({id,email:'user@example.test'})
    if (url.pathname.endsWith('/kinotix_merge')) { merged.push(...body.p_items); return new Response(null,{status:204}) }
    if (url.pathname.endsWith('/kinotix_sync')) return Response.json(url.searchParams.get('kind')==='eq.media'?merged:[])
    throw Error('Unerwartete Route '+url.pathname)
  }
  const sync=createAccountSync({folder,config,fetcher,
    safeStorage:{isAsyncEncryptionAvailable:async()=>true,encryptStringAsync:async()=>Buffer.from('test-wrapped')},
    apply:()=>{},applyCatalogs:()=>{},bind:()=>{},applyMedia:rows=>{latest=rows},notify:()=>{}})
  t.after(()=>sync.stop())
  const login=sync.signIn('phone')
  const {setTimeout:pause}=require('node:timers/promises')
  for(let i=0;i<100 && !sync.status().phone?.email;i++) await pause(50)
  assert.equal(sync.status().phone?.email,'user@example.test')
  assert.equal(sync.status().connected,false)
  assert.equal(fs.existsSync(path.join(folder,'account.json')),false)
  sync.confirmPhone()
  assert.equal((await login).connected,true)
  assert.deepEqual(media.copyable().map(v=>v.id),[portable.url])
  const [row]=media.copy(new Set([portable.url]))
  sync.recordMedia([row])
  await sync.exchange()
  assert.equal(latest[0].url,'https://example.org/video.mp4')
  media.apply(latest)
  sync.recordMedia([media.remove(row.id)])
  await sync.exchange()
  assert.equal(latest.at(-1).removed,true)
})
