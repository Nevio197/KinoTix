const sax = require('sax')

async function readSitemap(body, onAddress) {
  const parser = sax.parser(true, {xmlns:true})
  const stack = []
  let namespace, address = '', reading = false, bytes = 0
  const invalid = () => { throw new Error('Der Suchindex enthält kein gültiges XML-Titelverzeichnis.') }
  parser.ondoctype = invalid
  parser.onerror = invalid
  parser.onopentag = node => {
    if (!stack.length) {
      if (node.local !== 'urlset') invalid()
      namespace = node.uri
    }
    stack.push(node.uri === namespace ? node.local : '')
    if (stack.length === 3 && stack[1] === 'url' && stack[2] === 'loc') {
      reading = true
      address = ''
    } else if (reading) reading = false
  }
  parser.ontext = parser.oncdata = value => {
    if (reading) {
      if (address.length + value.length > 4096) reading = false
      else address += value
    }
  }
  parser.onclosetag = () => {
    if (reading && stack.length === 3) {
      onAddress(address.trim())
      reading = false
    }
    stack.pop()
  }
  const decoder = new TextDecoder()
  for await (const chunk of body) {
    bytes += chunk.byteLength
    if (bytes > 14*1024*1024) throw new Error('Der Suchindex ist größer als 14 MB.')
    parser.write(decoder.decode(chunk,{stream:true}))
  }
  parser.write(decoder.decode()).close()
  if (namespace === undefined) invalid()
}

module.exports = {readSitemap}
