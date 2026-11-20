const assert = require('node:assert/strict')
const {EventEmitter} = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {test} = require('node:test')
const {openCatalog} = require('../app/catalog.cjs')
const {titleID} = require('../app/catalog-format.cjs')
const {browserCheck,checkSource} = require('../app/source-check.cjs')
const fixture = require('../examples/katalog.json')

function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'kinotix-catalog-'))
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  return openCatalog(dir,{detectBlock:()=>false,...options})
}

test('explicit device import can replace a newer removal exactly once',t=>{
  const device=setup(t), account=setup(t)
  const original=device.importSource(fixture)
  account.apply([original])
  const removal=account.remove(original.id)
  assert.equal(account.apply([original]),false)
  assert.deepEqual(account.list(),[])
  const [source]=account.missingFrom(device)
  const restored=account.importSource(source)
  assert.ok(restored.updatedAt>removal.updatedAt)
  assert.equal(account.apply([removal]),false)
  assert.deepEqual(account.list(),device.list())
  assert.deepEqual(account.missingFrom(device),[])
  const ref=titleID(source.id,'/series/example')
  assert.equal(account.browserAddress(source.id,ref),source.origin+'/series/example')
  assert.throws(()=>account.browserAddress(source.id,'https://other.example/'))
  assert.throws(()=>account.browserAddress('missing',ref))
})

test('browser checks are reported even with a successful HTTP status',async()=>{
  assert.equal(browserCheck({'CF-Mitigated':['challenge']}).code,'browser-check')
  assert.equal(browserCheck({'server':['cloudflare']}),undefined)
  const result=await checkSource(fixture.origin,{detectBlock:()=>false,
    fetcher:async()=>new Response('<html></html>',{status:200,headers:{'cf-mitigated':'challenge'}})})
  assert.equal(result.code,'browser-check')
})

test('adding a domain preserves the existing rules and catalog references after removal',async t=>{
  const device=setup(t),account=setup(t)
  device.importSource(fixture)
  account.apply(device.records())
  account.remove(fixture.id)
  const known=await account.resolveDomain('KATALOG.EXAMPLE.ORG/',device,()=>assert.fail('unexpected network request'))
  assert.deepEqual(known,device.sourceByOrigin(fixture.origin))
  account.importSource(known)
  assert.equal(account.has(titleID(fixture.id,'/example')),true)
})

test('new domains accept published catalogs and plain domains, including while offline',async t=>{
  const catalog=setup(t)
  const resolve=(domain,info)=>catalog.resolveDomain(domain,catalog,async()=>info)
  const manifest={kind:'catalog',source:fixture}
  assert.deepEqual(await resolve('katalog.example.org',manifest),fixture)
  await assert.rejects(resolve('other.example.org',manifest),/anderen Domain/)
  for (const invalid of ['other.example.org/path','https://name:pw@other.example.org','http://other.example.org','file:///test','other.example.org?key=value','example']) {
    await assert.rejects(resolve(invalid,manifest))
  }
  const fallback=await resolve('other.example.org',{kind:'unreachable'})
  assert.deepEqual(fallback,await resolve('https://OTHER.example.org/',{kind:'website'}))
  assert.equal(fallback.origin,'https://other.example.org')
  assert.deepEqual(fallback.mediaHosts,['other.example.org'])
  assert.equal(catalog.importSource(fallback).id,fallback.id)
})

test('catalog search keeps partial results and can recover after an index failure',async t=>{
  let blocked=true, status=403
  const issue=browserCheck({'cf-mitigated':['challenge']})
  const url=fixture.origin+'/42-example.html'
  const catalog=setup(t,{
    makeView:()=>{
      const view=new EventEmitter()
      view.loadURL=async()=>{if (blocked) view.emit('catalog-browser-check',issue)}
      view.getURL=()=>fixture.origin
      view.executeJavaScriptInIsolatedWorld=async()=>({ready:true,items:[{title:'Example',url}]})
      view.isDestroyed=()=>false
      view.close=()=>{}
      return view
    },
    fetcher:async()=>status===403 ? new Response(null,{status,headers:{'cf-mitigated':'challenge'}}) :
      new Response('<urlset><url><loc>'+fixture.origin+'/123-another-example.html</loc></url></urlset>')
  })
  catalog.importSource(fixture)
  const failure=await catalog.searchResults('example')
  assert.equal(failure.items.length,0)
  assert.deepEqual(failure.issues.map(x=>x.issueCode),['browser-check'])
  blocked=false
  const partial=await catalog.searchResults('example')
  assert.equal(partial.items.length,1)
  assert.equal(partial.issues.length,1)
  status=200
  const full=await catalog.searchResults('example')
  assert.equal(full.items.length,2)
  assert.deepEqual(full.issues,[])
  assert.deepEqual(await catalog.searchResults('absent'),{items:[],issues:[]})
})
