# Saral

Saral is a keyboard-first double-entry accounting app for Indian businesses: companies, a chart of
groups and ledgers, vouchers, live balances, GST, TDS, payroll and inventory. People who know
TallyPrime find the keys and menus they expect, and its XML gateway reads and writes Tally's
integration format, so books move across. Saral is not affiliated with Tally Solutions; Tally and
TallyPrime are their trademarks. All code here is original. The design follows
what the TallyPrime install could be shown to do (see "Design notes").

## Running it

Needs Node 20+ and Docker.

```bash
docker compose up -d                       # Postgres on :5435
cp server/.env.example server/.env         # first time only
cd server && npm install && npm run dev    # API :4100, Tally XML gateway :9010 (migrations run on start)
# in another terminal, from apps/tally:
npm install && npm run dev                 # app on http://localhost:5190 (proxies /api to :4100)
```

The first time, create the test database: `docker compose exec db psql -U tally -c "CREATE DATABASE tally_test"`.

| Command | What it does |
|---|---|
| `npm test` (in `server/`) | Engine, database, HTTP API and XML gateway tests, against `tally_test` |
| `npm run typecheck` (in `server/`) | Type-check the server |
| `npm run build` (in `apps/tally`) | Type-check and build the front end |

## Desktop app (Windows)

The same app ships as a desktop program: no Docker, no separate database, works offline.

```bash
cd desktop
npm install
npm run build      # bundles web + server + PGlite + Node, then builds the Windows installer
```

The installer lands in `desktop/src-tauri/target/release/bundle/nsis/` (about 27 MB). It
installs for the current user. To work on the shell itself, run `node build.mjs` and then
`cargo build` in `desktop/src-tauri`, and start `target/debug/spectral-tally.exe`.

How it runs:
- **Window:** Tauri (WebView2) shows the same React screens. A splash appears while the server starts, about 2–5 s, or about 10 s on the very first run.
- **Server:** the bundled Node server runs on a free loopback-only port. Its log is in `%LOCALAPPDATA%\com.imbspectral.tally\logs\server.log`.
- **Data:** PGlite (Postgres compiled to WebAssembly) keeps the company data in `%APPDATA%\com.imbspectral.tally\data\db`. It runs the same schema, triggers and checks as PostgreSQL, and the full test suite passes on both (`TEST_DATABASE_URL=pglite:memory npm test`).
- **Safety:** the server is tied to the app by a Windows job object, so it never outlives it, even if the app is killed. Only one copy of the app runs; a second launch brings the window forward.
- **Keys:** browser shortcuts (F5 reload, Ctrl+P print, Ctrl+F find, zoom…) are blocked, so the F-keys and Ctrl keys belong to the app, as in Tally.

Any backend takes `DATABASE_URL=pglite:<folder>` to run without PostgreSQL. Set `HOST=0.0.0.0`
to serve other PCs on the network. The default is this PC only.

## Using it

The keys follow TallyPrime's own menu definitions, so Tally habits carry over.

| Key | Action |
|---|---|
| Gateway: C / A / H / V / K / B / P / S / D / Q | Create, Alter, Chart of Accounts, Vouchers, Day Book, Balance Sheet, Profit & Loss, Stock Summary, Display More Reports, Quit (close company) |
| Highlighted letter / ↑↓ Enter | Pick from any menu |
| F4 F5 F6 F7 F8 F9 | Contra, Payment, Receipt, Journal, Sales, Purchase voucher |
| Ctrl+F8 / Ctrl+F9 | Credit Note / Debit Note |
| Alt+F5 / Alt+F8 / Alt+F9 | Sales Order / Delivery Note / Receipt Note |
| Alt+F7 / Ctrl+F7 | Stock Journal / Physical Stock |
| F10 | Every voucher type by letter (Purchase Order is here: Tally's Alt+F4 would close the window) |
| Enter | Next field; in a voucher, after an amount, adds the balancing line |
| D / C (on a voucher line) | Debit or credit side |
| F2 (in a voucher) | Go to the date |
| Alt+C (on a voucher's ledger field) | Create the ledger you typed, without leaving the voucher |
| Ctrl+A | Accept (save) a voucher |
| Ctrl+V (Sales, Purchase, notes) | Switch between item invoice and voucher mode |
| Alt+C (on an invoice's item field / an item's Units field) | Create the stock item / unit you typed |
| Alt+F1 (Stock Summary) | Detailed view: opening, inwards, outwards, godown quantities |
| Alt+D (in an alteration) | Delete the ledger or group (asks Y/N) |
| Day Book: Enter / Alt+X / Alt+D | Alter / cancel (number kept) / delete the selected voucher |
| Alt+F2 | Change the report period |
| Alt+K | Company menu: Users and Passwords, Change Password, GST Registration |
| Alt+E / Alt+P | Export the screen to Excel (.xlsx) / print or save as PDF |
| Esc / Ctrl+Q | Back; asks before throwing away unsaved voucher entries |

Dates take Tally's short forms: `14` (the 14th of the current month), `14-10` or `14-Oct`
(the year that keeps it inside the financial year), `14.10.26`, `14/10/2026`.

## Architecture

```
src/                 React front end: screen stack, keyboard menus, voucher entry, reports
server/src/engine/   pure TypeScript, shared by server and UI
  money.ts           integer paise, + = Debit; Indian digit grouping
  groups.ts          the 28 default groups (15 primary + 13 sub-groups) and their nature
  voucher.ts         voucher rules: Dr = Cr, cash/bank rules per type, Sales/Purchase ledgers
  reports.ts         Trial Balance, Profit & Loss (trading + P&L), Balance Sheet
server/src/books.ts  companies, masters, posting/alter/cancel/delete, period balances
server/src/routes/   JSON API
server/src/xml/      Tally-compatible XML gateway (Import Data / Export Data)
server/src/migrations/001_init.sql   schema, triggers and the commit-time balance check
```

**Integrity is enforced twice.** The engine validates every voucher before it is posted. A
deferred constraint trigger then checks at COMMIT that every live voucher has at least two
entries summing to zero. A trigger also refuses another company's ledger. Nothing can save an
unbalanced voucher: not the UI, the API, an XML import or raw SQL. The database tests prove it.

**Balances are maintained, not recomputed.** Each posting updates `ledger_daily` (one row per
ledger per day) in the same transaction. A balance as on any date is the opening balance plus a
few daily rows. Reports never scan the entries table.

**Periods.** Balance-sheet ledgers carry their earlier movement in their opening balance. Income
and expense ledgers start each period at zero, and their earlier result is carried in Profit &
Loss A/c, like a year-end close.

**Stock (accounts-only mode).** Stock-in-Hand ledgers hold the opening stock. Closing stock is
set as a valuation by date (Gateway → Closing Stock), not through vouchers, which matches Tally
without integrated inventory.

### XML gateway (port 9010)

POST Tally-format XML to `http://localhost:9010/`:

- `Import Data` with `LEDGER` and `VOUCHER` messages (`ACTION="Create"` or `"Alter"` by voucher number),
  and the inventory masters `UNIT`, `GODOWN`, `STOCKGROUP` and `STOCKITEM`. Item invoices bring their
  lines in `ALLINVENTORYENTRIES.LIST` (quantity, rate, godown from `BATCHALLOCATIONS.LIST`); the sales or
  purchase ledger inside each line's `ACCOUNTINGALLOCATIONS.LIST` becomes the voucher's ledger entry.
  The reply carries `CREATED / ALTERED / ERRORS` and one `LINEERROR` per rejected item.
- `Export Data` / `Export` for `Trial Balance`, `List of Accounts`, `Ledger` and `Day Book`.
  `SVCURRENTCOMPANY`, `SVFROMDATE` and `SVTODATE` are honoured.
- Tally's sign convention is applied: in XML, a negative `AMOUNT` / `OPENINGBALANCE` is a debit.
- Real TallyPrime listens on 9000. This gateway uses 9010 so both can run on one machine.

## How close to TallyPrime? (scorecard)

`node parity/score.mjs` prints coverage against 188 TallyPrime features, the change since the last
recorded cycle, and the latest speed results. `node parity/score.mjs --record "cycle N"` appends
the run to `parity/history.jsonl`.

The feature list (`parity/features.json`) comes from the installed TallyPrime: its menu tree from
Gateway of Tally, the master types and voucher types, and its platform capabilities. Each feature
has a tier (3 daily bookkeeping, 2 common, 1 specialist) and a status, which is updated as features land.

`node bench/bench.mjs --xml <url> --target <name> [--api <url>]` imports 255 ledgers and 5,000
vouchers through Tally's XML interface, then times the Trial Balance, Day Book and List of
Accounts exports. Because it only speaks Tally XML, the same run can measure a real TallyPrime
on port 9000. Run it against a server on its own database, so benchmark companies never land
in your books, for example
`DATABASE_URL=postgres://tally:tally_dev_password@localhost:5435/tally_bench PORT=4131 XML_PORT=9031 npx tsx src/index.ts`
(create the database once with `CREATE DATABASE tally_bench`).

## Design notes: from the TallyPrime findings

| What the TallyPrime install showed | How it shapes this app |
|---|---|
| The product layer is about 126k TDL definitions over a native engine | Rules and report math live in one engine module, separate from the UI and storage |
| Reports read `ClosingBalance` as a native method | `ledger_daily` keeps running balances up to date at posting time |
| The engine enforces Dr = Cr, even for external imports | Commit-time constraint trigger; the XML gateway posts through the same path |
| The ODBC driver posts `ENVELOPE / TALLYREQUEST` XML to port 9000 | The XML gateway accepts the same envelope format |
| F-key voucher hotkeys and the Gateway menu (from the TDL `Key` definitions) | The same keyboard model |

## Bill-wise, account books and banking

- **Bill-wise details:** party ledgers (Sundry Debtors/Creditors by default) keep their balance as bills. After an amount on such a line, the voucher opens a bill-wise panel (N/A/D/O for New Ref, Agst Ref, Advance, On Account). It defaults to settling the oldest open bill, otherwise a New Ref named after the voucher number. Due dates come from the bill or the ledger's credit period. Opening balances can be split into opening bills. Tally XML `BILLALLOCATIONS.LIST` is imported.
- **Outstandings:** Display More Reports → Statements of Accounts → Outstandings (Receivables, Payables, Ledger, Group), and Exception Reports → Overdue Receivables/Payables. They show the bills with overdue days and ageing, as on today.
- **Account Books:** Cash/Bank Books, Ledger (month-wise, then vouchers), Group Summary, Group Vouchers, and the eight voucher registers (month-wise, then vouchers). ↑/↓ and Enter drill down in every report.
- **Banking → Bank Reconciliation:** bank dates per entry (they survive voucher alterations) and the reconciliation statement. A bank statement CSV import clears the matching entries by itself.
- **Import speed:** XML imports post vouchers set-wise in one transaction, about 550–1,450 vouchers per second, against 53–85 before.

## Edit Log, backup and printing

- **Edit Log (audit trail):** the database records every create, alteration, cancellation and deletion of vouchers, plus every change to ledgers, groups and companies. Each entry keeps the full state, with the time and the user. The log cannot be updated, deleted or truncated, even with raw SQL, and it outlives deleted companies. See Display More Reports → Edit Log (L); Enter on a row shows every version, with changes highlighted.
- **Backup and restore (Alt+Y):** a backup is one `.tallybackup` file (gzip JSON) holding the whole company, Edit Log included. Restoring creates a separate company in one transaction and re-checks every rule, so a damaged or edited file can't load. The company list also offers "Restore Company" on a fresh install.
- **Print (Alt+P)** prints any screen, and the print dialog offers Save as PDF. On a voucher, or a Day Book row, Alt+P opens a printable voucher with bill references and the amount in words (Indian system).
- **Export (Alt+E)** writes the screen's report tables to an Excel workbook (.xlsx, made in the app without any library). Amounts are real numbers formatted #,##0.00, Dr positive and Cr negative, so they add up; headings and totals are bold.
- **Drill-down everywhere:** on the Balance Sheet and P&L, ↑/↓ move down the left side and then the right, and Enter opens the group's summary (the P&L A/c line opens the P&L; stock lines open Stock-in-Hand).

## Inventory

- **Masters** (Create / Alter → Inventory Masters): Stock Group (O), Stock Item (I), Unit (U) with decimal places, and Godown (W). Every company starts with a "Main Location" godown. Opening stock is a quantity, rate and value in a godown.
- **Item invoices:** Sales, Purchase, Credit Note and Debit Note open as an invoice once the company has stock items. The invoice takes the party, the sales or purchase ledger, then item lines (item, godown, quantity, rate, amount), then additional ledgers such as tax, freight or a discount (a minus amount). "End of List" closes each list, as in Tally. The party's bill-wise details open before the narration, and Ctrl+V switches to voucher mode.
- **Rules held by the server:** stock moves the right way for the voucher type (out on Sales and Debit Note, in on Purchase and Credit Note), quantities fit the unit's decimal places, and the items total equals the Sales/Purchase Accounts entries. An item or godown in use can't be deleted.
- **Valuation:** average cost, TallyPrime's default. Closing stock feeds the P&L and Balance Sheet, and a later period opens at the value stock had when it began. The Trial Balance shows stock at its opening value, as Tally does; Enter on that line opens the Stock Summary.
- **Reports:** Stock Summary (Gateway S, group drill, Alt+F1 detailed), Stock Item Vouchers with a running quantity, and Inventory Books under Display More Reports (I).
- Backups (version 2) carry the inventory; version 1 files still restore.

## GST

- **Registration:** Display More Reports → GST Reports (O) → GST Registration (R). The GSTIN is checked (format, state code, check digit) and sets the company's state.
- **Masters:** party ledgers take a GSTIN and state (the state follows from the GSTIN). Ledgers under Duties & Taxes take a tax type (IGST, CGST, SGST, Cess). Stock items and service/income/expense ledgers take a GST rate and HSN/SAC.
- **Invoices:** after the items' End of List, the GST lines fill in: CGST + SGST when the place of supply is the company's own state, IGST otherwise. The header shows which applies. Picking a GST ledger by hand fills in its tax too. Each invoice stores its GST breakup as posted, so changing a rate later doesn't rewrite past returns. Wrong tax (IGST within the state, a rate that doesn't match the items, a bad GSTIN, a missing HSN) is listed under "Needs attention".
- **GSTR-1 (1):** B2B, B2C (Large) above ₹1 lakh inter-state, B2C (Small) net of returns, exports (6A: a party whose country isn't India; with payment when IGST is charged, otherwise without payment under LUT), credit notes to registered parties and to unregistered ones against exports or B2C (Large) invoices, nil rated, HSN summary (B2B and B2C), documents issued. **Alt+F marks the month filed**: an invoice or note of a filed month changed later appears in the month of the change as an amendment (B2BA, B2CLA, CDNRA) with the number and date the filed return carried. Enter on an invoice opens it. Alt+J saves the month's return as JSON in the layout of the GST portal's offline tool; choose one month with Alt+F2 first. *The JSON has not yet been loaded into the offline tool; check it there before filing.*
- **GSTR-3B (3):** 3.1(a), (b) exports, (c) nil/exempt, (d) inward supplies under reverse charge; 3.2 inter-state supplies to unregistered persons; 4(A)(3) reverse charge credit, 4(A)(5) other credit, 4(B)(2) reversals, 4(C) net, 4(D)(1) reclaims; payment with credit set off in Rule 88A order (IGST credit first), reverse charge tax in cash.
- **Reverse charge:** mark a purchase or expense ledger (GTA freight, legal fees) "Reverse charge"; a Purchase, Journal or Payment using it reports the supply and its tax (at the ledger's rate) under reverse charge. Don't charge the tax on the invoice.
- **ITC reversal / reclaim:** a Journal with **GST adjustment** set crediting (reversal) or debiting (reclaim) the tax ledgers.
- An export under LUT gets no tax lines suggested; to export with IGST paid, add the IGST line yourself.
- **From Tally:** XML import reads `TAXTYPE`/`GSTDUTYHEAD` on tax ledgers, `PARTYGSTIN`/`LEDSTATENAME` on parties, and `HSNCODE` and the integrated rate under `GSTDETAILS.LIST`.
- Backups carry the GST details, each invoice's breakup, reverse charge ledgers, adjustments and filed months.

## Users and passwords

- **Alt+K → Users and Passwords (U):** a company is open to anyone using the app until its first user, the Owner, is created (press C). From then on it asks for a name and password when opened, and the Edit Log names the user behind every change.
- **Roles**, enforced by the server for every request: **Owner** (everything), **Accountant** (everything except users and passwords), **Data Entry** (see everything; create vouchers and masters, but no alteration, cancellation or deletion), **Viewer** (see everything, change nothing).
- Passwords are stored as scrypt hashes; sessions last 12 hours and stay through a page reload in the same tab. If a session ends mid-work, the sign-in appears over the open screens and nothing typed is lost. **Alt+K → Change Password (P)** for your own password; an Owner can reset anyone's, which signs them out.
- The company keeps at least one Owner. Backups carry the users, so a restored company stays secured.
- A secured company is not served on the Tally XML port, which has no sign-in.

## Orders, notes and stock journals

- **Sales/Purchase Orders** record a party's items, rates and due dates; they move no stock. **Display More Reports → Statements of Inventory (N)** shows what is still pending on them, with the overdue days.
- **Delivery/Receipt Notes** move the goods. Picking the party offers its pending orders; choosing one fills the note's lines. An **invoice** offers the party's pending notes and orders the same way: one made against a note books the sale or purchase without moving the stock a second time. **Sales/Purchase Bills Pending** list notes not yet invoiced.
- Every link is checked on the server: the right type, the same party, the item, and no more than is pending. An order or note that something was made against can't be cancelled, deleted, or cut below what went out.
- **Stock Journal** has a Source (consumption) and a Destination (production) list: transfers between godowns, or manufacture, where a single product takes the materials' cost.
- **Physical Stock** takes what was counted per item and godown; the shortage or excess against the books goes out or in at average cost. The difference is worked out when the count is saved (and again if it is altered), not on later backdated vouchers.
- **Godown Summary** (Inventory Books → G, or Statements of Inventory → G) values each location's stock; Inventory Books also has the Order Books and the Note, Stock Journal and Physical Stock registers. Backups (version 5) and the XML gateway carry all of it.

## Cost centres and interest

- **Cost centres:** Create → Cost Category (A) / Cost Centre (C); every company has "Primary Cost Category", and a centre can sit under another. A ledger with **Cost centres are applicable** (the default for income and expense ledgers once the company has centres) opens **Cost Allocations** after its amount in a voucher: each line offers what is left, and the panel closes when the shares add up (End of List leaves the line unsplit). Not yet on item invoices.
- **Statements of Accounts → Cost Centres (C):** Category Summary, Cost Centre Break-up, Ledger Break-up and Group Break-up, with Enter to drill down.
- **Interest:** give a party, loan or bank ledger an **interest rate (% a year)**; with bill-wise details it can run **on overdue bills** instead of the balance. **Statements of Accounts → Interest Calculations (I)** shows Interest Receivable, Interest Payable, and a ledger's or group's interest, day stretch by day stretch (simple interest, 365-day year). The interest is reported, not booked: post it with a Journal.

## Cheques, post-dated vouchers and exceptions

- **Bank details:** a bank line on a Payment, Receipt or Contra asks for the cheque / DD number and the date on it (Enter moves on, Esc skips). For a payment the next leaf of that bank's book is suggested (000123 → 000124).
- **Banking (N):** Cheque Printing (P, Enter prints the cheque on the standard CTS-2010 leaf with payee, amount in words and figures, date boxes and "A/c Payee"), Cheque Register (C, cleared / not cleared / post-dated), Post-Dated Summary (D), Deposit Slip (S, received cheques not yet cleared) and Payment Advice (A, a letter to the payee with the cheque and bills).
- **Post-dated (Ctrl+T, or the Post-dated button in a browser, which keeps Ctrl+T for a new tab):** the voucher is listed as post-dated until its date. It still counts in any report whose period covers that date.
- **Exception Reports (X):** besides overdue bills, Negative Ledgers (balance-sheet ledgers on the wrong side, such as Cash in credit), Negative Stock, Cancelled Vouchers (with who cancelled them) and Post-Dated Vouchers.

## Mailing details, compound units, optional and memorandum vouchers

- **Ledger mailing details** (party, bank and loan ledgers): mailing name, address, country, PIN code, phone, e-mail and PAN. The PAN must be a valid one and match the GSTIN; an Indian PIN code has six digits. Printed invoices, notes and orders carry the buyer's or supplier's block (name, address, state and PIN, GSTIN, PAN) and list their items.
- **Compound units:** Create → Unit, Type **C**ompound: a first unit, a conversion and a second unit ("Box of 12 Nos"). Quantities are kept in the second unit; type **2-5** for 2 Box 5 Nos (or **2** for 2 Box), and reports show "2 Box 5 Nos". Rates are per the second unit (per Nos).
- **Optional vouchers** (Ctrl+L, or the Optional button in a browser, which keeps Ctrl+L for its address bar) and **Memorandum vouchers** (Ctrl+F10) are kept with their lines but stay out of every balance, report, bill and stock figure. Making an optional voucher regular posts it with the usual checks. Exception Reports lists them (O, M).

## Cash Flow, Funds Flow, Ratio Analysis and stock analysis

- **Ratio Analysis** (Gateway **R**): Tally's principal groups (working capital, cash, bank, debtors, creditors, sales, purchases, stock, net profit, turnovers) beside its principal ratios (current, quick, debt/equity, gross and net profit %, operating cost %, receivable days, return on investment and on working capital), as at the end of the period.
- **Cash Flow** (Display More Reports, **C**): inflow, outflow and net flow of cash and bank month by month, from the opening to the closing balance. Enter on a month (or the Grand Total) lists the groups the money came from and went to. A Contra between cash and bank is not a flow.
- **Funds Flow** (Display More Reports, **F**): sources and applications of funds (the period's profit or loss, and each group outside working capital that fell or rose), then the working capital changes group by group. Sources less applications always equals the change in working capital.
- **Statements of Inventory**: **Movement Analysis** (inward and outward quantity, value and average rate per item; Enter shows them party by party), **Ageing Analysis** (the stock in hand spread over the latest receipts, first in first out, in 0–45, 45–90, 90–180 and over-180-day brackets) and **Reorder Status** (closing stock plus purchase orders pending, less sales orders due, against the item's reorder level, rounded up to its minimum order). Reorder level and minimum order are set on the stock item and come in from Tally XML (REORDERBASE, MINIMUMORDERBASE). Orders and transfers between godowns are not movement.

## e-Invoice, e-Way Bill and e-mail

- **Company Details** (Alt+K, **D**): mailing name, address (the last line is the town), PIN code, phone and e-mail. They make the seller block of e-Invoices and e-Way Bills.
- **e-Invoice and e-Way Bill** (GST Reports, **E**): every sale, purchase and note with GST in the period, with what each needs ("ready", "n to fix", the IRN or e-Way Bill number once done). Enter opens a voucher: the reasons the portal would refuse it (no PIN code, a bad HSN, no vehicle number…), the transport details (mode, distance, vehicle or transporter, LR/RR), and the fields for what the portal gives back. **Alt+J** saves the e-Invoice JSON (IRP schema 1.1) of the ticked vouchers (Space ticks; none ticked = all ready), **Alt+W** the e-Way Bill bulk-upload JSON.
- Without a GSP account the files are uploaded by hand on einvoice1.gst.gov.in and ewaybillgst.gov.in; paste the IRP's signed QR code back (the IRN is read from it and checked against the voucher number) and type the e-Way Bill number. The printed invoice then shows the IRN, Ack No., e-Way Bill number and the QR code.
- Units can name their GST unit code (UQC) when the symbol isn't one GST knows (Crate → CTN); Tally XML's GSTREPUOM comes in too.
- **E-mail** (**Alt+M** on any screen, or the E-mail button): the screen as it looks (a printed invoice, a ledger statement, a report) goes out as HTML through your own SMTP server. A voucher's print fills in the party's e-mail and the subject. Set the server under Alt+K, **E**-mail Settings (with a test send); the password is never shown again or put in backups. Alt+K, E-mail **L**og lists what was sent and what the server refused.

## Voucher types, features (F11), stock categories and Stock Query

- **Voucher types of your own** (Create/Alter, **V**oucher Type): a name ("Sales - Export"), the predefined type it is (Sales), and its numbering. Automatic numbering takes a prefix, starting number, width and suffix, where **{FY}** stands for the financial year: `INV/{FY}/` with width 3 gives INV/26-27/001. It can restart each year (then {FY} is required, so years never share a number). Manual numbering asks for the number on each voucher and refuses one already used. A print title ("Export Invoice") heads the printed voucher, and a type can be set not in use.
- **F10** lists your voucher types after the predefined ones; the voucher screen names the type and, for manual numbering, asks for the number. The number shown (INV/26-27/001) is used everywhere: Day Book, statements, registers, the printed voucher, the Edit Log, e-Invoice and e-Way Bill, Tally XML export, and GSTR-1, whose documents-issued table lists each series. Once a type has vouchers of your own types, its plain vouchers keep their own unbroken series.
- **Company Features** (**F11**, or Alt+K **F**): switch off what the company doesn't use (inventory, godowns, orders, stock categories, bill-wise, cost centres, interest, GST, cheques, optional vouchers, e-Invoice, e-mail). Their menus and voucher types go; nothing recorded is lost, and switching back on brings it all back.
- **Stock categories** (Create/Alter, Stock Ca**t**egory) cut across stock groups (a brand, a size). Stock items take one, and **Stock Category Summary** (Inventory Books, **C**) totals the items by category, with Enter opening a category.
- **Stock Query** (Statements of Inventory, **Q**): one item at a glance, with its group, category, HSN and rate, stock and value, average cost, stock by godown, the last five purchases and sales, what is on order, and the reorder level.

## GST classifications, taxability, Statistics and the Dashboard

- **GST Classification** (Create/Alter, **S**, under Statutory Masters): an HSN/SAC with its rate and taxability, kept once and picked on stock items and ledgers. GST then reads the classification's details over the master's own, so one change of rate reaches every item under it from the next invoice on; saved invoices keep the breakup they were posted with. A classification in use can't be deleted.
- **Taxability** on items, ledgers and classifications: Taxable, Exempt, Nil Rated or Non-GST. Untaxed supplies are reported apart: GSTR-1 table 8 (inter- or intra-state, to registered or unregistered persons; also in the portal JSON), GSTR-3B 3.1(c) and 3.1(e), and table 5 for inward supplies. B2B and B2C rows carry only the taxed lines; an invoice of untaxed goods alone is in table 8 only. Non-GST goods have no HSN line.
- **Income & Expenditure A/c** (F11, off by default): for a non-profit, the Profit & Loss A/c becomes one Income & Expenditure account, closing with the excess of income over expenditure (or the other way), and the Gateway and Balance Sheet use that name.
- **Statistics** (Statements of Accounts, **T**): vouchers of each type in the period, your own voucher types under their predefined one, with cancelled and optional ones counted apart, and how many masters of each kind. Enter opens the type's register.
- **Dashboard** (Gateway, **G**): cash, bank, receivables, payables, sales, purchases, profit and closing stock for the period; sales and purchases month by month; the five largest receivables and payables. A tile or a party opens the report behind it.
- The Edit Log now also records voucher types, stock categories and GST classifications, and its filter accepts every kind of master.

## TDS

- Switch it on in **F11** (off by default, as in Tally), then **Alt+K, TDS Details**: the TAN, deductor type and the person responsible. The first save adds the standard **natures of payment** (194C contractors, 194J professional and technical fees, 194I rent, 194H commission, 194A interest, 194Q purchase of goods) with their 2025-26 rates and limits; alter them, or add more, under Create/Alter, TDS **N**ature of Payment.
- Mark each supplier or contractor with its **deductee type** (Individual/HUF, Company, Firm…) and PAN; give expense ledgers, and TDS ledgers under Duties & Taxes, their nature of payment.
- On a voucher, the **TDS due** shows under the lines, counting the year's earlier payments to the party: nothing below the limits; a payment above the single limit is taxed; when the year's total first passes the annual limit, the year's untaxed amounts are taxed too; 194Q taxes only the part above ₹50 lakh; without a PAN the 206AA rate applies. **Alt+T** books it on the TDS ledger and takes it off the party's credit.
- **TDS Reports** (Display More Reports, Statutory, **T**): **TDS Computation** (each voucher's amount, what was due, what was deducted, with short deductions and missing PANs flagged), **TDS Outstandings** (by nature: due, deducted, paid, payable; payments of TDS, where Enter records the challan's BSR code, serial and date), and **Form 26Q** (keys 1-4 pick the quarter: deductor, deductee details matched to the challans that paid them, problems to fix; Alt+J saves the deductee sheet as CSV for the government's Return Preparation Utility).
- What is due is worked out from the entries each time a report or voucher asks, so altering an earlier voucher is reflected everywhere. Backups (version 14) carry the TAN, natures, ledger settings and challans.

## TCS, Form 27Q and challans

- Switch on **TCS** in **F11**. The TDS Details save adds the standard **natures of goods** of section 206C (liquor, timber, forest produce, scrap, tendu leaves, minerals, motor vehicles above ₹10 lakh) with their Form 27EQ collection codes; alter or add them under Create/Alter, TCS Nature of Goods (**X**). Give the sales ledger and the TCS ledger (under Duties & Taxes) the nature, and the buyer its type and PAN.
- On a sale the **TCS due** shows under the lines: on what the buyer is charged, GST included; without a PAN, section 206CC (twice the rate or 5%). **Alt+T** books it on the TCS ledger and adds it to the buyer's debit; on an item invoice it is added as a line and the invoice total follows.
- **TCS Reports** (Display More Reports, **E**): TCS Computation, TCS Outstandings, **Form 27EQ** (collectee details with collection codes, matched to challans; Alt+J CSV) and Challan Reconciliation.
- A party whose country is not India is a non-resident: its TDS (the 195 nature is added) goes on **Form 27Q** (TDS Reports, **7**, with the country), not on 26Q.
- **Challan Reconciliation** (TDS or TCS Reports, **R**): every payment of TDS and TCS in the period, what the deductions and collections account for and what is unallocated; type the BSR code, challan number and date of each and save them together with Ctrl+A.

## GST cess, MSME interest, payroll loans and the rest

- **Cess**: a cess rate (%) on stock items and taxable ledgers; invoices work it out per line, suggest it on the Cess ledger and flag a wrong amount; GSTR-1 (and its portal file) carries `csamt`, GSTR-3B pays cess from cess credit only, the e-Invoice carries `CesRt`, `CesAmt` and `CesVal`.
- **GSTR-3B 5.1**: interest at 18% a year on tax paid in cash after the 20th, and the late fee (₹25 + ₹25 a day, ₹10 + ₹10 for a nil return, capped by last year's turnover); give the date it is filed.
- **Exports**: port code, shipping bill number and date on a sale to a party abroad; in GSTR-1 table 6A and the e-Invoice.
- **Further registrations**: GSTR-2B and GSTR-1 files go with the GSTIN they name; reconciliations, advances and GSTR-9 per registration.
- **Payroll**: loans and advances recovered in instalments by the Auto Fill; arrears of a back-dated revision, month by month, paid on an arrears head; old-regime declarations (rent for the HRA exemption, 80C, 80D, 80CCD(1B), 24(b)) with Basic and HRA marked on pay heads; Statutory Payment posts what is due to PF, ESI, PT, TDS or NPS, with the PF challan's accounts.
- **Manufacturing**: several bills of materials per item by name; by-products with a share of the cost, scrap valued at its rate off the cost.
- **TDS**: section 197 certificates (rate, period, amount covered) and DTAA rates per party; Forms 26Q/27Q show reason A, the certificate number or the DTAA rate.
- **MSME**: interest on late payments to micro and small suppliers (section 16): compound, monthly rests, three times the bank rate you give.
- **Interest**: book a ledger's interest with a Journal (a new bill for a bill-wise party).
- **Trial Balance**: a budget's figures and the variance beside the groups and ledgers it budgets.
- **Item invoices**: the sales or purchase ledger split across cost centres.
- **Security levels**: your own levels on Accountant, Data Entry or Viewer, taking away voucher types and reports, and limiting how far back a voucher is dated.
- **XML**: foreign-currency lines ("$ 100.00 @ ₹ 83.25/$ = ₹ 8325.00"), compound-unit quantities ("2 Box 5 Nos"), reversing journals (`APPLICABLEUPTO`) both ways.
- **E-mail**: Alt+M attaches the screen as a PDF too.

## Hindi

- **Language** (F12, *Language (this computer)*): Hindi or English for the Home menu, every menu, screen titles and the button bar; each computer keeps its own choice. Hotkeys stay the English letters, shown beside the Hindi words. Terms like GSTR-1 and TDS stay as they are.
- **Transliteration**: with the screens in Hindi, the **अ** button by a ledger, group or stock item's name writes what was typed in Roman letters in Devanagari, ITRANS-style: *Sharma* शर्मा, *Raam* राम, *Shree Ganesh* श्री गनेश, *kShetra* for क्ष.
- Field labels, column headings, section headings and buttons on forms and reports follow too; table cells, entries and selections are never changed, so the books' own names stay as entered. Long statutory titles (GSTR tables, PF/ESI terms) stay in English.

## GST registrations, the 2025 Act's TDS forms, payment gateways

- **Further GST registrations (tax units)**: in GST Registration, add a branch's GSTIN (same PAN, another state). A voucher type set to that registration (Alter, Voucher Type) taxes its vouchers from the branch's state, and **GSTR-1** and **GSTR-3B** have a registration choice in the title to show each GSTIN's own return (and its GSTR-1 file). A voucher type in use keeps its registration.
- **Income-tax Act, 2025**: from tax year 2026-27 the quarterly statements are **Form 140** (was 26Q), **Form 144** (was 27Q) and **Form 143** (was 27EQ); the screens and files carry the new names, and quarters up to March 2026 keep the old ones. The natures of payment keep the 1961 Act's section numbers: enter the new Act's section codes on them where the return utility asks for them.
- **Payment Gateway Reconciliation** (Banking, **G**): name the gateway, choose its ledger (under Bank Accounts, where customer receipts are taken in) and upload its settlement report (.csv or .xlsx, a row per payment: id, date, amount, fee, GST on the fee, settlement, settled on; column names are matched loosely). Each payment is matched to a receipt (by its id in the narration, else by amount within three days) or shown *Not in books*; receipts the report lacks are listed. **Post receipt** books a settlement in one Receipt: the net into the bank, the fee and its GST debited, the gross off the gateway ledger.
- **Kerala Flood Cess** (GST Reports, **K**): for a dealer registered in Kerala, 1% (0.25% on goods at 3%) on intra-state supplies to unregistered buyers, 1 August 2019 to 31 July 2021.
- Backups (version 23) carry the registrations, voucher types' registrations and gateway payments.

## Post-dated vouchers, batches, cost tracking, cheque layouts

- **Post-dated vouchers** (Ctrl+T or the Post-dated button): a voucher dated after today is kept out of the books until its date, as in Tally: no ledger, bill or stock moves, and it is listed in Post-Dated Vouchers. On its day the server posts it (the Edit Log says "post-dated voucher, posted on its date"). One dated today or earlier is posted at once.
- **Batches**: set *Maintain in batches* on a stock item. Every invoice or inventory voucher line of it names its batch (pick from the batches in stock, or type a new one); goods coming in carry the dates of manufacture and expiry. Goods going out must be in that batch and godown on the voucher's date. The item's opening stock is batch *Opening Stock*. **Batches** (Statements of Inventory, **T**) lists each batch in stock with its expiry and days left.
- **Cost tracking** (F11, off by default): vouchers and invoices get a *Cost track* field (a job, an order, a consignment). **Cost Tracking** (Display More Reports, **K**) shows each track's sales, costs, margin and the goods in and out.
- **Cheque layouts**: on the cheque print, *Layout for <bank>* edits where the date, payee, amount in words and figures and the signatory go on that bank's leaf (in mm), the leaf's size and the crossing; saved per bank, and *Back to the standard leaf* returns to CTS-2010.
- Backups (version 22) carry held vouchers, batches, cost tracks and cheque layouts.

## Audit, POS, order analysis, HTTPS, ODBC, more XML

- **Tally Audit** (Display More Reports, **U**): every voucher of the period with who entered it and when, its last alteration and how many, and its audit status. Tick vouchers and mark them *audited* or *under observation* (with a note), or clear the mark; a voucher altered after its mark shows **Altered after audit**. The auditor is the signed-in user.
- **POS Register** (Account Books, **O**): mark a Sales voucher type *Use for POS invoicing* (Alter, Voucher Type); its vouchers are listed with what was paid in cash, by card or bank, and left on credit, with totals by day.
- **Sales / Purchase Order Analysis** (Statements of Inventory, **O** / **H**): what was ordered in each month of the period, by item or by party, with what has been delivered against it and what is pending.
- **Tracked Vouchers** (Exception Reports, **T**): delivery and receipt notes not yet (fully) invoiced, with their age.
- **HTTPS**: set `TLS_CERT` and `TLS_KEY` (PEM files) in `server/.env` and the server speaks HTTPS: use it with `HOST=0.0.0.0` when other PCs sign in over the network.
- **ODBC / SQL**: read-only views in the `odbc` schema (`company`, `groups`, `ledger`, `voucher`, `ledger_entry`, `stock_item`, `inventory_entry`), amounts in rupees with debits positive. Excel, Power BI or any reporting tool connects through the PostgreSQL ODBC driver (psqlODBC) to the server's database; give it a user that can only read the `odbc` schema (`GRANT USAGE ON SCHEMA odbc TO reader; GRANT SELECT ON ALL TABLES IN SCHEMA odbc TO reader`). The desktop app's built-in database is not reachable this way.
- **XML gateway**: besides importing masters and vouchers and exporting the Trial Balance, accounts and Day Book, it exports the **Balance Sheet**, **Profit and Loss**, **Stock Summary**, **Ledger Vouchers** (with `LEDGERNAME`) and **Bills Receivable / Payable**. The Day Book export carries item lines (`ALLINVENTORYENTRIES.LIST`, or `INVENTORYENTRIESIN/OUT.LIST` for a Stock Journal) with their godown, batch, `MFDON` and `EXPIRYPERIOD` under `BATCHALLOCATIONS.LIST`, the party, `ISOPTIONAL`, `ISPOSTDATED` and the cost track, and an optional or post-dated voucher's lines; importing it into another company brings all of that back. In one import, a batch bought by an earlier voucher can be sold by a later one.
- Backups (version 21) carry POS voucher types and audit marks.

## Import from Excel, F12, split company, group company

- **Import from Excel** (Alt+Y, **I**): ledgers, stock items or vouchers from an .xlsx (its first sheet) or a CSV file whose first row names the columns, in any order and named loosely ("Under" or "Group", "Opening Balance" or "Op Bal"). **Download the template** gives a sheet to fill. Vouchers: a row with a date starts a voucher (Debit and Credit columns, or Amount with Dr/Cr); the rows below with the date blank are its other lines. A Sales or Purchase row can also name a stock item with its quantity and rate (and godown, batch, Mfg Date and Expiry); its value is quantity × rate. Stock items take a *Batches* column (Yes/No). A unit not yet made is made. Every row that could not be imported is listed with its row number and why; the rest go in.
- **F12 Configuration**: the date of a new voucher (today, or the last voucher's), current balances in voucher entry, a warning before cash or a bank goes below zero, narrations in the Day Book. (A browser may keep F12 for its developer tools; the desktop app does not.)
- **Split Company Data** (Alt+Y, **S**): two new companies at a date: the books up to the day before, and from the date with the first's closing balances, pending bills and stock as opening (stock in the main godown). The company split is left as it was.
- **Group companies** (on the Select Company screen): two or more companies shown together, with a consolidated Balance Sheet, Profit & Loss A/c and Trial Balance; groups and ledgers of the same name are one line, and nothing between the members is eliminated. Companies with users and passwords cannot be members.

## GST reconciliation, annual and composition returns

- Purchases and debit notes carry the **supplier's invoice number and date** (beside the voucher number); GSTR-2B matches on them.
- **GSTR-2B Reconciliation and IMS** (GST Reports, **2**): upload the GSTR-2B JSON downloaded from the portal; each invoice and note is *Matched*, a *Mismatch* (date, taxable value or tax differs by more than a rupee) or *Not in books*, and purchases the 2B lacks are listed apart. Numbers match ignoring spaces, slashes, dashes and leading zeros. Accept, reject or leave each pending (IMS) and save with Ctrl+A; the credit shown is that of documents not rejected. Uploading the month again keeps the actions.
- **GSTR-1 Reconciliation** (**L**): upload the GSTR-1 as filed (or the file this app made) to compare it with the books' B2B invoices and credit notes.
- **Advances (11A/11B)** (**A**): a Receipt with an *Advance GST rate* and an Advance bill is an advance for services taxed on receipt; what is unadjusted at the month's end is in 11A, what invoices adjust (Agst Ref to the advance) in 11B. GSTR-3B adds the net tax to 3.1(a).
- **GSTR-9** (**9**): tables 4, 5, 6-8 (with 8A from the uploaded 2Bs as accepted in IMS), 9, 17 and 18 for the financial year, from the year's GSTR-1 and the twelve GSTR-3Bs.
- **Composition**: in GST Registration choose *Composition* and the rate; **CMP-08** (**8**, keys 1-4 pick the quarter) and **GSTR-4** (**4**) follow.
- **Challan Reconciliation** (**C**): Payments that debit the GST ledgers, by tax, with their CPIN, CIN and date (typed in and saved together), against what GSTR-3B says is due in cash.
- **Party GSTIN Update** (**U**): every party's GSTIN at once; the state and PAN follow it.
- Backups (version 20) carry all of it.

## Budgets, scenarios and reversing journals

- **Budget** (Create/Alter, **Q**): a name, a parent budget, a period, and amounts for groups, ledgers or cost centres, each on the nett transactions of the period or on the closing balance at its end (expenses Dr, income Cr).
- **Budget Variance** (Display More Reports, **B**): each line of a budget against the books, with the variance and the actual as a share of the budget; it can be seen under a scenario too.
- **Reversing Journal** (F10, **V**): an accrual or provision kept out of the books, effective up to its *applicable up to* date. **Reversing Journal Register** (Exception Reports, **V**) lists them and whether each is still effective.
- **Scenario** (Create/Alter, **Z**): whether the books (actuals) are included, and which vouchers kept out of them are: reversing journals, optional vouchers, memorandum vouchers. **Trial Balance, Profit & Loss and Balance Sheet** have a scenario choice in the title when the company has scenarios: the provisional books with the accruals, or only the optional vouchers.
- Backups (version 19) carry budgets, scenarios and the reversing journals' dates.

## MSME

- **Party MSME Update** (Display More Reports, MSME Reports, **U**): the type of enterprise (micro, small, medium), Udyam registration number and activity of every party, edited together.
- **MSME Form 1** (MSME Reports, **F**; keys 1-2 pick the half-year): bills of micro and small suppliers unpaid at the half's end beyond the time the Act allows (the agreed credit period up to 45 days, else 15), by supplier with the date the amount fell due. At the year end it is also the section 43B(h) list. Only bill-wise amounts count.
- Backups (version 18) carry the natures' kind and collection codes and the MSME details.

## Multi-currency

- Switch it on in **F11** (off by default). Create a **Currency** (Create, **Y**: symbol, formal name, decimal places) and give it **Rates of Exchange** (Create, **R**) by date: the standard rate values balances, the selling rate is offered on payments and the buying rate on receipts (each falls back to the standard rate). A rate holds until the next date that has one.
- A party, bank account or loan can be kept in a currency (**Currency of ledger**, with its opening balance in the currency). On a voucher, its line takes the amount in the currency **@** the rate, and the rupees follow; an amount of **0** makes the line a forex adjustment whose rupees are typed. An item invoice to such a party asks for the rate of exchange and shows the invoice value in the currency. The books stay in rupees; the foreign amount is exact to the currency's smallest unit, so an invoice priced in rupees may differ from it by less than half a cent's worth.
- Bills keep their share of the foreign amount, and the ledger statement shows each entry and the running balance in the currency too.
- **Forex Gain/Loss** (Exception Reports, **F**): each foreign-currency ledger valued at the standard rate on a date against its rupees, bill by bill (a bill settled in full in the currency shows its realised gain or loss, an open one its unrealised). **Alt+J** books one Journal that takes each ledger (and bill) to that value against a gain/loss ledger; a Journal may adjust a foreign-currency bank account's rupees this way, but not move its currency.
- Backups (version 15) carry currencies, rates, ledgers' currencies and every foreign amount.

## Payroll

- Switch it on in **F11** (off by default). As in Tally, **employee categories** are cost categories, **employee groups** and **employees** are cost centres (with the employee's joining and leaving dates, designation, bank account, PAN, UAN, PF number, ESI IP number, PRAN and tax regime), so the cost centre reports show salaries by employee.
- **Attendance/Production Types**: attendance, leave with pay, leave without pay, or production (pieces, hours).
- **Pay Heads** are ledgers with a way of working out the amount: a value typed in the voucher, a flat rate, on attendance (the rate for the days worked, or the days on the rolls less leave without pay, of the calendar's days or a fixed number), on production (a rate per unit), or computed from other pay heads through slabs (a rate, a fixed value, a ceiling on the base), rounded normally, up or down. Statutory pay heads start with the law's figures: PF 12%, EPS 8.33% of wages up to ₹15,000, the employer's EPF after EPS, EDLI and admin charges, ESI 0.75% / 3.25% for wages up to ₹21,000 (rounded up), professional tax slabs (Karnataka's to start), NPS 10%, and **income tax on salary** (the year's salary so far plus this month's for the months left, less the standard deduction, taxed in the employee's regime with the 87A rebate and cess, less what was deducted, spread over the months left). An employer's contribution is credited to its pay head and debited to its expense ledger.
- **Salary Details** for an employee or a whole group, from a date; an employee without their own takes the group's.
- **Attendance** voucher (F10, **A**): days, hours or units per employee and type; it has no ledger entries. **Payroll** voucher (F10, **Z**): the pay period and the ledger credited with the net pay; **Ctrl+F Auto Fill** works out every employee's pay (typed amounts for user-defined pay heads re-run it) and makes the entries, each pay head split by employee.
- **Payroll Reports** (Display More Reports, **P**): Pay Sheet (Alt+J CSV), Payslip, Attendance Sheet, Payroll Register, and the statutory reports: Provident Fund with the EPFO **ECR** text file (Alt+J), ESI with the monthly contribution file (Alt+J), Professional Tax by month, Income Tax on Salary with **Form 16 Part B** for each employee and **Form 24Q** Annexure I as CSV (Alt+J), Gratuity (15/26 of the last month's wages for each year of service, due after five years, up to ₹20 lakh), and NPS.
- Backups (version 16) carry the payroll masters, salary details and attendance.

## Manufacturing and job work

- **Bill of Materials** (Create/Alter, **J**): what a quantity of an item is made from. **Cost Estimation** (Statements of Inventory, **E**) costs any quantity from its components at their average cost on the date; a component with no cost of its own is costed from its own bill of materials.
- **Manufacturing Journal** (F10, **F**): the items produced and the components consumed (**Alt+B** fills the components from the bill of materials for the quantity produced), plus an additional cost (labour, power). When saved, the components go out at average cost and the production takes their cost plus the additional cost.
- **Rejections In** (F10, **I**) takes back goods a customer rejected; **Rejections Out** (F10, **T**) returns goods to a supplier. Both take the party and move stock only.
- **Job work** (F11, off by default). A godown can hold *our stock with a third party* (a job worker) or *a third party's stock with us* (a principal's materials, which are not our stock and are left out of every valuation). **Job Work Out Order** (F10, **Q**): what a job worker is to make for us; **Material Out** (F10, **X**) sends materials from our godown to theirs at cost; **Material In** (F10, **W**), against the order, receives the finished goods and consumes the materials at the job worker, the goods taking their cost plus the job work charges. **Job Work In Order** (F10, **B**) is the principal's side, with materials received by Material In into a third party's godown and goods sent back by Material Out.
- **Job Work Reports** (Display More Reports, **J**): orders out and in with what is received or sent back and still pending, our stock with job workers at value, and principals' stock with us. Registers for each voucher type are under Inventory Books.
- Backups (version 17) carry bills of materials, the godowns' third-party setting and additional costs.

## Not built yet

- Generating the IRN and e-Way Bill directly from the app (GSP/NIC API): needs your GSP or NIC API credentials; the JSON upload works without them
- Filing returns directly (GSTR-1/3B/9/4) through a GSP: prepare here, upload or file on the portal
- TDS: the FVU text file of Forms 140/144/143 (26Q/27Q/27EQ): use the CSV with the government's Return Preparation Utility, which makes and validates it; the 2025 Act's section codes on the standard natures (the 1961 Act's sections are shown)
- Remote access through a relay (Tally.NET): host the server edition with HTTPS (`HOST`, `TLS_CERT`, `TLS_KEY`, a certificate of your own) to reach it from outside the office
- Languages besides Hindi and English (Tally also offers Gujarati, Marathi, Tamil and others)
- TDL customisation (Tally's own language for add-ons) is not supported
- E-mailed PDFs are plain text layouts (Courier); the HTML in the message keeps the screen's look
