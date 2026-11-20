const dgram = require('node:dgram')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const {randomUUID} = require('node:crypto')
const {fileURLToPath} = require('node:url')
const {DOMParser} = require('@xmldom/xmldom')

const group = '239.255.255.250'
const transport = 'urn:schemas-upnp-org:service:AVTransport:'
const deviceType = 'urn:schemas-upnp-org:device:MediaRenderer:1'
const message = Buffer.from(['M-SEARCH * HTTP/1.1','HOST: '+group+':1900','MAN: "ssdp:discover"','MX: 2','ST: '+deviceType,'',''].join('\r\n'))
const types = {'.mp4':'video/mp4','.m4v':'video/mp4','.webm':'video/webm','.mov':'video/quicktime','.ogv':'video/ogg'}
const xmlEscape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'})[c])
const xml = text => new DOMParser({onError:(level,message)=>{if(level!=='warning') throw Error(message)}}).parseFromString(text,'application/xml')

function deviceUrl(value, address, base) {
  const url = new URL(value,base)
  if (!['http:','https:'].includes(url.protocol) || url.hostname!==address || url.username || url.password || url.hash) {
    throw Error('Die Geräteadresse ist ungültig.')
  }
  return url.href
}
async function description(location,remote,local) {
  const response = await fetch(deviceUrl(location,remote),{redirect:'error',signal:AbortSignal.timeout(3000)})
  if (!response.ok) return null
  const chunks=[]
  let bytes=0
  for await (const chunk of response.body) {
    bytes+=chunk.length
    if (bytes>256*1024) throw Error('Die Gerätebeschreibung ist zu groß.')
    chunks.push(chunk)
  }
  const document=xml(Buffer.concat(chunks).toString('utf8'))
  const field=(node,name)=>node.getElementsByTagName(name).item(0)?.textContent?.trim()
  const base=field(document,'URLBase') || location
  for (const device of Array.from(document.getElementsByTagName('device'))) {
    if (!/^urn:schemas-upnp-org:device:MediaRenderer:\d+$/.test(field(device,'deviceType'))) continue
    for (const service of Array.from(device.getElementsByTagName('service'))) {
      const type=field(service,'serviceType')
      const control=field(service,'controlURL')
      if (control && type?.startsWith(transport) && /^\d+$/.test(type.slice(transport.length))) {
        return {name:(field(device,'friendlyName') || 'Fernseher').slice(0,120),type,control:deviceUrl(control,remote,base),local,remote}
      }
    }
  }
  return null
}
function discoverOn(network) {
  return new Promise(resolve=>{
    const socket=dgram.createSocket('udp4')
    const pending=new Map()
    const finish=()=>{
      clearTimeout(timer)
      try { socket.close() } catch {}
      Promise.all(pending.values()).then(found=>resolve(found.filter(Boolean)))
    }
    const timer=setTimeout(finish,2600)
    socket.once('error',finish)
    socket.on('message',(packet,peer)=>{
      const ip = s=>s.split('.').reduce((n,b)=>(n<<8)|Number(b),0)
      if ((ip(peer.address)&ip(network.netmask)) !== (ip(network.address)&ip(network.netmask))) return
      const location=/^location:\s*([^\s]+)\s*$/im.exec(packet.toString('ascii'))?.[1]
      if (!location || pending.has(location) || pending.size>=32) return
      pending.set(location,description(location,peer.address,network.address).catch(()=>null))
    })
    socket.bind(0,network.address,()=>{
      try {
        socket.setMulticastInterface(network.address)
        socket.setMulticastTTL(1)
        socket.send(message,1900,group)
      } catch { finish() }
    })
  })
}
async function discover() {
  const networks=Object.values(os.networkInterfaces()).flat().filter(item=>item?.family==='IPv4' && !item.internal)
  const found=(await Promise.all(networks.map(discoverOn))).flat()
  return [...new Map(found.map(device=>[device.control,device])).values()]
}
async function soap(device,action,args) {
  const fields=Object.entries({InstanceID:0,...args}).map(([name,value])=>'<'+name+'>'+xmlEscape(value)+'</'+name+'>').join('')
  const body='<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:'+action+' xmlns:u="'+device.type+'">'+fields+'</u:'+action+'></s:Body></s:Envelope>'
  const response=await fetch(device.control,{method:'POST',body,redirect:'error',signal:AbortSignal.timeout(5000),
    headers:{'Content-Type':'text/xml; charset="utf-8"',SOAPAction:'"'+device.type+'#'+action+'"'}})
  await response.body?.cancel()
  if (!response.ok) throw Error('Der Fernseher hat den Befehl '+action+' abgelehnt (HTTP '+response.status+').')
}
async function shareFile(url,device) {
  const filename=fileURLToPath(url)
  const {size}=await fs.promises.stat(filename)
  const suffix=path.extname(filename).toLowerCase()
  if (!types[suffix] || !size) throw Error('Diese Datei kann nicht an den Fernseher gesendet werden.')
  const route='/'+randomUUID()+suffix
  const server=http.createServer((req,res)=>{
    if (req.socket.remoteAddress!==device.remote || req.url!==route || !['GET','HEAD'].includes(req.method)) {
      return res.writeHead(404).end()
    }
    let start=0,end=size-1
    const headers={'Content-Type':types[suffix],'Accept-Ranges':'bytes','transferMode.dlna.org':'Streaming'}
    if (req.headers.range) {
      const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range)
      if (match?.[1]) { start=Number(match[1]); if (match[2]) end=Math.min(end,Number(match[2])) }
      else if (match?.[2]) start=Math.max(0,size-Number(match[2]))
      if (!match || !(match[1] || match[2]) || !Number.isSafeInteger(start) || start>end) return res.writeHead(416,{'Content-Range':'bytes */'+size}).end()
      headers['Content-Range']='bytes '+start+'-'+end+'/'+size
    }
    headers['Content-Length']=end-start+1
    res.writeHead(req.headers.range?206:200,headers)
    if (req.method==='HEAD') return res.end()
    const stream=fs.createReadStream(filename,{start,end})
    stream.on('error',()=>res.destroy())
    res.on('close',()=>stream.destroy())
    stream.pipe(res)
  })
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,device.local,resolve)})
  return {url:'http://'+device.local+':'+server.address().port+route,
    close(){ server.close(); server.closeAllConnections() }}
}
function createTvPlayback(discovery=discover) {
  const devices=new Map(), sessions=new Map(), playing=new Set()
  let lookup, generation=0
  return {
    async list() {
      lookup ??= discovery().then(found=>{
        devices.clear()
        for (const device of found) devices.set(randomUUID(),device)
        return Array.from(devices,([id,device])=>({id,name:device.name}))
      }).finally(()=>{lookup=undefined})
      return lookup
    },
    async play(id,url,title,seconds) {
      const device=devices.get(id)
      if (!device) throw Error('Suche den Fernseher erneut.')
      if (playing.has(device.control)) throw Error('Eine Wiedergabe wird bereits gestartet.')
      playing.add(device.control)
      const current=generation
      let share
      try {
        const media=new URL(url)
        if (media.protocol==='file:') share=await shareFile(media,device)
        else if (media.protocol!=='https:' || media.password || media.username) throw Error('Die Quelle ist für den Fernseher nicht verfügbar.')
        const address=share?.url || media.href
        const mime=types[path.extname(media.pathname).toLowerCase()] || 'video/*'
        const meta='<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="1" parentID="0" restricted="1"><dc:title>'+xmlEscape(title)+'</dc:title><upnp:class>object.item.videoItem</upnp:class><res protocolInfo="http-get:*:'+mime+':*">'+xmlEscape(address)+'</res></item></DIDL-Lite>'
        if (generation!==current) throw Error('Das Profil hat sich geändert.')
        await soap(device,'SetAVTransportURI',{CurrentURI:address,CurrentURIMetaData:meta})
        await soap(device,'Play',{Speed:'1'})
        let resumed=false
        if (seconds>=1) {
          const time=[Math.floor(seconds/3600),Math.floor(seconds/60)%60,Math.floor(seconds)%60].map(n=>String(n).padStart(2,'0')).join(':')
          try { await soap(device,'Seek',{Unit:'REL_TIME',Target:time}); resumed=true } catch {}
        }
        if (generation!==current) throw Error('Das Profil hat sich geändert.')
        sessions.get(device.control)?.close()
        if (share) sessions.set(device.control,share)
        else sessions.delete(device.control)
        share=undefined
        return {name:device.name,resumed}
      } finally { share?.close(); playing.delete(device.control) }
    },
    close() { generation++; for (const share of sessions.values()) share.close(); sessions.clear() }
  }
}
module.exports={createTvPlayback}
