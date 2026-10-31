import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { pool } from '../src/db'
import { migrate } from '../src/migrate'
import { createCompany, ledgerBalances } from '../src/books'
import { createXmlApp, tallyDate } from '../src/xml/gateway'

let server: Server
let url = ''
let company = ''
let companyId = 0

before(async () => {
  await migrate(() => {})
  company = `XML Traders ${Date.now()}`
  companyId = await createCompany({ name: company, booksBegin: '2026-04-01' })
  server = createXmlApp().listen(0)
  url = `http://localhost:${(server.address() as AddressInfo).port}/`
})
after(async () => {
  server.close()
  await pool.end()
})

const post = async (xml: string) => (await fetch(url, { method: 'POST', headers: { 'content-type': 'text/xml' }, body: xml })).text()
const tag = (xml: string, t: string) => new RegExp(`<${t}>([^<]*)</${t}>`).exec(xml)?.[1]

const importEnvelope = (company: string, messages: string) => `<ENVELOPE>
 <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
 <BODY><IMPORTDATA>
  <REQUESTDESC><REPORTNAME>All Masters</REPORTNAME>
   <STATICVARIABLES><SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY></STATICVARIABLES>
  </REQUESTDESC>
  <REQUESTDATA>${messages}</REQUESTDATA>
 </IMPORTDATA></BODY>
</ENVELOPE>`

test('dates in the three forms Tally sends', () => {
  assert.equal(tallyDate('20260401'), '2026-04-01')
  assert.equal(tallyDate('1-Apr-2026'), '2026-04-01')
  assert.equal(tallyDate('15-dec-26'), '2026-12-15')
  assert.throws(() => tallyDate('April 1'))
})

test('GET answers like a running Tally server', async () => {
  assert.match(await (await fetch(url)).text(), /<RESPONSE>.*Running<\/RESPONSE>/)
})

test('import ledgers and vouchers in Tally XML, then export them back', async () => {
  const res = await post(
    importEnvelope(
      company,
      `<TALLYMESSAGE xmlns:UDF="TallyUDF">
         <LEDGER NAME="Sharma Stores" ACTION="Create"><NAME>Sharma Stores</NAME><PARENT>Sundry Debtors</PARENT><OPENINGBALANCE>-1500.00</OPENINGBALANCE></LEDGER>
       </TALLYMESSAGE>
       <TALLYMESSAGE><LEDGER NAME="Sales"><NAME>Sales</NAME><PARENT>Sales Accounts</PARENT></LEDGER></TALLYMESSAGE>
       <TALLYMESSAGE><LEDGER NAME="Capital"><NAME>Capital</NAME><PARENT>Capital Account</PARENT><OPENINGBALANCE>1500</OPENINGBALANCE></LEDGER></TALLYMESSAGE>
       <TALLYMESSAGE>
         <VOUCHER VCHTYPE="Sales" ACTION="Create">
           <DATE>20260410</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><NARRATION>Bill &amp; delivery</NARRATION>
           <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sharma Stores</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-11800.00</AMOUNT></ALLLEDGERENTRIES.LIST>
           <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sales</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>11800.00</AMOUNT></ALLLEDGERENTRIES.LIST>
         </VOUCHER>
       </TALLYMESSAGE>
       <TALLYMESSAGE>
         <VOUCHER VCHTYPE="Receipt" ACTION="Create">
           <DATE>15-Apr-2026</DATE><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME>
           <ALLLEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><AMOUNT>-5000</AMOUNT></ALLLEDGERENTRIES.LIST>
           <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sharma Stores</LEDGERNAME><AMOUNT>5000</AMOUNT></ALLLEDGERENTRIES.LIST>
         </VOUCHER>
       </TALLYMESSAGE>`,
    ),
  )
  assert.equal(tag(res, 'CREATED'), '5', res)
  assert.equal(tag(res, 'ERRORS'), '0', res)

  // opening -1500 in Tally XML is a debit of 1,500; Sales 11,800 Dr; Receipt 5,000 Cr
  const b = await ledgerBalances(pool, companyId, '2026-04-01', '2027-03-31')
  assert.equal(b.find((x) => x.name === 'Sharma Stores')!.closing, 150000 + 1180000 - 500000)
  assert.equal(b.find((x) => x.name === 'Cash')!.closing, 500000)

  const out = await post(`<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>Day Book</ID></HEADER>
    <BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY><SVFROMDATE>20260401</SVFROMDATE><SVTODATE>20260430</SVTODATE></STATICVARIABLES></DESC></BODY></ENVELOPE>`)
  assert.match(out, /<VOUCHERTYPENAME>Sales<\/VOUCHERTYPENAME><VOUCHERNUMBER>1<\/VOUCHERNUMBER><NARRATION>Bill &amp; delivery<\/NARRATION>/)
  assert.match(out, /<LEDGERNAME>Sharma Stores<\/LEDGERNAME><ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE><AMOUNT>-11800.00<\/AMOUNT>/)

  const tb = await post(`<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA><REQUESTDESC>
    <REPORTNAME>Trial Balance</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`)
  assert.match(tb, /<DSPDISPNAME>Current Assets<\/DSPDISPNAME><\/DSPACCNAME>\s*<DSPACCINFO><DSPCLDRAMT><DSPCLDRAMTA>-13300.00<\/DSPCLDRAMTA>/)
  assert.match(tb, /<DSPDISPNAME>Sales Accounts<\/DSPDISPNAME><\/DSPACCNAME>\s*<DSPACCINFO><DSPCLDRAMT><DSPCLDRAMTA><\/DSPCLDRAMTA><\/DSPCLDRAMT><DSPCLCRAMT><DSPCLCRAMTA>11800.00</)

  const accts = await post(`<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA><REQUESTDESC>
    <REPORTNAME>List of Accounts</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`)
  assert.equal((accts.match(/<GROUP /g) ?? []).length, 28)
  assert.match(accts, /<LEDGER NAME="Sharma Stores"><NAME>Sharma Stores<\/NAME><PARENT>Sundry Debtors<\/PARENT><OPENINGBALANCE>-1500.00<\/OPENINGBALANCE><CLOSINGBALANCE>-8300.00<\/CLOSINGBALANCE>/)
})

test('bad imports report LINEERROR per item and post nothing for them', async () => {
  const res = await post(
    importEnvelope(
      company,
      `<TALLYMESSAGE><VOUCHER VCHTYPE="Journal"><DATE>20260420</DATE><VOUCHERTYPENAME>Journal</VOUCHERTYPENAME>
         <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sharma Stores</LEDGERNAME><AMOUNT>-100</AMOUNT></ALLLEDGERENTRIES.LIST>
         <ALLLEDGERENTRIES.LIST><LEDGERNAME>Capital</LEDGERNAME><AMOUNT>99</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER></TALLYMESSAGE>
       <TALLYMESSAGE><VOUCHER VCHTYPE="Payment"><DATE>20260420</DATE><VOUCHERTYPENAME>Payment</VOUCHERTYPENAME>
         <ALLLEDGERENTRIES.LIST><LEDGERNAME>Nobody</LEDGERNAME><AMOUNT>-100</AMOUNT></ALLLEDGERENTRIES.LIST>
         <ALLLEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><AMOUNT>100</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER></TALLYMESSAGE>
       <TALLYMESSAGE><LEDGER NAME="X"><NAME>Orphan</NAME><PARENT>No Such Group</PARENT></LEDGER></TALLYMESSAGE>`,
    ),
  )
  assert.equal(tag(res, 'CREATED'), '0')
  assert.equal(tag(res, 'ERRORS'), '3')
  assert.match(res, /<LINEERROR>Voucher Journal 20260420: Debit and Credit totals differ by 1<\/LINEERROR>/)
  assert.match(res, /Ledger &quot;Nobody&quot; does not exist/)
  assert.match(res, /Group &quot;No Such Group&quot; does not exist/)

  assert.match(await post('<not xml'), /<LINEERROR>.*(well-formed|ENVELOPE)/)
  assert.match(await post(importEnvelope('Unknown Co', '')), /Company &quot;Unknown Co&quot; not found/)
})

test('ACTION="Alter" replaces an existing voucher by number', async () => {
  const res = await post(
    importEnvelope(
      company,
      `<TALLYMESSAGE><VOUCHER VCHTYPE="Receipt" ACTION="Alter"><DATE>20260416</DATE><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><VOUCHERNUMBER>1</VOUCHERNUMBER>
         <ALLLEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><AMOUNT>-6000</AMOUNT></ALLLEDGERENTRIES.LIST>
         <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sharma Stores</LEDGERNAME><AMOUNT>6000</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER></TALLYMESSAGE>`,
    ),
  )
  assert.equal(tag(res, 'ALTERED'), '1', res)
  const b = await ledgerBalances(pool, companyId, '2026-04-01', '2027-03-31')
  assert.equal(b.find((x) => x.name === 'Cash')!.closing, 600000)
})

test('item invoices: stock masters, ALLINVENTORYENTRIES and their ACCOUNTINGALLOCATIONS', async () => {
  const name = `XML Stock ${Date.now()}`
  const id = await createCompany({ name, booksBegin: '2026-04-01' })
  const msg = (x: string) => `<TALLYMESSAGE>${x}</TALLYMESSAGE>`
  const res = await post(
    importEnvelope(
      name,
      [
        msg(`<UNIT NAME="Kg"><NAME>Kg</NAME><ORIGINALNAME>Kilogram</ORIGINALNAME><DECIMALPLACES>2</DECIMALPLACES><GSTREPUOM>KGS-KILOGRAMS</GSTREPUOM></UNIT>`),
        msg(`<GODOWN NAME="Back Store"><NAME>Back Store</NAME><PARENT>Main Location</PARENT></GODOWN>`),
        msg(`<STOCKGROUP NAME="Grains"><NAME>Grains</NAME><PARENT/></STOCKGROUP>`),
        msg(`<STOCKITEM NAME="Rice"><NAME>Rice</NAME><PARENT>Grains</PARENT><BASEUNITS>Kg</BASEUNITS><OPENINGBALANCE> 100 Kg</OPENINGBALANCE><OPENINGVALUE>-4000.00</OPENINGVALUE><REORDERBASE> 25.50 Kg</REORDERBASE><MINIMUMORDERBASE> 50 Kg</MINIMUMORDERBASE></STOCKITEM>`),
        msg(`<LEDGER NAME="Capital"><NAME>Capital</NAME><PARENT>Capital Account</PARENT><OPENINGBALANCE>4000</OPENINGBALANCE></LEDGER>`),
        msg(`<LEDGER NAME="Sales"><NAME>Sales</NAME><PARENT>Sales Accounts</PARENT></LEDGER>`),
        msg(`<LEDGER NAME="Bistro"><NAME>Bistro</NAME><PARENT>Sundry Debtors</PARENT></LEDGER>`),
        msg(`<VOUCHER VCHTYPE="Sales" ACTION="Create"><DATE>20260420</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
          <LEDGERENTRIES.LIST><LEDGERNAME>Bistro</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-1815.00</AMOUNT></LEDGERENTRIES.LIST>
          <ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Rice</STOCKITEMNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
            <RATE>60.00/Kg</RATE><AMOUNT>1215.00</AMOUNT><ACTUALQTY> 20.25 Kg</ACTUALQTY><BILLEDQTY> 20.25 Kg</BILLEDQTY>
            <BATCHALLOCATIONS.LIST><GODOWNNAME>Main Location</GODOWNNAME><AMOUNT>1215.00</AMOUNT><ACTUALQTY> 20.25 Kg</ACTUALQTY></BATCHALLOCATIONS.LIST>
            <ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>Sales</LEDGERNAME><AMOUNT>1215.00</AMOUNT></ACCOUNTINGALLOCATIONS.LIST>
          </ALLINVENTORYENTRIES.LIST>
          <ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Rice</STOCKITEMNAME><RATE>60.00/Kg</RATE><AMOUNT>600.00</AMOUNT><ACTUALQTY> 10 Kg</ACTUALQTY>
            <BATCHALLOCATIONS.LIST><GODOWNNAME>Back Store</GODOWNNAME></BATCHALLOCATIONS.LIST>
            <ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>Sales</LEDGERNAME><AMOUNT>600.00</AMOUNT></ACCOUNTINGALLOCATIONS.LIST>
          </ALLINVENTORYENTRIES.LIST>
        </VOUCHER>`),
        msg(`<VOUCHER VCHTYPE="Sales"><DATE>20260421</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
          <LEDGERENTRIES.LIST><LEDGERNAME>Bistro</LEDGERNAME><AMOUNT>-60.00</AMOUNT></LEDGERENTRIES.LIST>
          <ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Wheat</STOCKITEMNAME><AMOUNT>60.00</AMOUNT><ACTUALQTY> 1 Kg</ACTUALQTY>
            <ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>Sales</LEDGERNAME><AMOUNT>60.00</AMOUNT></ACCOUNTINGALLOCATIONS.LIST>
          </ALLINVENTORYENTRIES.LIST>
        </VOUCHER>`),
      ].join(''),
    ),
  )
  assert.equal(tag(res, 'CREATED'), '8', res)
  assert.equal(tag(res, 'ERRORS'), '1', res)
  assert.match(res, /Stock item &quot;Wheat&quot; does not exist/)

  const { stockPositions } = await import('../src/inventory')
  const rice = (await stockPositions(pool, id, '2026-04-01', '2027-03-31')).find((p) => p.name === 'Rice')!
  assert.deepEqual([rice.openingQty, rice.closingQty, rice.closingValue], [100000, 69750, 279000]) // 69.75 kg at ₹40
  const levels = (await pool.query(`SELECT reorder_level::int r, min_order_qty::int m FROM stock_items WHERE id = $1`, [rice.id])).rows[0]
  assert.deepEqual(levels, { r: 25500, m: 50000 }, 'reorder level and minimum order quantity')
  assert.equal((await pool.query(`SELECT uqc FROM units WHERE company_id = $1 AND symbol = 'Kg'`, [id])).rows[0].uqc, 'KGS')
  const inv = (await pool.query(`SELECT g.name godown, i.qty, i.rate, i.amount FROM inventory_entries i JOIN godowns g ON g.id = i.godown_id
    JOIN vouchers v ON v.id = i.voucher_id WHERE v.company_id = $1 ORDER BY i.line`, [id])).rows
  assert.deepEqual(inv.map((r) => [r.godown, Number(r.qty), Number(r.rate), Number(r.amount)]), [['Main Location', -20250, 6000, -121500], ['Back Store', -10000, 6000, -60000]])
  const b = await ledgerBalances(pool, id, '2026-04-01', '2027-03-31')
  assert.equal(b.find((x) => x.name === 'Sales')!.closing, -181500) // the two allocations gathered into one entry
  assert.equal(b.find((x) => x.name === 'Bistro')!.closing, 181500)
})

test('GST from Tally XML: tax ledgers by duty head, HSN and rates, then the invoice breakup', async () => {
  const { setCompanyGst } = await import('../src/books')
  const name = `XML GST ${Date.now()}`
  const id = await createCompany({ name, booksBegin: '2026-04-01' })
  await setCompanyGst(id, { gstin: '27AAPFU0939F1ZV' })
  const msg = (x: string) => `<TALLYMESSAGE>${x}</TALLYMESSAGE>`
  const rate = (r: number) => `<GSTDETAILS.LIST><HSNCODE>1006</HSNCODE><STATEWISEDETAILS.LIST><RATEDETAILS.LIST><GSTRATEDUTYHEAD>Central Tax</GSTRATEDUTYHEAD><GSTRATE>${r / 2}</GSTRATE></RATEDETAILS.LIST><RATEDETAILS.LIST><GSTRATEDUTYHEAD>Integrated Tax</GSTRATEDUTYHEAD><GSTRATE>${r}</GSTRATE></RATEDETAILS.LIST></STATEWISEDETAILS.LIST></GSTDETAILS.LIST>`
  const res = await post(importEnvelope(name, [
    msg(`<UNIT NAME="Kg"><NAME>Kg</NAME><DECIMALPLACES>2</DECIMALPLACES></UNIT>`),
    msg(`<STOCKITEM NAME="Rice"><NAME>Rice</NAME><BASEUNITS>Kg</BASEUNITS>${rate(5)}</STOCKITEM>`),
    msg(`<LEDGER NAME="Sales"><NAME>Sales</NAME><PARENT>Sales Accounts</PARENT></LEDGER>`),
    msg(`<LEDGER NAME="IGST"><NAME>IGST</NAME><PARENT>Duties &amp; Taxes</PARENT><TAXTYPE>GST</TAXTYPE><GSTDUTYHEAD>Integrated Tax</GSTDUTYHEAD></LEDGER>`),
    msg(`<LEDGER NAME="Bengaluru Co"><NAME>Bengaluru Co</NAME><PARENT>Sundry Debtors</PARENT><PARTYGSTIN>29AAGCB7383J1Z4</PARTYGSTIN><LEDSTATENAME>Karnataka</LEDSTATENAME></LEDGER>`),
    msg(`<LEDGER NAME="Overseas"><NAME>Overseas</NAME><PARENT>Sundry Debtors</PARENT><LEDSTATENAME>Not Applicable</LEDSTATENAME></LEDGER>`),
    msg(`<VOUCHER VCHTYPE="Sales"><DATE>20260705</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
      <LEDGERENTRIES.LIST><LEDGERNAME>Bengaluru Co</LEDGERNAME><AMOUNT>-2100.00</AMOUNT></LEDGERENTRIES.LIST>
      <LEDGERENTRIES.LIST><LEDGERNAME>IGST</LEDGERNAME><AMOUNT>100.00</AMOUNT></LEDGERENTRIES.LIST>
      <ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Rice</STOCKITEMNAME><RATE>50.00/Kg</RATE><AMOUNT>2000.00</AMOUNT><ACTUALQTY> 40 Kg</ACTUALQTY>
        <ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>Sales</LEDGERNAME><AMOUNT>2000.00</AMOUNT></ACCOUNTINGALLOCATIONS.LIST></ALLINVENTORYENTRIES.LIST>
    </VOUCHER>`),
  ].join('')))
  assert.equal(tag(res, 'ERRORS'), '0', res)
  const { rows } = await pool.query(`SELECT gst FROM vouchers WHERE company_id = $1`, [id])
  const g = rows[0].gst
  assert.deepEqual([g.gstin, g.pos, g.interstate, g.problems], ['29AAGCB7383J1Z4', '29', true, []])
  assert.deepEqual(g.lines.map((l: { hsn: string; rate: number; igst: number }) => [l.hsn, l.rate, l.igst]), [['1006', 500, 10000]])
})

test('inventory vouchers from Tally XML: a delivery note names its party; a stock journal lists IN and OUT', async () => {
  const name = `XML Notes ${Date.now()}`
  const id = await createCompany({ name, booksBegin: '2026-04-01' })
  const msg = (x: string) => `<TALLYMESSAGE>${x}</TALLYMESSAGE>`
  const res = await post(
    importEnvelope(
      name,
      [
        msg(`<UNIT NAME="Kg"><NAME>Kg</NAME></UNIT>`),
        msg(`<GODOWN NAME="Back Store"><NAME>Back Store</NAME></GODOWN>`),
        msg(`<STOCKITEM NAME="Rice"><NAME>Rice</NAME><BASEUNITS>Kg</BASEUNITS><OPENINGBALANCE> 100 Kg</OPENINGBALANCE><OPENINGVALUE>-4000.00</OPENINGVALUE></STOCKITEM>`),
        msg(`<LEDGER NAME="Bistro"><NAME>Bistro</NAME><PARENT>Sundry Debtors</PARENT></LEDGER>`),
        msg(`<VOUCHER VCHTYPE="Delivery Note"><DATE>20260420</DATE><VOUCHERTYPENAME>Delivery Note</VOUCHERTYPENAME><PARTYLEDGERNAME>Bistro</PARTYLEDGERNAME>
          <ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Rice</STOCKITEMNAME><RATE>60.00/Kg</RATE><AMOUNT>600.00</AMOUNT><ACTUALQTY> 10 Kg</ACTUALQTY></ALLINVENTORYENTRIES.LIST>
        </VOUCHER>`),
        msg(`<VOUCHER VCHTYPE="Stock Journal"><DATE>20260421</DATE><VOUCHERTYPENAME>Stock Journal</VOUCHERTYPENAME>
          <INVENTORYENTRIESOUT.LIST><STOCKITEMNAME>Rice</STOCKITEMNAME><RATE>40.00/Kg</RATE><AMOUNT>-200.00</AMOUNT><ACTUALQTY> 5 Kg</ACTUALQTY>
            <BATCHALLOCATIONS.LIST><GODOWNNAME>Main Location</GODOWNNAME></BATCHALLOCATIONS.LIST></INVENTORYENTRIESOUT.LIST>
          <INVENTORYENTRIESIN.LIST><STOCKITEMNAME>Rice</STOCKITEMNAME><RATE>40.00/Kg</RATE><AMOUNT>200.00</AMOUNT><ACTUALQTY> 5 Kg</ACTUALQTY>
            <BATCHALLOCATIONS.LIST><GODOWNNAME>Back Store</GODOWNNAME></BATCHALLOCATIONS.LIST></INVENTORYENTRIESIN.LIST>
        </VOUCHER>`),
        msg(`<VOUCHER VCHTYPE="Delivery Note"><DATE>20260422</DATE><VOUCHERTYPENAME>Delivery Note</VOUCHERTYPENAME>
          <ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Rice</STOCKITEMNAME><AMOUNT>60.00</AMOUNT><ACTUALQTY> 1 Kg</ACTUALQTY></ALLINVENTORYENTRIES.LIST>
        </VOUCHER>`),
      ].join(''),
    ),
  )
  assert.equal(tag(res, 'CREATED'), '6', res)
  assert.match(res, /A Delivery Note needs PARTYLEDGERNAME/)
  const { stockPositions } = await import('../src/inventory')
  const rice = (await stockPositions(pool, id, '2026-04-01', '2027-03-31')).find((p) => p.name === 'Rice')!
  assert.equal(rice.closingQty, 90000)
  const { rows } = await pool.query(`SELECT v.type, l.name party FROM vouchers v LEFT JOIN ledgers l ON l.id = v.party_ledger_id WHERE v.company_id = $1 ORDER BY v.id`, [id])
  assert.deepEqual(rows.map((r) => [r.type, r.party]), [['Delivery Note', 'Bistro'], ['Stock Journal', null]])
})

test('cost centres from Tally XML: COSTCATEGORY, COSTCENTRE, ISCOSTCENTRESON and the entry split', async () => {
  const name = `XML Costs ${Date.now()}`
  const id = await createCompany({ name, booksBegin: '2026-04-01' })
  const msg = (x: string) => `<TALLYMESSAGE>${x}</TALLYMESSAGE>`
  const res = await post(
    importEnvelope(
      name,
      [
        msg(`<COSTCATEGORY NAME="Projects"><NAME>Projects</NAME></COSTCATEGORY>`),
        msg(`<COSTCENTRE NAME="Mumbai"><NAME>Mumbai</NAME><CATEGORY>Primary Cost Category</CATEGORY><PARENT/></COSTCENTRE>`),
        msg(`<COSTCENTRE NAME="Alpha"><NAME>Alpha</NAME><CATEGORY>Projects</CATEGORY></COSTCENTRE>`),
        msg(`<LEDGER NAME="Rent"><NAME>Rent</NAME><PARENT>Indirect Expenses</PARENT><ISCOSTCENTRESON>Yes</ISCOSTCENTRESON></LEDGER>`),
        msg(`<VOUCHER VCHTYPE="Payment"><DATE>20260410</DATE><VOUCHERTYPENAME>Payment</VOUCHERTYPENAME>
          <ALLLEDGERENTRIES.LIST><LEDGERNAME>Rent</LEDGERNAME><AMOUNT>-1000.00</AMOUNT>
            <CATEGORYALLOCATIONS.LIST><CATEGORY>Primary Cost Category</CATEGORY>
              <COSTCENTREALLOCATIONS.LIST><NAME>Mumbai</NAME><AMOUNT>-700.00</AMOUNT></COSTCENTREALLOCATIONS.LIST></CATEGORYALLOCATIONS.LIST>
            <CATEGORYALLOCATIONS.LIST><CATEGORY>Projects</CATEGORY>
              <COSTCENTREALLOCATIONS.LIST><NAME>Alpha</NAME><AMOUNT>-300.00</AMOUNT></COSTCENTREALLOCATIONS.LIST></CATEGORYALLOCATIONS.LIST>
          </ALLLEDGERENTRIES.LIST>
          <ALLLEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><AMOUNT>1000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
        </VOUCHER>`),
      ].join(''),
    ),
  )
  assert.equal(tag(res, 'CREATED'), '5', res)
  const { rows } = await pool.query(
    `SELECT c.name, a.amount FROM cost_allocations a JOIN cost_centres c ON c.id = a.cost_centre_id WHERE c.company_id = $1 ORDER BY a.id`, [id])
  assert.deepEqual(rows.map((r) => [r.name, Number(r.amount)]), [['Mumbai', 70000], ['Alpha', 30000]])
})

test('cheques from Tally XML: BANKALLOCATIONS instrument number and date, ISPOSTDATED', async () => {
  const name = `XML Cheques ${Date.now()}`
  const id = await createCompany({ name, booksBegin: '2026-04-01' })
  const msg = (x: string) => `<TALLYMESSAGE>${x}</TALLYMESSAGE>`
  const res = await post(
    importEnvelope(
      name,
      [
        msg(`<LEDGER NAME="HDFC"><NAME>HDFC</NAME><PARENT>Bank Accounts</PARENT></LEDGER>`),
        msg(`<LEDGER NAME="Rent"><NAME>Rent</NAME><PARENT>Indirect Expenses</PARENT></LEDGER>`),
        msg(`<VOUCHER VCHTYPE="Payment"><DATE>20260410</DATE><VOUCHERTYPENAME>Payment</VOUCHERTYPENAME><ISPOSTDATED>Yes</ISPOSTDATED>
          <ALLLEDGERENTRIES.LIST><LEDGERNAME>Rent</LEDGERNAME><AMOUNT>-1000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
          <ALLLEDGERENTRIES.LIST><LEDGERNAME>HDFC</LEDGERNAME><AMOUNT>1000.00</AMOUNT>
            <BANKALLOCATIONS.LIST><TRANSACTIONTYPE>Cheque</TRANSACTIONTYPE><INSTRUMENTNUMBER>000321</INSTRUMENTNUMBER><INSTRUMENTDATE>20260412</INSTRUMENTDATE></BANKALLOCATIONS.LIST>
          </ALLLEDGERENTRIES.LIST>
        </VOUCHER>`),
      ].join(''),
    ),
  )
  assert.equal(tag(res, 'CREATED'), '3', res)
  const { rows } = await pool.query(
    `SELECT v.post_dated, e.instrument_no, to_char(e.instrument_date,'YYYY-MM-DD') d FROM entries e JOIN vouchers v ON v.id = e.voucher_id
      WHERE v.company_id = $1 AND e.instrument_no IS NOT NULL`, [id])
  assert.deepEqual(rows, [{ post_dated: true, instrument_no: '000321', d: '2026-04-12' }])
})

test('ledger mailing details from Tally XML: LEDMAILINGDETAILS.LIST with its address lines', async () => {
  const name = `XML Mail ${Date.now()}`
  const id = await createCompany({ name, booksBegin: '2026-04-01' })
  const res = await post(
    importEnvelope(
      name,
      `<TALLYMESSAGE><LEDGER NAME="Acme Inc"><NAME>Acme Inc</NAME><PARENT>Sundry Debtors</PARENT><EMAIL>ap@acme.example</EMAIL>
        <LEDMAILINGDETAILS.LIST><ADDRESS.LIST TYPE="String"><ADDRESS>1 Main St</ADDRESS><ADDRESS>Springfield</ADDRESS></ADDRESS.LIST>
          <MAILINGNAME>Acme Incorporated</MAILINGNAME><COUNTRY>United States</COUNTRY><PINCODE>62701</PINCODE></LEDMAILINGDETAILS.LIST>
      </LEDGER></TALLYMESSAGE>`,
    ),
  )
  assert.equal(tag(res, 'CREATED'), '1', res)
  const { rows } = await pool.query(`SELECT mailing_name, address, country, pincode, email FROM ledgers WHERE company_id = $1 AND name = 'Acme Inc'`, [id])
  assert.deepEqual(rows[0], { mailing_name: 'Acme Incorporated', address: '1 Main St\nSpringfield', country: 'United States', pincode: '62701', email: 'ap@acme.example' })
})
