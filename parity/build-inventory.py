"""Writes parity/features.json: every TallyPrime feature we measure ourselves against.

Sources (all from the installed TallyPrime 1.1.7.2, read with REA):
  * the menu tree reachable from Gateway of Tally (the TDL [Menu:] definitions),
  * master types that have their own creation report in the TDL,
  * voucher types (each has its own register in Account/Inventory Books),
  * platform capabilities Tally documents (printing, users, backup, ODBC, ...).
Only names and menu paths are recorded, never Tally source. Other countries' VAT
reports (Gulf, Kenya) are out of scope for an India-first product and are not listed.

tier: 3 = daily bookkeeping, 2 = common, 1 = specialist. Used for the weighted score.
status: done | partial | missing. Re-run this script only to change the inventory; edit
statuses in features.json directly as features land.
"""
import json, os

F = []
def add(area, names, tier, path, status='missing', note=''):
    for n in names if isinstance(names, list) else [names]:
        F.append({'area': area, 'name': n, 'tier': tier, 'tally': path, 'status': status, 'note': note})

# ---------------------------------------------------------------- masters
add('Masters', 'Group', 3, 'Create > Group', 'done', 'create, alter, delete; nature follows parent')
add('Masters', 'Ledger', 3, 'Create > Ledger', 'partial', 'name, group, opening, GSTIN/state; no bill-wise, credit period, mailing details')
add('Masters', ['Voucher Type'], 2, 'Create > Voucher Type')
add('Masters', ['Currency'], 1, 'Create > Currency')
add('Masters', ['Cost Category', 'Cost Centre'], 2, 'Create > Cost Centre')
add('Masters', ['Budget', 'Scenario'], 1, 'Create > Budget / Scenario')
add('Masters', ['GST Registration (Tax Unit)', 'GST Classification'], 2, 'Create > GST')
add('Masters', ['TDS Nature of Payment'], 1, 'Create > TDS')
add('Masters', ['Stock Item', 'Unit', 'Stock Group', 'Godown / Location'], 3, 'Create > Inventory masters')
add('Masters', ['Stock Category'], 1, 'Create > Stock Category')
add('Masters', ['Employee', 'Employee Group', 'Employee Category', 'Pay Head', 'Attendance / Production Type'], 1, 'Create > Payroll masters')
add('Masters', 'Closing stock (accounts-only)', 2, 'Ledger closing balance for Stock-in-Hand', 'done', 'stock valuation by date')

# ---------------------------------------------------------------- vouchers
for v in ['Contra', 'Payment', 'Receipt', 'Journal', 'Sales', 'Purchase']:
    add('Vouchers', v, 3, f'Vouchers > {v}', 'done', 'accounting mode')
for v in ['Credit Note', 'Debit Note']:
    add('Vouchers', v, 2, f'Vouchers > {v}', 'done', 'accounting mode')
add('Vouchers', ['Sales/Purchase in item-invoice mode'], 3, 'Vouchers > Sales (Item Invoice)', 'missing', 'needs inventory')
add('Vouchers', ['Memorandum', 'Reversing Journal', 'Post-dated vouchers', 'Optional vouchers'], 1, 'Vouchers > other types')
add('Vouchers', ['Sales Order', 'Purchase Order', 'Delivery Note', 'Receipt Note', 'Stock Journal', 'Physical Stock'], 2, 'Vouchers > inventory types')
add('Vouchers', ['Manufacturing Journal', 'Rejections In', 'Rejections Out', 'Material In', 'Material Out',
                 'Job Work In Order', 'Job Work Out Order'], 1, 'Vouchers > inventory types')
add('Vouchers', ['Payroll', 'Attendance'], 1, 'Vouchers > payroll')
add('Vouchers', 'Voucher alteration, cancel, delete', 3, 'Day Book > Alter / Alt+X / Alt+D', 'done')

# ---------------------------------------------------------------- gateway reports
add('Reports', ['Balance Sheet', 'Profit & Loss A/c', 'Trial Balance', 'Day Book', 'Chart of Accounts'], 3, 'Gateway', 'done')
add('Reports', 'Drill-down from reports to vouchers', 3, 'Enter on any report line', 'partial', 'TB group -> ledger -> statement -> voucher; BS/P&L not yet')
add('Reports', ['Stock Summary'], 3, 'Gateway > Stock Summary')
add('Reports', ['Ratio Analysis', 'Cash Flow', 'Funds Flow', 'Income & Expense A/c', 'Dashboard', 'Statistics'], 2, 'Gateway / Final Accounts')

# ---------------------------------------------------------------- account books
add('Account Books', 'Ledger (vouchers with running balance)', 3, 'Account Books > Ledger', 'done', 'no monthly summary level yet')
add('Account Books', ['Cash/Bank Books', 'Group Summary', 'Group Vouchers'], 3, 'Account Books')
add('Account Books', ['Sales Register', 'Purchase Register', 'Payment Register', 'Receipts Register', 'Journal Register',
                      'Contra Register', 'Debit Note Register', 'Credit Note Register'], 2, 'Account Books > registers')
add('Account Books', ['POS Register'], 1, 'Account Books > POS Register')

# ---------------------------------------------------------------- statements of accounts
add('Outstandings', ['Bill-wise receivables', 'Bill-wise payables', 'Ledger outstandings', 'Group outstandings',
                     'Overdue receivables', 'Overdue payables'], 3, 'Statements of Accounts > Outstandings')
add('Interest', ['Interest Receivable', 'Interest Payable', 'Ledger interest', 'Group interest'], 1, 'Statements of Accounts > Interest')
add('Cost Centres', ['Cost Centre Summary', 'Cost Category Summary', 'Cost Centre Break-up', 'Ledger Break-up', 'Group Break-up'], 1, 'Statements of Accounts > Cost Centres')

# ---------------------------------------------------------------- banking
add('Banking', ['Bank Reconciliation', 'Bank Statement import'], 3, 'Banking')
add('Banking', ['Cheque Printing', 'Cheque Register', 'Post-dated cheque summary', 'Deposit Slip', 'Payment Advice'], 2, 'Banking')
add('Banking', ['Payment gateway reconciliation'], 1, 'Banking')

# ---------------------------------------------------------------- inventory reports
add('Inventory Reports', ['Stock Item vouchers', 'Godown Summary', 'Stock Group Summary', 'Stock Query', 'Ageing Analysis',
                          'Reorder Status'], 2, 'Inventory Books / Statements')
add('Inventory Reports', ['Stock Category Summary', 'Batch/Godown vouchers', 'Movement Analysis', 'Cost Estimation',
                          'Item Cost Track', 'Sales Order analysis', 'Purchase Order analysis', 'Sales bills pending',
                          'Purchase bills pending', 'Order/note registers'], 1, 'Inventory Books / Statements')
add('Inventory Reports', ['Job work reports'], 1, 'Display More Reports > Job Work')

# ---------------------------------------------------------------- GST & statutory (India)
add('GST', ['GSTR-1', 'GSTR-3B', 'GST on vouchers (CGST/SGST/IGST)', 'e-Invoice (IRN)', 'e-Way Bill'], 3, 'Statutory > GST')
add('GST', ['GSTR-9 annual', 'GSTR-2A/2B reconciliation', 'GSTR-1 reconciliation', 'Challan reconciliation',
            'Reverse charge', 'Advances received/paid', 'GST rate setup', 'Party GSTIN update'], 2, 'Statutory > GST')
add('GST', ['CMP-08', 'GSTR-4', 'IMS inward', 'Kerala flood cess', 'UQC setup'], 1, 'Statutory > GST')
add('TDS / TCS', ['TDS on vouchers', 'Form 26Q', 'TDS outstandings'], 2, 'Statutory > TDS')
add('TDS / TCS', ['Form 27Q', 'Form 140/144', 'TDS challan reconciliation', 'TCS on vouchers', 'Form 27EQ', 'TCS outstandings'], 1, 'Statutory > TDS / TCS')
add('Payroll', ['Payslip', 'Pay Sheet', 'Attendance Sheet', 'Payroll Register', 'PF reports', 'ESI reports',
                'Professional Tax', 'Income tax on salary (Form 16, 24Q)', 'Gratuity', 'NPS'], 1, 'Payroll Reports')
add('MSME', ['MSME Form 1 Annexure', 'Party MSME update'], 1, 'Statutory > MSME')

# ---------------------------------------------------------------- exception / audit
add('Exceptions & Audit', ['Cancelled vouchers', 'Negative ledgers'], 2, 'Exception Reports')
add('Exceptions & Audit', ['Memorandum register', 'Reversing journal register', 'Optional vouchers', 'Post-dated vouchers',
                           'Negative stock', 'Tracked vouchers'], 1, 'Exception Reports')
add('Exceptions & Audit', ['Edit Log (audit trail)'], 3, 'Display More Reports > Edit Log', 'missing', 'mandatory audit trail for Indian companies')
add('Exceptions & Audit', ['Tally Audit / verification'], 1, 'Statements of Accounts > Tally Audit')

# ---------------------------------------------------------------- platform
add('Platform', 'Keyboard-first navigation (Tally keys)', 3, 'Gateway letters, F-keys, Alt+C, Alt+D, Ctrl+A, Esc', 'done')
add('Platform', 'Short date entry', 3, '14 / 14-10 / 14-Oct', 'done')
add('Platform', 'Desktop app, offline', 3, 'tally.exe', 'done', 'Tauri + PGlite, ~27 MB installer')
add('Platform', 'Periods and year-end carry forward', 3, 'Alt+F2, books beginning', 'done', 'P&L carried into Profit & Loss A/c')
add('Platform', 'Double-entry enforced by the engine', 3, 'platform rule', 'done', 'commit-time check in the database')
add('Platform', 'XML integration (import/export)', 2, 'port 9000 XML', 'partial', 'ledgers, vouchers, TB, accounts, day book; not every Tally report')
add('Platform', ['Print / PDF', 'Export to Excel/PDF', 'Email documents'], 3, 'Alt+P / Alt+E / Alt+M')
add('Platform', ['Users, passwords and roles', 'Backup and restore'], 3, 'Company security / Backup')
add('Platform', ['Multi-user over network (server mode)'], 2, 'TallyPrime Server / Client-Server', 'partial', 'HOST=0.0.0.0 works; no login yet')
add('Platform', ['ODBC access', 'Data import from Excel', 'Split company data', 'Multi-currency', 'Multiple companies consolidated (group company)',
                 'Remote access / Tally.NET sync', 'Language / transliteration', 'Bill-wise settlement in vouchers'], 2, 'Platform')
add('Platform', ['Company features on/off (F11)', 'Configurations (F12)'], 2, 'F11 / F12')

for i, f in enumerate(F):
    f['id'] = i + 1
out = os.path.join(os.path.dirname(__file__), 'features.json')
json.dump({'source': 'TallyPrime 1.1.7.2 (installed), menu tree + masters + voucher types + platform',
           'features': F}, open(out, 'w', encoding='utf8'), indent=1, ensure_ascii=False)
print(len(F), 'features written to', out)
