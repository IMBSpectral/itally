import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { createServer, type Server } from 'node:http'
import { constants, createHash, generateKeyPairSync, privateDecrypt, randomBytes } from 'node:crypto'
import { pool } from '../src/db'
import { migrate } from '../src/migrate'
import { createApp } from '../src/app'
import { createCompany, createLedger, loadGroups, postVoucher, setCompanyDetails, setCompanyGst } from '../src/books'
import { createStockItem, createUnit, defaultGodown } from '../src/inventory'
import { aesDecrypt, aesEncrypt } from '../src/gsp'
import { gunzipSync } from 'node:zlib'

const R = (rupees: number) => Math.round(rupees * 100)

/**
 * A stand-in for NIC's IRP and e-Way Bill system, speaking their protocol: sign-in encrypted with
 * the portal's RSA public key, a session key (SEK) returned encrypted with the caller's AppKey,
 * every call's data encrypted with the SEK (AES-256-ECB).
 */
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const rsaOpen = (b64: string) => privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(b64, 'base64'))
const portal = {
  sessions: new Map<string, Buffer>(), // token -> SEK
  irns: new Map<string, { Irn: string; AckNo: number; AckDt: string; SignedQRCode: string; cancelled?: boolean }>(),
  ewbs: new Set<string>(),
  expireNext: false,
  signIns: 0,
  headers: [] as Record<string, string | string[] | undefined>[],
}
const qr = (doc: { DocDtls: { No: string; Typ: string }; SellerDtls: { Gstin: string } }, irn: string) => {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'RS256' })}.${b64({ data: JSON.stringify({ SellerGstin: doc.SellerDtls.Gstin, DocNo: doc.DocDtls.No, DocTyp: doc.DocDtls.Typ, Irn: irn }), iss: 'NIC' })}.c2ln`
}
let nic: Server
let app: Server
let api = ''
before(async () => {
  await migrate(() => {})
  nic = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null
    const send = (o: object) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o))
    const url = new URL(req.url!, 'http://x')
    portal.headers.push(req.headers)
    const irpOk = (sek: Buffer, o: object) => send({ Status: 1, Data: aesEncrypt(sek, Buffer.from(JSON.stringify(o))).toString('base64') })
    const irpErr = (code: string, msg: string) => send({ Status: 0, ErrorDetails: [{ ErrorCode: code, ErrorMessage: msg }] })
    if (url.pathname === '/eivital/v1.04/auth') {
      const creds = JSON.parse(Buffer.from(rsaOpen(body.Data).toString(), 'base64').toString())
      if (creds.Password !== 'einv-pass') return irpErr('108', 'Invalid login credentials')
      const sek = randomBytes(32)
      const token = randomBytes(8).toString('hex')
      portal.sessions.set(token, sek)
      portal.signIns++
      return send({ Status: 1, Data: { AuthToken: token, Sek: aesEncrypt(Buffer.from(creds.AppKey, 'base64'), sek).toString('base64'), TokenExpiry: '2099-01-01 00:00:00' } })
    }
    if (url.pathname.startsWith('/eicore') || url.pathname.startsWith('/eiewb')) {
      const sek = portal.sessions.get(String(req.headers.authtoken))
      if (!sek || portal.expireNext) {
        portal.expireNext = false
        return irpErr('1005', 'Invalid Token')
      }
      if (url.pathname === '/eicore/v1.03/Invoice/irnbydocdetails') {
        const r = portal.irns.get(`${url.searchParams.get('doctype')}/${url.searchParams.get('docnum')}`)
        return r ? irpOk(sek, r) : irpErr('2283', 'IRN details are not found')
      }
      const data = JSON.parse(aesDecrypt(sek, Buffer.from(body.Data, 'base64')).toString())
      if (url.pathname === '/eicore/v1.03/Invoice') {
        const key = `${data.DocDtls.Typ}/${data.DocDtls.No}`
        if (portal.irns.has(key) && !portal.irns.get(key)!.cancelled) return irpErr('2150', 'Duplicate IRN')
        const Irn = createHash('sha256').update(data.SellerDtls.Gstin + key).digest('hex')
        const r = { Irn, AckNo: 112610000000001, AckDt: '2026-07-05 12:41:00', SignedQRCode: qr(data, Irn) }
        portal.irns.set(key, r)
        return irpOk(sek, r)
      }
      if (url.pathname === '/eicore/v1.03/Invoice/Cancel') {
        const r = [...portal.irns.values()].find((x) => x.Irn === data.Irn)
        if (!r) return irpErr('2140', 'IRN not found')
        r.cancelled = true
        return irpOk(sek, { Irn: data.Irn, CancelDate: '2026-07-05 14:00:00' })
      }
      if (url.pathname === '/eiewb/v1.03/ewaybill') return irpOk(sek, { EwbNo: 341001234567, EwbDt: '2026-07-05 13:00:00', EwbValidTill: '2026-07-06 23:59:00' })
    }
    if (url.pathname === '/ewaybillapi/v1.03/auth') {
      if (rsaOpen(body.password).toString() !== 'ewb-pass') return send({ status: '0', error: { errorCodes: '108' } })
      const appKey = Buffer.from(rsaOpen(body.app_key).toString(), 'base64')
      const sek = randomBytes(32)
      const token = randomBytes(8).toString('hex')
      portal.sessions.set(token, sek)
      return send({ status: '1', authtoken: token, sek: aesEncrypt(appKey, sek).toString('base64') })
    }
    if (url.pathname === '/ewaybillapi/v1.03/ewayapi') {
      const sek = portal.sessions.get(String(req.headers.authtoken))!
      const data = JSON.parse(Buffer.from(aesDecrypt(sek, Buffer.from(body.data, 'base64')).toString(), 'base64').toString())
      const ok = (o: object) => send({ status: '1', data: aesEncrypt(sek, Buffer.from(Buffer.from(JSON.stringify(o)).toString('base64'))).toString('base64') })
      if (body.action === 'GENEWAYBILL') {
        assert.equal(data.docNo.length > 0, true)
        portal.ewbs.add('351001234568')
        return ok({ ewayBillNo: 351001234568, ewayBillDate: '05/07/2026 01:30:00 PM', validUpto: '06/07/2026 11:59:00 PM' })
      }
      if (body.action === 'CANEWB') return ok({ ewayBillNo: String(data.ewbNo), cancelDate: '05/07/2026 02:00:00 PM' })
      if (body.action === 'VEHEWB') return ok({ vehUpdDate: '05/07/2026 03:00:00 PM', validUpto: '07/07/2026 11:59:00 PM' })
    }
    res.writeHead(404).end('{}')
  }).listen(0)
  app = createApp().listen(0)
  api = `http://localhost:${(app.address() as AddressInfo).port}/api`
})
after(async () => {
  app.close()
  nic.close()
  await pool.end()
})
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(api + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
  return { status: res.status, body: res.status === 204 ? null : await res.json() }
}

test('e-Invoice and e-Way Bill through the API: sign in, generate, a duplicate, an expired token, cancel, a new vehicle', async () => {
  const companyId = await createCompany({ name: `GSP ${Date.now()}`, booksBegin: '2026-04-01' })
  await setCompanyGst(companyId, { gstin: '27AAPFU0939F1ZV' })
  await setCompanyDetails(companyId, { mailingName: 'Unique Foods LLP', address: 'Plot 5, MIDC\nAndheri East\nMumbai', pincode: '400093' })
  const groups = await loadGroups(pool, companyId)
  const g = (n: string) => [...groups.values()].find((x) => x.name === n)!.id
  const L = (name: string, group: string, extra: object = {}) => createLedger(companyId, { name, groupId: g(group), billwise: false, ...extra })
  const nos = await createUnit(companyId, { symbol: 'Nos' })
  const laptop = await createStockItem(companyId, { name: 'Laptop', unitId: nos, hsn: '8471', gstRate: 1800 })
  const main = await defaultGodown(pool, companyId)
  const sales = await L('Sales', 'Sales Accounts')
  const igst = await L('IGST', 'Duties & Taxes', { gstTaxType: 'IGST' })
  const buyer = await L('Bengaluru Traders', 'Sundry Debtors', { gstin: '29AAGCB7383J1Z4', address: '12 MG Road\nBengaluru', pincode: '560001' })
  const sell = () => postVoucher(companyId, {
    type: 'Sales', date: '2026-07-05',
    entries: [{ ledgerId: buyer, amount: R(70800) }, { ledgerId: sales, amount: -R(60000) }, { ledgerId: igst, amount: -R(10800) }],
    inventory: [{ itemId: laptop, godownId: main, qty: -2000, rate: R(30000), amount: -R(60000) }],
  })
  const sale = await sell()
  const at = `/companies/${companyId}`

  // not set up: a plain message
  assert.match((await call('POST', `${at}/vouchers/${sale.id}/irn`)).body.error ?? (await call('POST', `${at}/vouchers/${sale.id}/irn`)).body.errors?.join(), /Set up the GSP first/)
  const base = `http://127.0.0.1:${(nic.address() as AddressInfo).port}`
  const settings = {
    environment: 'sandbox', einvoiceBase: base, ewayBase: base, clientId: 'CLIENT', clientSecret: 'SECRET', einvoiceUser: 'API_USER', einvoicePassword: 'wrong',
    ewayUser: 'EWB_USER', ewayPassword: 'ewb-pass', publicKey: PEM, extraHeaders: { 'x-gsp-subscription': 'abc' },
  }
  assert.equal((await call('PUT', `${at}/gsp/settings`, { ...settings, publicKey: 'not a key' })).status, 422)
  assert.equal((await call('PUT', `${at}/gsp/settings`, settings)).status, 204)
  const shown = (await call('GET', `${at}/gsp/settings`)).body
  assert.deepEqual([shown.clientSecret, shown.einvoicePassword, shown.clientSecretSet, shown.clientId], [undefined, undefined, true, 'CLIENT'], 'secrets never come back')
  // a wrong password: the sign-in fails with the portal's reason
  assert.match((await call('POST', `${at}/gsp/test`)).body.einvoice, /108 Invalid login credentials/)
  // the right one; a secret left out keeps the saved one
  assert.equal((await call('PUT', `${at}/gsp/settings`, { ...settings, clientSecret: '', einvoicePassword: 'einv-pass' })).status, 204)
  assert.deepEqual((await call('POST', `${at}/gsp/test`)).body, { einvoice: 'signed in', eway: 'signed in' })
  const h = portal.headers.at(-1)!
  assert.deepEqual([h['client-id'], h['client-secret'], h['x-gsp-subscription']], ['CLIENT', 'SECRET', 'abc'])

  // the IRN: stored with the acknowledgement and the signed QR code
  const signIns = portal.signIns
  const made = await call('POST', `${at}/vouchers/${sale.id}/irn`)
  assert.equal(made.status, 200, JSON.stringify(made.body))
  assert.match(made.body.irn, /^[0-9a-f]{64}$/)
  assert.deepEqual([made.body.ackNo, made.body.ackDate], ['112610000000001', '2026-07-05 12:41'])
  assert.equal(portal.signIns, signIns, 'the session from the test is used again')
  assert.equal((await call('POST', `${at}/vouchers/${sale.id}/irn`)).status, 422, 'it already has one')

  // the same invoice the IRP already has (generated elsewhere): fetched, not refused
  await pool.query(`DELETE FROM e_documents WHERE voucher_id = $1`, [sale.id])
  const again = await call('POST', `${at}/vouchers/${sale.id}/irn`)
  assert.equal(again.body.irn, made.body.irn)

  // an expired token: signs in again once, quietly
  assert.match(JSON.stringify((await call('POST', `${at}/vouchers/${sale.id}/ewb`)).body), /transport/i, 'Part B first')
  await call('PUT', `${at}/vouchers/${sale.id}/e-document`, { transport: { mode: '1', distance: 980, vehicleNo: 'MH12AB1234' } })
  portal.expireNext = true
  const ewb = await call('POST', `${at}/vouchers/${sale.id}/ewb`)
  assert.deepEqual([ewb.status, ewb.body.ewbNo, ewb.body.ewbValidUpto], [200, '341001234567', '2026-07-06 23:59'])
  assert.equal(portal.signIns, signIns + 1)

  // a new vehicle on the e-Way Bill, then cancelling it and the IRN
  const v = await call('POST', `${at}/vouchers/${sale.id}/ewb/vehicle`, { vehicleNo: 'mh 12 ab 9999', fromPlace: 'Pune', fromState: '27', reason: '1', remark: 'Breakdown' })
  assert.deepEqual([v.status, v.body.transport.vehicleNo, v.body.ewbValidUpto], [200, 'MH12AB9999', '2026-07-07 23:59'])
  assert.equal((await call('POST', `${at}/vouchers/${sale.id}/ewb/cancel`, { reason: '2', remark: 'Order cancelled' })).body.ewbNo, null)
  const cancelled = await call('POST', `${at}/vouchers/${sale.id}/irn/cancel`, { reason: '3', remark: 'Order cancelled' })
  assert.equal(cancelled.body.irnCancelled, true)

  // an e-Way Bill without an IRN, through the e-Way Bill system (needs transport details first)
  const second = await sell()
  await call('PUT', `${at}/vouchers/${second.id}/e-document`, { transport: { mode: '1', distance: 980, vehicleNo: 'MH12AB1234' } })
  const direct = await call('POST', `${at}/e-documents/generate`, { ids: [second.id], what: 'ewb' })
  assert.deepEqual(direct.body.map((x: { ok: boolean; record?: { ewbNo: string } }) => [x.ok, x.record?.ewbNo]), [[true, '351001234568']])

  const logged = (await call('GET', `${at}/gsp/log`)).body
  assert.ok(logged.some((l: { action: string; ok: boolean }) => l.action === 'generate IRN' && l.ok))
  assert.ok(logged.some((l: { action: string; ok: boolean }) => l.action === 'sign in' && !l.ok))

  // the secrets stay out of backups
  const { backupCompany } = await import('../src/backup')
  const file = gunzipSync((await backupCompany(companyId)).file).toString()
  assert.ok(!file.includes('SECRET') && !file.includes('einv-pass'))
})
