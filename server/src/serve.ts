/**
 * Serving the app: plain HTTP on the loopback by default; with TLS_CERT and TLS_KEY (PEM files) it
 * is HTTPS, as it should be when HOST=0.0.0.0 lets other PCs sign in over the network.
 */
import { readFileSync } from 'node:fs'
import { createServer as createHttps } from 'node:https'
import { createServer as createHttp, type RequestListener, type Server } from 'node:http'

export interface Tls {
  cert: string // PEM
  key: string
}

/** The certificate and key named by TLS_CERT and TLS_KEY, if both are set. */
export function tlsFromEnv(env: NodeJS.ProcessEnv = process.env): Tls | undefined {
  if (!env.TLS_CERT && !env.TLS_KEY) return undefined
  if (!env.TLS_CERT || !env.TLS_KEY) throw new Error('Set both TLS_CERT and TLS_KEY (PEM files) to serve HTTPS')
  return { cert: readFileSync(env.TLS_CERT, 'utf8'), key: readFileSync(env.TLS_KEY, 'utf8') }
}

export function serve(app: RequestListener, port: number, host: string, tls?: Tls, ready?: (url: string) => void): Server {
  const server = tls ? createHttps({ cert: tls.cert, key: tls.key }, app) : createHttp(app)
  return server.listen(port, host, () => ready?.(`${tls ? 'https' : 'http'}://${host}:${(server.address() as { port: number }).port}`))
}
