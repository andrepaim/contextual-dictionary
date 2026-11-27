// Serves staged release folders on 127.0.0.1 as GET /releases/<tag>/<file>, for the measurement builds of
// bench_build.sh only. A staged folder is what `node scripts/publish-assets.mjs --dry-run --out=DIR` leaves.
//   node validation/candidate-model/release_server.mjs PORT TAG=DIR [TAG=DIR ...]
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
const [port, ...specs] = process.argv.slice(2)
if (!port || port === '-h' || port === '--help' || !specs.length) {
  console.error('usage: node release_server.mjs PORT TAG=DIR [TAG=DIR ...]')
  process.exit(port === '-h' || port === '--help' ? 0 : 2)
}
const roots = Object.fromEntries(specs.map(spec => spec.split('=')))
http.createServer((req, res) => {
  const match = /^\/releases\/([^/]+)\/([^/?]+)$/.exec(req.url ?? '')
  const root = match && roots[match[1]]
  const file = root && path.join(root, decodeURIComponent(match[2]))
  if (!file || path.dirname(file) !== path.resolve(root) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': fs.statSync(file).size })
  fs.createReadStream(file).pipe(res)
}).listen(Number(port), '127.0.0.1', () => console.log(`serving ${JSON.stringify(roots)} on ${port}`))
