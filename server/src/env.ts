import 'dotenv/config'

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing environment variable ${name} (copy server/.env.example to server/.env)`)
  return v
}

// `node --test` runs each test file with NODE_TEST_CONTEXT set; tests get their own database
const testing = Boolean(process.env.NODE_TEST_CONTEXT)

export const env = {
  databaseUrl: testing ? required('TEST_DATABASE_URL') : required('DATABASE_URL'),
  port: Number(process.env.PORT ?? 4100),
  // loopback only unless told otherwise; set HOST=0.0.0.0 to serve other PCs (multi-user)
  host: process.env.HOST ?? '127.0.0.1',
  staticDir: process.env.STATIC_DIR || undefined,
  xmlPort: Number(process.env.XML_PORT ?? 9010),
}
