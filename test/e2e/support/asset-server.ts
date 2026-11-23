// A loopback release server for the downloads. Like GitHub, a release URL
// answers with a redirect to the file's storage address. Each file can be
// made to fail: drop the connection halfway, serve altered bytes of the same
// size, or hold halfway until the test releases it.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { TAG, type AssetFixture } from './assets'

export type Behaviour = 'ok' | 'drop' | 'wrong' | 'hold'

export interface AssetServer {
  url: string
  /** Published names requested, in order (the release URLs, not the redirects). */
  requests: string[]
  behave(name: string, behaviour: Behaviour): void
  /** Lets held downloads continue. */
  release(): void
  close(): Promise<void>
}

const CHUNK = 64 * 1024

export async function startAssetServer(fixture: AssetFixture, options: { port?: number } = {}): Promise<AssetServer> {
  const requests: string[] = []
  const behaviours = new Map<string, Behaviour>()
  let release!: () => void
  let held = new Promise<void>(resolve => { release = resolve })
  const sockets = new Set<import('node:net').Socket>()

  const server = http.createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
    const published = path.match(new RegExp(`^/${TAG}/([^/]+)$`))
    if (published && fixture.bodies.has(published[1]!)) {
      requests.push(published[1]!)
      response.writeHead(302, { location: `/storage/${encodeURIComponent(published[1]!)}`, 'cache-control': 'no-store' }).end()
      return
    }
    const stored = path.match(/^\/storage\/([^/]+)$/)
    const body = stored ? fixture.bodies.get(stored[1]!) : undefined
    if (!stored || !body) { response.writeHead(404).end(); return }
    const behaviour = behaviours.get(stored[1]!) ?? 'ok'
    let data = body
    if (behaviour === 'wrong') { data = body.slice(); data[data.length >> 1] ^= 0xff }
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(data.length), 'cache-control': 'no-store' })
    let closed = false
    response.on('close', () => { closed = true })
    const half = data.length >> 1
    for (let at = 0; at < data.length && !closed; at += CHUNK) {
      if (at >= half && behaviour === 'drop') { request.socket.destroy(); return }
      if (at >= half && behaviour === 'hold') await held
      if (closed) return
      const chunk = data.subarray(at, Math.min(data.length, at + CHUNK))
      if (!response.write(chunk)) await new Promise(resolve => response.once('drain', resolve))
    }
    response.end()
  })
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise<void>(resolve => server.listen(options.port ?? 0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    behave: (name, behaviour) => { behaviours.set(name, behaviour) },
    release: () => { release(); held = new Promise<void>(resolve => { release = resolve }) },
    close: () => new Promise<void>(resolve => {
      release()
      for (const socket of sockets) socket.destroy()
      server.close(() => resolve())
    }),
  }
}
