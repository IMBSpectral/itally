import { env } from './env'
import { migrate } from './migrate'
import { createApp } from './app'
import { createXmlApp } from './xml/gateway'
import { serve, tlsFromEnv } from './serve'

await migrate()
serve(createApp(env.staticDir), env.port, env.host, tlsFromEnv(), (url) => console.log(`api listening on ${url}`))
// the XML gateway is optional: if its port is taken (e.g. by TallyPrime itself), keep running without it
createXmlApp()
  .listen(env.xmlPort, env.host, () => console.log(`Tally XML gateway on http://${env.host}:${env.xmlPort}`))
  .on('error', (err: NodeJS.ErrnoException) => console.warn(`Tally XML gateway not started (${err.code ?? err.message})`))
