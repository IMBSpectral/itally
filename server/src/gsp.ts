/**
 * e-Invoice (IRP) and e-Way Bill through the government's API, directly with NIC or through a GSP
 * that passes NIC's API on. NIC's protocol, as its API documents give it:
 *
 *   sign in   the user name, password and a fresh 32-byte AppKey, as JSON, base64 and encrypted
 *             with the portal's RSA public key (PKCS#1 v1.5); the answer carries an AuthToken and a
 *             session key (SEK) encrypted with the AppKey (AES-256-ECB).
 *   a call    its JSON encrypted with the SEK (AES-256-ECB, PKCS#7), base64, as { Data } for the
 *             IRP or { action, data } for the e-Way Bill system; the answer's data decrypted with
 *             the SEK. A session lasts six hours; an expired token signs in again once.
 *
 * Everything a GSP adds of its own (its address, its headers) is in the settings, so going live
 * is a matter of entering the credentials. What the portals give back is stored as an upload's
 * answer would be (saveEDocument), and every call is logged.
 */
import { constants, createCipheriv, createDecipheriv, publicEncrypt, randomBytes } from 'node:crypto'
import { pool } from './db'
import { ValidationError } from './books'
import { edocInput, saveEDocument } from './edocs'
import { einvoiceJson, einvoiceProblems, ewayBill, ewayProblems } from './engine/edocs'

// ------------------------------------------------------------------ the ciphers

export const rsaEncrypt = (pem: string, data: Buffer) => publicEncrypt({ key: pem, padding: constants.RSA_PKCS1_PADDING }, data)
export function aesEncrypt(key: Buffer, data: Buffer) {
  const c = createCipheriv('aes-256-ecb', key, null)
  return Buffer.concat([c.update(data), c.final()])
}
export function aesDecrypt(key: Buffer, data: Buffer) {
  const d = createDecipheriv('aes-256-ecb', key, null)
  return Buffer.concat([d.update(data), d.final()])
}

// ------------------------------------------------------------------ settings

export interface GspSettings {
  environment: 'sandbox' | 'production'
  einvoiceBase: string // e.g. https://einv-apisandbox.nic.in, or the GSP's address for it
  ewayBase: string
  clientId: string
  clientSecret: string
  einvoiceUser: string
  einvoicePassword: string
  ewayUser?: string | null
  ewayPassword?: string | null
  publicKey: string
  ewayPublicKey?: string | null
  extraHeaders?: Record<string, string>
}
const SECRETS = ['clientSecret', 'einvoicePassword', 'ewayPassword'] as const

async function loadSettings(companyId: number): Promise<GspSettings | null> {
  return (await pool.query<GspSettings>(
    `SELECT environment, einvoice_base "einvoiceBase", eway_base "ewayBase", client_id "clientId", client_secret "clientSecret", einvoice_user "einvoiceUser",
            einvoice_password "einvoicePassword", eway_user "ewayUser", eway_password "ewayPassword", public_key "publicKey", eway_public_key "ewayPublicKey",
            extra_headers "extraHeaders"
       FROM gsp_settings WHERE company_id = $1`,
    [companyId],
  )).rows[0] ?? null
}

/** The settings for the screens: whether each secret is set, never the secret itself. */
export async function gspSettings(companyId: number) {
  const s = await loadSettings(companyId)
  if (!s) return null
  const { clientSecret: _a, einvoicePassword: _b, ewayPassword: _c, ...shown } = s
  return { ...shown, clientSecretSet: !!s.clientSecret, einvoicePasswordSet: !!s.einvoicePassword, ewayPasswordSet: !!s.ewayPassword }
}

/** Save the settings; a secret left blank keeps the one saved. A change signs in afresh. */
export async function setGspSettings(companyId: number, input: Partial<GspSettings> & Omit<GspSettings, (typeof SECRETS)[number]>) {
  const cur = await loadSettings(companyId)
  const s = { ...input } as GspSettings
  for (const k of SECRETS) if (!s[k]) (s as unknown as Record<string, unknown>)[k] = cur?.[k] ?? null
  const errors: string[] = []
  for (const [k, label] of [['einvoiceBase', 'the e-Invoice API address'], ['ewayBase', 'the e-Way Bill API address']] as const)
    if (!/^https:\/\/[^\s]+$/.test(s[k] ?? '') && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(s[k] ?? '')) errors.push(`Give ${label} (https://…)`)
  if (!s.clientId?.trim()) errors.push('Give the client id')
  if (!s.clientSecret) errors.push('Give the client secret')
  if (!s.einvoiceUser?.trim() || !s.einvoicePassword) errors.push('Give the e-Invoice API user name and password')
  for (const [k, label] of [['publicKey', 'the e-Invoice public key'], ['ewayPublicKey', 'the e-Way Bill public key']] as const) {
    const pem = s[k]
    if (!pem) continue
    try {
      rsaEncrypt(pem, Buffer.from('x'))
    } catch {
      errors.push(`${label} is not a public key in PEM form (-----BEGIN PUBLIC KEY-----)`)
    }
  }
  if (!s.publicKey) errors.push('Paste the e-Invoice public key the portal gives (PEM)')
  if (errors.length) throw new ValidationError(errors)
  await pool.query(
    `INSERT INTO gsp_settings (company_id, environment, einvoice_base, eway_base, client_id, client_secret, einvoice_user, einvoice_password, eway_user, eway_password,
                               public_key, eway_public_key, extra_headers, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
     ON CONFLICT (company_id) DO UPDATE SET environment = $2, einvoice_base = $3, eway_base = $4, client_id = $5, client_secret = $6, einvoice_user = $7,
       einvoice_password = $8, eway_user = $9, eway_password = $10, public_key = $11, eway_public_key = $12, extra_headers = $13, updated_at = now()`,
    [companyId, s.environment, s.einvoiceBase.replace(/\/+$/, ''), s.ewayBase.replace(/\/+$/, ''), s.clientId.trim(), s.clientSecret, s.einvoiceUser.trim(), s.einvoicePassword,
      s.ewayUser?.trim() || null, s.ewayPassword || null, s.publicKey.trim(), s.ewayPublicKey?.trim() || null, JSON.stringify(s.extraHeaders ?? {})],
  )
  await pool.query(`DELETE FROM gsp_sessions WHERE company_id = $1`, [companyId])
}

// ------------------------------------------------------------------ the calls

type System = 'einvoice' | 'eway'
const PATHS = {
  einvoiceAuth: '/eivital/v1.04/auth',
  invoice: '/eicore/v1.03/Invoice',
  cancelIrn: '/eicore/v1.03/Invoice/Cancel',
  irnByDoc: '/eicore/v1.03/Invoice/irnbydocdetails',
  ewbByIrn: '/eiewb/v1.03/ewaybill',
  ewayAuth: '/ewaybillapi/v1.03/auth',
  ewayApi: '/ewaybillapi/v1.03/ewayapi',
}

export class GspError extends ValidationError {}
const errorsOf = (body: { ErrorDetails?: { ErrorCode?: string; ErrorMessage?: string }[] | null; error?: unknown; message?: string }) => {
  if (Array.isArray(body.ErrorDetails) && body.ErrorDetails.length) return body.ErrorDetails.map((e) => `${e.ErrorCode ?? ''} ${e.ErrorMessage ?? ''}`.trim())
  if (body.error) return [typeof body.error === 'string' ? body.error : JSON.stringify(body.error)]
  return [body.message ?? 'The portal refused the request']
}

async function log(companyId: number, system: System, action: string, voucherId: number | null, ok: boolean, message: string) {
  await pool.query(`INSERT INTO gsp_log (company_id, system, action, voucher_id, ok, message) VALUES ($1,$2,$3,$4,$5,$6)`,
    [companyId, system, action, voucherId, ok, message.slice(0, 2000)])
}

async function post(url: string, headers: Record<string, string>, body: unknown, method: 'POST' | 'GET' = 'POST') {
  let res: Response
  try {
    res = await fetch(url, { method, headers: { 'content-type': 'application/json', accept: 'application/json', ...headers }, body: method === 'POST' ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000) })
  } catch (e) {
    throw new GspError([`The portal could not be reached (${(e as Error).message})`])
  }
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new GspError([`The portal answered ${res.status} with something that is not JSON: ${text.slice(0, 200)}`])
  }
}

const baseHeaders = (s: GspSettings, gstin: string) => ({ client_id: s.clientId, client_secret: s.clientSecret, Gstin: gstin, ...(s.extraHeaders ?? {}) })

/** A session with a system: the stored one while it lasts, else a fresh sign-in. */
async function session(companyId: number, s: GspSettings, system: System, gstin: string, fresh = false) {
  if (!fresh) {
    const r = (await pool.query<{ authToken: string; sek: string }>(
      `SELECT auth_token "authToken", sek FROM gsp_sessions WHERE company_id = $1 AND system = $2 AND expires_at > now() + interval '5 minutes'`, [companyId, system])).rows[0]
    if (r) return { authToken: r.authToken, sek: Buffer.from(r.sek, 'base64') }
  }
  const appKey = randomBytes(32)
  let authToken: string
  let sekEnc: string
  let expires: Date
  if (system === 'einvoice') {
    const payload = Buffer.from(JSON.stringify({ UserName: s.einvoiceUser, Password: s.einvoicePassword, AppKey: appKey.toString('base64'), ForceRefreshAccessToken: true }))
    const body = await post(s.einvoiceBase + PATHS.einvoiceAuth, baseHeaders(s, gstin), { Data: rsaEncrypt(s.publicKey, Buffer.from(payload.toString('base64'))).toString('base64') })
    if (String(body.Status) !== '1') {
      await log(companyId, system, 'sign in', null, false, errorsOf(body).join('; '))
      throw new GspError(['e-Invoice sign-in failed: ' + errorsOf(body).join('; ')])
    }
    authToken = body.Data.AuthToken
    sekEnc = body.Data.Sek
    expires = body.Data.TokenExpiry ? new Date(String(body.Data.TokenExpiry).replace(' ', 'T') + '+05:30') : new Date(Date.now() + 6 * 3600_000)
  } else {
    if (!s.ewayUser || !s.ewayPassword) throw new GspError(['Give the e-Way Bill API user name and password (GSP settings)'])
    const key = s.ewayPublicKey || s.publicKey
    const body = await post(s.ewayBase + PATHS.ewayAuth, { 'client-id': s.clientId, 'client-secret': s.clientSecret, gstin, ...(s.extraHeaders ?? {}) }, {
      action: 'ACCESSTOKEN', username: s.ewayUser,
      password: rsaEncrypt(key, Buffer.from(s.ewayPassword)).toString('base64'), app_key: rsaEncrypt(key, Buffer.from(appKey.toString('base64'))).toString('base64'),
    })
    if (String(body.status) !== '1') {
      await log(companyId, system, 'sign in', null, false, errorsOf(body).join('; '))
      throw new GspError(['e-Way Bill sign-in failed: ' + errorsOf(body).join('; ')])
    }
    authToken = body.authtoken
    sekEnc = body.sek
    expires = new Date(Date.now() + 6 * 3600_000)
  }
  // the SEK comes encrypted with the AppKey
  const sek = aesDecrypt(appKey, Buffer.from(sekEnc, 'base64'))
  await pool.query(
    `INSERT INTO gsp_sessions (company_id, system, auth_token, sek, expires_at) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (company_id, system) DO UPDATE SET auth_token = $3, sek = $4, expires_at = $5`,
    [companyId, system, authToken, sek.toString('base64'), expires],
  )
  await log(companyId, system, 'sign in', null, true, `session until ${expires.toISOString()}`)
  return { authToken, sek }
}

/** One IRP call with its JSON encrypted by the session key; an expired token signs in again once. */
async function irp(companyId: number, s: GspSettings, gstin: string, path: string, data: unknown | null, query = '') {
  for (const fresh of [false, true]) {
    const { authToken, sek } = await session(companyId, s, 'einvoice', gstin, fresh)
    const headers = { ...baseHeaders(s, gstin), user_name: s.einvoiceUser, AuthToken: authToken }
    const body = data === null
      ? await post(s.einvoiceBase + path + query, headers, null, 'GET')
      : await post(s.einvoiceBase + path, headers, { Data: aesEncrypt(sek, Buffer.from(JSON.stringify(data))).toString('base64') })
    if (String(body.Status) === '1') return JSON.parse(aesDecrypt(sek, Buffer.from(body.Data, 'base64')).toString('utf8'))
    const errs = errorsOf(body)
    // 1005: the token is not valid (expired, or signed in elsewhere)
    if (!fresh && errs.some((e) => /^1005\b/.test(e))) continue
    throw new GspError(errs)
  }
  throw new GspError(['The portal kept refusing the session'])
}

/** One e-Way Bill call: { action, data } with the data encrypted by the session key. */
async function ewayCall(companyId: number, s: GspSettings, gstin: string, action: string, data: unknown) {
  for (const fresh of [false, true]) {
    const { authToken, sek } = await session(companyId, s, 'eway', gstin, fresh)
    const headers = { 'client-id': s.clientId, 'client-secret': s.clientSecret, gstin, authtoken: authToken, ...(s.extraHeaders ?? {}) }
    const body = await post(s.ewayBase + PATHS.ewayApi, headers, { action, data: aesEncrypt(sek, Buffer.from(Buffer.from(JSON.stringify(data)).toString('base64'))).toString('base64') })
    if (String(body.status) === '1') {
      const plain = aesDecrypt(sek, Buffer.from(body.data, 'base64')).toString('utf8')
      return JSON.parse(/^[A-Za-z0-9+/=]+$/.test(plain) ? Buffer.from(plain, 'base64').toString('utf8') : plain)
    }
    const errs = errorsOf(body)
    if (!fresh && errs.some((e) => /\b238\b|invalid auth token/i.test(e))) continue
    throw new GspError(errs)
  }
  throw new GspError(['The portal kept refusing the session'])
}

async function settingsFor(companyId: number) {
  const s = await loadSettings(companyId)
  if (!s) throw new GspError(['Set up the GSP first (Company, GSP Settings): the API addresses, client id and secret, user names and passwords'])
  return s
}
const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`
const isoOfPortal = (s: string | null | undefined) => {
  if (!s) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(s) ?? null
  if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`
  // the e-Way Bill system writes "07/07/2026 11:59:00 PM"
  const d = /^(\d{2})\/(\d{2})\/(\d{4})(?: (\d{1,2}):(\d{2})(?::\d{2})?(?: ?([AP]M))?)?/i.exec(s)
  if (!d) return s
  let hour = d[4] ? Number(d[4]) : null
  if (hour !== null && d[6]) hour = (hour % 12) + (/pm/i.test(d[6]) ? 12 : 0)
  return `${d[3]}-${d[2]}-${d[1]}${hour !== null ? ` ${String(hour).padStart(2, '0')}:${d[5]}` : ''}`
}

// ------------------------------------------------------------------ what the screens ask for

/** Sign in to both systems, to check the settings. */
export async function testGsp(companyId: number, gstin: string) {
  const s = await settingsFor(companyId)
  const out: Record<string, string> = {}
  for (const system of ['einvoice', 'eway'] as const) {
    if (system === 'eway' && !s.ewayUser) {
      out[system] = 'not set up'
      continue
    }
    try {
      await session(companyId, s, system, gstin, true)
      out[system] = 'signed in'
    } catch (e) {
      out[system] = (e as ValidationError).errors?.join('; ') ?? String(e)
    }
  }
  return out
}

/**
 * Generate the IRN of a sale or note: the e-Invoice JSON, checked as for an upload, sent to the
 * IRP; the IRN, acknowledgement, signed QR code (and an e-Way Bill made with it) are stored. An
 * invoice the IRP already has (error 2150) is fetched by its document number instead.
 */
export async function generateIrn(companyId: number, voucherId: number) {
  const s = await settingsFor(companyId)
  const { input, record } = await edocInput(companyId, voucherId)
  if (record?.irn && !record.irnCancelled) throw new GspError([`It already has an IRN (${record.irn.slice(0, 12)}…)`])
  const problems = einvoiceProblems(input)
  if (problems.length) throw new GspError(problems)
  const gstin = input.seller.gstin!
  const doc = einvoiceJson(input)
  let r: { Irn: string; AckNo: number | string; AckDt: string; SignedQRCode: string; EwbNo?: number | string | null; EwbDt?: string | null; EwbValidTill?: string | null }
  try {
    r = await irp(companyId, s, gstin, PATHS.invoice, doc)
  } catch (e) {
    const errs = (e as ValidationError).errors ?? []
    if (!errs.some((x) => /^2150\b/.test(x))) {
      await log(companyId, 'einvoice', 'generate IRN', voucherId, false, errs.join('; '))
      throw e
    }
    r = await irp(companyId, s, gstin, PATHS.irnByDoc, null, `?doctype=${doc.DocDtls.Typ}&docnum=${encodeURIComponent(doc.DocDtls.No)}&docdate=${doc.DocDtls.Dt}`)
  }
  const saved = await saveEDocument(companyId, voucherId, {
    irn: r.Irn, ackNo: String(r.AckNo), ackDate: isoOfPortal(r.AckDt), signedQr: r.SignedQRCode, irnCancelled: false,
    ...(r.EwbNo ? { ewbNo: String(r.EwbNo), ewbDate: isoOfPortal(r.EwbDt), ewbValidUpto: isoOfPortal(r.EwbValidTill) } : {}),
  })
  await log(companyId, 'einvoice', 'generate IRN', voucherId, true, `IRN ${r.Irn}, ack ${r.AckNo}`)
  return saved
}

/** Cancel an IRN (within 24 hours of it, the IRP's rule): 1 duplicate, 2 data entry mistake, 3 order cancelled, 4 other. */
export async function cancelIrn(companyId: number, voucherId: number, reason: '1' | '2' | '3' | '4', remark: string) {
  const s = await settingsFor(companyId)
  const { input, record } = await edocInput(companyId, voucherId)
  if (!record?.irn || record.irnCancelled) throw new GspError(['There is no IRN to cancel'])
  try {
    await irp(companyId, s, input.seller.gstin!, PATHS.cancelIrn, { Irn: record.irn, CnlRsn: reason, CnlRem: remark.trim().slice(0, 100) || 'Cancelled' })
  } catch (e) {
    await log(companyId, 'einvoice', 'cancel IRN', voucherId, false, ((e as ValidationError).errors ?? []).join('; '))
    throw e
  }
  await log(companyId, 'einvoice', 'cancel IRN', voucherId, true, `IRN ${record.irn} cancelled`)
  return saveEDocument(companyId, voucherId, { irnCancelled: true })
}

/**
 * Generate the e-Way Bill of a voucher: by its IRN through the IRP when it has one, else through
 * the e-Way Bill system with the same JSON the bulk upload takes. The transport details stored with
 * the voucher (Part B) go with it.
 */
export async function generateEwayBill(companyId: number, voucherId: number) {
  const s = await settingsFor(companyId)
  const { input, record } = await edocInput(companyId, voucherId)
  if (record?.ewbNo) throw new GspError([`It already has e-Way Bill ${record.ewbNo}`])
  const problems = ewayProblems(input)
  if (problems.length) throw new GspError(problems)
  const gstin = (input.type === 'Purchase' ? input.buyer.gstin : input.seller.gstin)!
  const t = record?.transport
  try {
    if (record?.irn && !record.irnCancelled) {
      const r = await irp(companyId, s, gstin, PATHS.ewbByIrn, {
        Irn: record.irn, Distance: t?.distance ?? 0, TransMode: t?.mode ?? '1', TransId: t?.transporterId || undefined, TransName: t?.transporterName || undefined,
        TransDocNo: t?.docNo || undefined, TransDocDt: t?.docDate ? ddmmyyyy(t.docDate) : undefined, VehNo: t?.vehicleNo || undefined, VehType: t?.vehicleNo ? (t?.vehicleType ?? 'R') : undefined,
      })
      await log(companyId, 'einvoice', 'e-Way Bill by IRN', voucherId, true, `EWB ${r.EwbNo}`)
      return saveEDocument(companyId, voucherId, { ewbNo: String(r.EwbNo), ewbDate: isoOfPortal(r.EwbDt), ewbValidUpto: isoOfPortal(r.EwbValidTill) })
    }
    const r = await ewayCall(companyId, s, gstin, 'GENEWAYBILL', ewayBill(input))
    await log(companyId, 'eway', 'generate', voucherId, true, `EWB ${r.ewayBillNo}`)
    return saveEDocument(companyId, voucherId, { ewbNo: String(r.ewayBillNo), ewbDate: isoOfPortal(r.ewayBillDate), ewbValidUpto: isoOfPortal(r.validUpto) })
  } catch (e) {
    await log(companyId, 'eway', 'generate', voucherId, false, ((e as ValidationError).errors ?? []).join('; '))
    throw e
  }
}

/** Cancel an e-Way Bill (within 24 hours): 1 duplicate, 2 order cancelled, 3 data entry mistake, 4 others. */
export async function cancelEwayBill(companyId: number, voucherId: number, reason: '1' | '2' | '3' | '4', remark: string) {
  const s = await settingsFor(companyId)
  const { input, record } = await edocInput(companyId, voucherId)
  if (!record?.ewbNo) throw new GspError(['There is no e-Way Bill to cancel'])
  const gstin = (input.type === 'Purchase' ? input.buyer.gstin : input.seller.gstin)!
  try {
    await ewayCall(companyId, s, gstin, 'CANEWB', { ewbNo: Number(record.ewbNo), cancelRsnCode: Number(reason), cancelRmrk: remark.trim().slice(0, 50) || 'Cancelled' })
  } catch (e) {
    await log(companyId, 'eway', 'cancel', voucherId, false, ((e as ValidationError).errors ?? []).join('; '))
    throw e
  }
  await log(companyId, 'eway', 'cancel', voucherId, true, `EWB ${record.ewbNo} cancelled`)
  return saveEDocument(companyId, voucherId, { ewbNo: null, ewbDate: null, ewbValidUpto: null })
}

/** Update Part B (a new vehicle): reason 1 breakdown, 2 transhipment, 3 others, 4 first time. */
export async function updateVehicle(companyId: number, voucherId: number, u: { vehicleNo: string; fromPlace: string; fromState: string; reason: '1' | '2' | '3' | '4'; remark: string }) {
  const s = await settingsFor(companyId)
  const { input, record } = await edocInput(companyId, voucherId)
  if (!record?.ewbNo) throw new GspError(['There is no e-Way Bill to update'])
  const gstin = (input.type === 'Purchase' ? input.buyer.gstin : input.seller.gstin)!
  const vehicleNo = u.vehicleNo.replace(/[\s-]/g, '').toUpperCase()
  const t = record.transport
  const r = await ewayCall(companyId, s, gstin, 'VEHEWB', {
    ewbNo: Number(record.ewbNo), vehicleNo, fromPlace: u.fromPlace, fromState: Number(u.fromState), reasonCode: u.reason, reasonRem: u.remark.slice(0, 50) || 'Vehicle changed',
    transDocNo: t?.docNo ?? '', transDocDate: t?.docDate ? ddmmyyyy(t.docDate) : '', transMode: t?.mode ?? '1', vehicleType: t?.vehicleType ?? 'R',
  })
  await log(companyId, 'eway', 'update vehicle', voucherId, true, `EWB ${record.ewbNo}: vehicle ${vehicleNo}`)
  return saveEDocument(companyId, voucherId, { transport: { ...(t ?? { mode: '1', distance: 0 }), vehicleNo }, ...(r.validUpto ? { ewbValidUpto: isoOfPortal(r.validUpto) } : {}) })
}

export async function gspLog(companyId: number) {
  return (await pool.query(
    `SELECT l.id, to_char(l.at, 'YYYY-MM-DD HH24:MI') at, l.system, l.action, l.ok, l.message, l.voucher_id "voucherId" FROM gsp_log l
      WHERE l.company_id = $1 ORDER BY l.id DESC LIMIT 200`, [companyId])).rows
}
