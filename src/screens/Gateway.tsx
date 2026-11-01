import { useApp, VOUCHER_FEATURE, VOUCHER_KEYS } from '../App'
import { fmtDate, Menu, useLoad, type MenuItem } from '../ui'
import { t } from '../i18n'
import { api } from '../api'

/**
 * Gateway of Tally and its sub-menus. Letters follow TallyPrime's own menu definitions
 * (Create C, Alter A, Chart of Accounts H, Vouchers V, Day Book K, Display More Reports D …),
 * so a Tally user's keystrokes work unchanged.
 */
export function Gateway() {
  const { push, closeCompany, features, company, period, config } = useApp()
  const pl = features.incomeExpenditure ? 'Income & Expenditure A/c' : 'Profit & Loss A/c'
  const today = new Date().toISOString().slice(0, 10)
  return (
    <div className="gateway">
      <div className="glance">
        <div>
          <div className="label">{t('Current Period')}</div>
          <div className="value">{fmtDate(period.from)} to {fmtDate(period.to)}</div>
        </div>
        <div>
          <div className="label">{t('Current Date')}</div>
          <div className="value">{new Date(today + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long' })}, {fmtDate(today)}</div>
        </div>
        <div>
          <div className="label">{t('Name of Company')}</div>
          <div className="value">{company.name}</div>
        </div>
        <div>
          <div className="label">{t('Date of Last Entry')}</div>
          <div className="value">{config.lastVoucherDate ? fmtDate(config.lastVoucherDate) : '—'}</div>
        </div>
      </div>
      <div className="panel">
        <div className="panel-title">{t('Home')}</div>
        <Menu
          items={featureItems([
            { heading: 'Masters' },
            { label: 'Create', hotkey: 'C', onPick: () => push({ k: 'menu', menu: 'create' }) },
            { label: 'Alter', hotkey: 'A', onPick: () => push({ k: 'menu', menu: 'alter' }) },
            { label: 'Chart of Accounts', hotkey: 'H', onPick: () => push({ k: 'chart' }) },
            { heading: 'Transactions' },
            { label: 'Vouchers', hotkey: 'V', onPick: () => push({ k: 'voucher', type: 'Payment' }) },
            { label: 'Day Book', hotkey: 'K', onPick: () => push({ k: 'daybook' }) },
            { label: 'Banking', hotkey: 'N', onPick: () => push({ k: 'menu', menu: 'banking' }) },
            { heading: 'Reports' },
            { label: 'Balance Sheet', hotkey: 'B', onPick: () => push({ k: 'bs' }) },
            { label: pl, hotkey: 'P', onPick: () => push({ k: 'pl' }) },
            { label: 'Stock Summary', feature: 'inventory', hotkey: 'S', onPick: () => push({ k: 'stock-summary' }) },
            { label: 'Ratio Analysis', hotkey: 'R', onPick: () => push({ k: 'ratios' }) },
            { label: 'Dashboard', hotkey: 'G', onPick: () => push({ k: 'dashboard' }) },
            { label: 'Display More Reports', hotkey: 'D', onPick: () => push({ k: 'menu', menu: 'display' }) },
            { heading: '' },
            { label: 'Quit', hotkey: 'Q', onPick: closeCompany },
          ], features)}
        />
      </div>
    </div>
  )
}

export type MenuName =
  | 'create' | 'alter' | 'display' | 'account-books' | 'statements' | 'outstandings' | 'exceptions' | 'banking'
  | 'inventory-books' | 'inventory-statements' | 'gst' | 'tds' | 'tcs' | 'msme' | 'company' | 'voucher-types' | 'cost-centres' | 'interest' | 'payroll' | 'payroll-statutory'

const TITLES: Record<MenuName, string> = {
  create: 'Master Creation',
  alter: 'Master Alteration',
  display: 'Display More Reports',
  'account-books': 'Account Books',
  statements: 'Statements of Accounts',
  outstandings: 'Outstandings',
  exceptions: 'Exception Reports',
  banking: 'Banking',
  'inventory-books': 'Inventory Books',
  'inventory-statements': 'Statements of Inventory',
  'voucher-types': 'Change Voucher Type',
  'cost-centres': 'Cost Centres',
  interest: 'Interest Calculations',
  gst: 'GST Reports',
  tds: 'TDS Reports',
  tcs: 'TCS Reports',
  msme: 'MSME Reports',
  payroll: 'Payroll Reports',
  'payroll-statutory': 'Payroll Statutory Reports',
  company: 'Company',
}

type Item = MenuItem & { feature?: string }
/** Leave out what a switched-off feature brings, and headings with nothing left under them. */
export function featureItems(items: Item[], features: Record<string, boolean>): MenuItem[] {
  const kept = items.filter((i) => !('feature' in i) || !i.feature || features[i.feature] !== false)
  return kept.filter((i, k) => !('heading' in i) || !i.heading || (kept[k + 1] && !('heading' in kept[k + 1])))
}

export function SubMenu({ menu }: { menu: MenuName }) {
  const { push, replace, user, company, features } = useApp()
  const { data: own } = useLoad(async () => (menu === 'voucher-types' ? (await api.voucherTypes(company.id)).filter((t) => t.active) : []), [company.id, menu])
  const items: Record<MenuName, Item[]> = {
    create: [
      { heading: 'Accounting Masters' },
      { label: 'Group', hotkey: 'G', onPick: () => push({ k: 'group' }) },
      { label: 'Ledger', hotkey: 'L', onPick: () => push({ k: 'ledger' }) },
      { label: 'Closing Stock', hotkey: 'K', onPick: () => push({ k: 'stock-value' }) },
      { label: 'Cost Category', feature: 'costCentres', hotkey: 'A', onPick: () => push({ k: 'cost-category' }) },
      { label: 'Cost Centre', feature: 'costCentres', hotkey: 'C', onPick: () => push({ k: 'cost-centre' }) },
      { label: 'Voucher Type', hotkey: 'V', onPick: () => push({ k: 'voucher-type' }) },
      { label: 'Currency', feature: 'multiCurrency', hotkey: 'Y', onPick: () => push({ k: 'currency' }) },
      { label: 'Rates of Exchange', feature: 'multiCurrency', hotkey: 'R', onPick: () => push({ k: 'rates' }) },
      { label: 'Budget', hotkey: 'Q', onPick: () => push({ k: 'budget' }) },
      { label: 'Scenario', hotkey: 'Z', onPick: () => push({ k: 'scenario' }) },
      { heading: 'Inventory Masters' },
      { label: 'Stock Group', feature: 'inventory', hotkey: 'O', onPick: () => push({ k: 'tree-master', kind: 'stock-groups' }) },
      { label: 'Stock Item', feature: 'inventory', hotkey: 'I', onPick: () => push({ k: 'stock-item' }) },
      { label: 'Stock Category', feature: 'stockCategories', hotkey: 'T', onPick: () => push({ k: 'tree-master', kind: 'stock-categories' }) },
      { label: 'Unit', feature: 'inventory', hotkey: 'U', onPick: () => push({ k: 'unit' }) },
      { label: 'Bill of Materials', feature: 'inventory', hotkey: 'J', onPick: () => push({ k: 'bom' }) },
      { label: 'Godown', feature: 'godowns', hotkey: 'W', onPick: () => push({ k: 'tree-master', kind: 'godowns' }) },
      { heading: 'Statutory Masters' },
      { label: 'GST Classification', feature: 'gst', hotkey: 'S', onPick: () => push({ k: 'gst-classification' }) },
      { label: 'TDS Nature of Payment', feature: 'tds', hotkey: 'N', onPick: () => push({ k: 'tds-nature' }) },
      { label: 'TCS Nature of Goods', feature: 'tcs', hotkey: 'X', onPick: () => push({ k: 'tds-nature', kind: 'TCS' }) },
      { heading: 'Payroll Masters' },
      { label: 'Employee Category', feature: 'payroll', hotkey: 'B', onPick: () => push({ k: 'cost-category' }) },
      { label: 'Employee Group', feature: 'payroll', hotkey: 'E', onPick: () => push({ k: 'employee-group' }) },
      { label: 'Employee', feature: 'payroll', hotkey: 'M', onPick: () => push({ k: 'employee' }) },
      { label: 'Attendance/Production Type', feature: 'payroll', hotkey: 'P', onPick: () => push({ k: 'attendance-type' }) },
      { label: 'Pay Head', feature: 'payroll', hotkey: 'H', onPick: () => push({ k: 'pay-head' }) },
      { label: 'Salary Details', feature: 'payroll', hotkey: 'D', onPick: () => push({ k: 'salary-details' }) },
    ],
    alter: [
      { heading: 'Accounting Masters' },
      { label: 'Group', hotkey: 'G', onPick: () => push({ k: 'pick-master', kind: 'group' }) },
      { label: 'Ledger', hotkey: 'L', onPick: () => push({ k: 'pick-master', kind: 'ledger' }) },
      { label: 'Closing Stock', hotkey: 'K', onPick: () => push({ k: 'stock-value' }) },
      { label: 'Cost Category', feature: 'costCentres', hotkey: 'A', onPick: () => push({ k: 'pick-cost', kind: 'cost-categories' }) },
      { label: 'Cost Centre', feature: 'costCentres', hotkey: 'C', onPick: () => push({ k: 'pick-cost', kind: 'cost-centres' }) },
      { label: 'Voucher Type', hotkey: 'V', onPick: () => push({ k: 'pick-voucher-type' }) },
      { label: 'Currency', feature: 'multiCurrency', hotkey: 'Y', onPick: () => push({ k: 'pick-currency' }) },
      { label: 'Rates of Exchange', feature: 'multiCurrency', hotkey: 'R', onPick: () => push({ k: 'rates' }) },
      { label: 'Budget', hotkey: 'Q', onPick: () => push({ k: 'pick-budget' }) },
      { label: 'Scenario', hotkey: 'Z', onPick: () => push({ k: 'pick-scenario' }) },
      { heading: 'Inventory Masters' },
      { label: 'Stock Group', feature: 'inventory', hotkey: 'O', onPick: () => push({ k: 'pick-inventory', kind: 'stock-groups' }) },
      { label: 'Stock Item', feature: 'inventory', hotkey: 'I', onPick: () => push({ k: 'pick-inventory', kind: 'stock-items' }) },
      { label: 'Stock Category', feature: 'stockCategories', hotkey: 'T', onPick: () => push({ k: 'pick-inventory', kind: 'stock-categories' }) },
      { label: 'Unit', feature: 'inventory', hotkey: 'U', onPick: () => push({ k: 'pick-inventory', kind: 'units' }) },
      { label: 'Bill of Materials', feature: 'inventory', hotkey: 'J', onPick: () => push({ k: 'bom' }) },
      { label: 'Godown', feature: 'godowns', hotkey: 'W', onPick: () => push({ k: 'pick-inventory', kind: 'godowns' }) },
      { heading: 'Statutory Masters' },
      { label: 'GST Classification', feature: 'gst', hotkey: 'S', onPick: () => push({ k: 'pick-gst-classification' }) },
      { label: 'TDS Nature of Payment', feature: 'tds', hotkey: 'N', onPick: () => push({ k: 'pick-tds-nature' }) },
      { label: 'TCS Nature of Goods', feature: 'tcs', hotkey: 'X', onPick: () => push({ k: 'pick-tds-nature', kind: 'TCS' }) },
      { heading: 'Payroll Masters' },
      { label: 'Employee Category', feature: 'payroll', hotkey: 'B', onPick: () => push({ k: 'pick-cost', kind: 'cost-categories' }) },
      { label: 'Employee Group', feature: 'payroll', hotkey: 'E', onPick: () => push({ k: 'pick-payroll', kind: 'employee-group' }) },
      { label: 'Employee', feature: 'payroll', hotkey: 'M', onPick: () => push({ k: 'pick-payroll', kind: 'employee' }) },
      { label: 'Attendance/Production Type', feature: 'payroll', hotkey: 'P', onPick: () => push({ k: 'pick-payroll', kind: 'attendance-type' }) },
      { label: 'Pay Head', feature: 'payroll', hotkey: 'H', onPick: () => push({ k: 'pick-payroll', kind: 'pay-head' }) },
      { label: 'Salary Details', feature: 'payroll', hotkey: 'D', onPick: () => push({ k: 'salary-details' }) },
    ],
    display: [
      { heading: 'Accounting' },
      { label: 'Trial Balance', hotkey: 'T', onPick: () => push({ k: 'tb' }) },
      { label: 'Day Book', hotkey: 'D', onPick: () => push({ k: 'daybook' }) },
      { label: 'Cash Flow', hotkey: 'C', onPick: () => push({ k: 'cash-flow' }) },
      { label: 'Funds Flow', hotkey: 'F', onPick: () => push({ k: 'funds-flow' }) },
      { label: 'Account Books', hotkey: 'A', onPick: () => push({ k: 'menu', menu: 'account-books' }) },
      { label: 'Statements of Accounts', hotkey: 'S', onPick: () => push({ k: 'menu', menu: 'statements' }) },
      { heading: 'Inventory' },
      { label: 'Inventory Books', feature: 'inventory', hotkey: 'I', onPick: () => push({ k: 'menu', menu: 'inventory-books' }) },
      { label: 'Statements of Inventory', feature: 'inventory', hotkey: 'N', onPick: () => push({ k: 'menu', menu: 'inventory-statements' }) },
      { heading: 'Statutory' },
      { label: 'GST Reports', feature: 'gst', hotkey: 'O', onPick: () => push({ k: 'menu', menu: 'gst' }) },
      { label: 'TDS Reports', feature: 'tds', hotkey: 'T', onPick: () => push({ k: 'menu', menu: 'tds' }) },
      { label: 'TCS Reports', feature: 'tcs', hotkey: 'E', onPick: () => push({ k: 'menu', menu: 'tcs' }) },
      { label: 'MSME Reports', hotkey: 'M', onPick: () => push({ k: 'menu', menu: 'msme' }) },
      { label: 'Payroll Reports', feature: 'payroll', hotkey: 'P', onPick: () => push({ k: 'menu', menu: 'payroll' }) },
      { label: 'Job Work Reports', feature: 'jobWork', hotkey: 'J', onPick: () => push({ k: 'job-work' }) },
      { heading: '' },
      { label: 'Budget Variance', hotkey: 'B', onPick: () => push({ k: 'pick-budget', next: 'variance' }) },
      { label: 'Voucher Audit', hotkey: 'U', onPick: () => push({ k: 'tally-audit' }) },
      { label: 'Cost Tracking', feature: 'costTracking', hotkey: 'K', onPick: () => push({ k: 'cost-tracks' }) },
      { label: 'Exception Reports', hotkey: 'X', onPick: () => push({ k: 'menu', menu: 'exceptions' }) },
      { label: 'Edit Log', hotkey: 'L', onPick: () => push({ k: 'edit-log' }) },
    ],
    // letters as in TallyPrime's Inventory Books menu
    'inventory-books': [
      { label: 'Stock Item', feature: 'inventory', hotkey: 'I', onPick: () => push({ k: 'pick-inventory', kind: 'stock-items', next: 'vouchers' }) },
      { label: 'Stock Group Summary', feature: 'inventory', hotkey: 'S', onPick: () => push({ k: 'stock-summary' }) },
      { label: 'Stock Category Summary', feature: 'stockCategories', hotkey: 'C', onPick: () => push({ k: 'stock-category-summary' }) },
      { label: 'Godown Summary', feature: 'godowns', hotkey: 'G', onPick: () => push({ k: 'godown-summary' }) },
      { heading: 'Registers' },
      { label: 'Sales Order Book', feature: 'orders', hotkey: 'O', onPick: () => push({ k: 'register', type: 'Sales Order' }) },
      { label: 'Purchase Order Book', feature: 'orders', hotkey: 'U', onPick: () => push({ k: 'register', type: 'Purchase Order' }) },
      { label: 'Delivery Note Register', feature: 'orders', hotkey: 'D', onPick: () => push({ k: 'register', type: 'Delivery Note' }) },
      { label: 'Receipt Note Register', feature: 'orders', hotkey: 'R', onPick: () => push({ k: 'register', type: 'Receipt Note' }) },
      { label: 'Stock Journal Register', feature: 'inventory', hotkey: 'J', onPick: () => push({ k: 'register', type: 'Stock Journal' }) },
      { label: 'Manufacturing Journal Register', feature: 'inventory', hotkey: 'M', onPick: () => push({ k: 'register', type: 'Manufacturing Journal' }) },
      { label: 'Rejections In Register', feature: 'inventory', hotkey: 'E', onPick: () => push({ k: 'register', type: 'Rejections In' }) },
      { label: 'Rejections Out Register', feature: 'inventory', hotkey: 'T', onPick: () => push({ k: 'register', type: 'Rejections Out' }) },
      { label: 'Material In Register', feature: 'jobWork', hotkey: 'W', onPick: () => push({ k: 'register', type: 'Material In' }) },
      { label: 'Material Out Register', feature: 'jobWork', hotkey: 'X', onPick: () => push({ k: 'register', type: 'Material Out' }) },
      { label: 'Physical Stock Register', feature: 'inventory', hotkey: 'P', onPick: () => push({ k: 'register', type: 'Physical Stock' }) },
    ],
    'inventory-statements': [
      { label: 'Stock Query', feature: 'inventory', hotkey: 'Q', onPick: () => push({ k: 'pick-inventory', kind: 'stock-items', next: 'query' }) },
      { label: 'Godowns', feature: 'godowns', hotkey: 'G', onPick: () => push({ k: 'godown-summary' }) },
      { label: 'Movement Analysis', feature: 'inventory', hotkey: 'M', onPick: () => push({ k: 'movement' }) },
      { label: 'Ageing Analysis', feature: 'inventory', hotkey: 'A', onPick: () => push({ k: 'stock-ageing' }) },
      { label: 'Reorder Status', feature: 'inventory', hotkey: 'R', onPick: () => push({ k: 'reorder' }) },
      { label: 'Cost Estimation', feature: 'inventory', hotkey: 'E', onPick: () => push({ k: 'cost-estimation' }) },
      { label: 'Batches (expiry)', feature: 'inventory', hotkey: 'T', onPick: () => push({ k: 'batches' }) },
      { heading: 'Order Outstandings' },
      { label: 'Sales Orders', feature: 'orders', hotkey: 'S', onPick: () => push({ k: 'pending', type: 'Sales Order' }) },
      { label: 'Purchase Orders', feature: 'orders', hotkey: 'P', onPick: () => push({ k: 'pending', type: 'Purchase Order' }) },
      { label: 'Sales Order Analysis (by month)', feature: 'orders', hotkey: 'O', onPick: () => push({ k: 'order-analysis', type: 'Sales Order' }) },
      { label: 'Purchase Order Analysis (by month)', feature: 'orders', hotkey: 'H', onPick: () => push({ k: 'order-analysis', type: 'Purchase Order' }) },
      { heading: 'Bills Pending' },
      { label: 'Sales Bills Pending', feature: 'orders', hotkey: 'B', onPick: () => push({ k: 'pending', type: 'Delivery Note' }) },
      { label: 'Purchase Bills Pending', feature: 'orders', hotkey: 'U', onPick: () => push({ k: 'pending', type: 'Receipt Note' }) },
    ],
    // F10: every voucher type, with the key that opens it
    'voucher-types': [
      ...VOUCHER_KEYS.map((v) => ({
        label: `${t(v.type)}${v.key ? `  (${v.label.split(' ')[0]})` : ''}`,
        hotkey: v.letter,
        feature: VOUCHER_FEATURE[v.type],
        onPick: () => replace({ k: 'voucher', type: v.type }),
      })),
      ...(own?.length ? [{ heading: 'Your voucher types' }] : []),
      ...(own ?? []).map((t, i) => ({
        label: `${t.name}  (${t.baseType})`,
        hotkey: String((i + 1) % 10),
        feature: VOUCHER_FEATURE[t.baseType],
        onPick: () => replace({ k: 'voucher', type: t.baseType, voucherTypeId: t.id }),
      })),
    ],
    // Alt+K, as TallyPrime's Company menu
    company: [
      { heading: 'Security' },
      { label: 'Users and Passwords', hotkey: 'U', onPick: () => push({ k: 'users' }) },
      ...(user ? [{ label: 'Change Password', hotkey: 'P', onPick: () => push({ k: 'change-password' }) }] : []),
      { heading: 'Statutory' },
      { label: 'GST Registration', feature: 'gst', hotkey: 'G', onPick: () => push({ k: 'gst-registration' }) },
      { label: 'TDS Details', feature: 'tds', hotkey: 'T', onPick: () => push({ k: 'tds-details' }) },
      { label: 'GSP: e-Invoice and e-Way Bill API', feature: 'edocs', hotkey: 'I', onPick: () => push({ k: 'gsp-settings' }) },
      { heading: 'Details' },
      { label: 'Features (F11)', hotkey: 'F', onPick: () => push({ k: 'features' }) },
      { label: 'Company Details', hotkey: 'D', onPick: () => push({ k: 'company-details' }) },
      { label: 'E-mail Settings', feature: 'email', hotkey: 'E', onPick: () => push({ k: 'mail-settings' }) },
      { label: 'E-mail Log', feature: 'email', hotkey: 'L', onPick: () => push({ k: 'mail-log' }) },
    ],
    payroll: [
      { heading: 'Statements of Payroll' },
      { label: 'Pay Sheet', hotkey: 'S', onPick: () => push({ k: 'pay-sheet' }) },
      { label: 'Payslip', hotkey: 'P', onPick: () => push({ k: 'payslip' }) },
      { label: 'Attendance Sheet', hotkey: 'A', onPick: () => push({ k: 'attendance-sheet' }) },
      { label: 'Payroll Register', hotkey: 'R', onPick: () => push({ k: 'payroll-register' }) },
      { label: 'Loans and Advances', hotkey: 'L', onPick: () => push({ k: 'loans' }) },
      { label: 'Salary Arrears', hotkey: 'W', onPick: () => push({ k: 'arrears' }) },
      { label: 'Income Tax Declarations', hotkey: 'D', onPick: () => push({ k: 'tax-declarations' }) },
      { heading: '' },
      { label: 'Payroll Statutory Reports', hotkey: 'T', onPick: () => push({ k: 'menu', menu: 'payroll-statutory' }) },
    ],
    'payroll-statutory': [
      { label: 'Provident Fund (ECR)', hotkey: 'P', onPick: () => push({ k: 'pf' }) },
      { label: "Employees' State Insurance", hotkey: 'E', onPick: () => push({ k: 'esi' }) },
      { label: 'Professional Tax', hotkey: 'T', onPick: () => push({ k: 'professional-tax' }) },
      { label: 'Income Tax on Salary (Form 16, 24Q)', hotkey: 'I', onPick: () => push({ k: 'salary-tax' }) },
      { label: 'Gratuity', hotkey: 'G', onPick: () => push({ k: 'gratuity' }) },
      { label: 'National Pension System', hotkey: 'N', onPick: () => push({ k: 'nps' }) },
      { heading: '' },
      { label: 'Statutory Payment', hotkey: 'Y', onPick: () => push({ k: 'statutory-payment' }) },
    ],
    tds: [
      { label: 'TDS Computation', hotkey: 'C', onPick: () => push({ k: 'tds-computation' }) },
      { label: 'TDS Outstandings', hotkey: 'O', onPick: () => push({ k: 'tds-outstandings' }) },
      { label: 'Form 140 / 26Q', hotkey: 'Q', onPick: () => push({ k: 'form-26q' }) },
      { label: 'Form 144 / 27Q (non-residents)', hotkey: '7', onPick: () => push({ k: 'form-26q', form: '27Q' }) },
      { label: 'Challan Reconciliation', hotkey: 'R', onPick: () => push({ k: 'challan-reconciliation' }) },
      { heading: '' },
      { label: 'TDS Details', hotkey: 'D', onPick: () => push({ k: 'tds-details' }) },
      { label: 'Lower Deduction and Treaty Rates', hotkey: 'L', onPick: () => push({ k: 'tds-party-rates' }) },
    ],
    tcs: [
      { label: 'TCS Computation', hotkey: 'C', onPick: () => push({ k: 'tds-computation', kind: 'TCS' }) },
      { label: 'TCS Outstandings', hotkey: 'O', onPick: () => push({ k: 'tds-outstandings', kind: 'TCS' }) },
      { label: 'Form 143 / 27EQ', hotkey: 'Q', onPick: () => push({ k: 'form-26q', form: '27EQ' }) },
      { label: 'Challan Reconciliation', hotkey: 'R', onPick: () => push({ k: 'challan-reconciliation' }) },
      { heading: '' },
      { label: 'TDS/TCS Details', hotkey: 'D', onPick: () => push({ k: 'tds-details' }) },
    ],
    msme: [
      { label: 'MSME Form 1', hotkey: 'F', onPick: () => push({ k: 'msme-form1' }) },
      { label: 'Interest on Late Payments', hotkey: 'I', onPick: () => push({ k: 'msme-interest' }) },
      { label: 'Party MSME Update', hotkey: 'U', onPick: () => push({ k: 'msme-update' }) },
    ],
    gst: [
      { label: 'GSTR-1', hotkey: '1', onPick: () => push({ k: 'gstr1' }) },
      { label: 'GSTR-3B', hotkey: '3', onPick: () => push({ k: 'gstr3b' }) },
      { label: 'GSTR-9 Annual Return', hotkey: '9', onPick: () => push({ k: 'gstr9' }) },
      { label: 'GSTR-2B Reconciliation and IMS', hotkey: '2', onPick: () => push({ k: 'gst-reco', source: '2B' }) },
      { label: 'GSTR-1 Reconciliation', hotkey: 'L', onPick: () => push({ k: 'gst-reco', source: 'GSTR-1' }) },
      { label: 'Advances (11A/11B)', hotkey: 'A', onPick: () => push({ k: 'gst-advances' }) },
      { label: 'Challan Reconciliation', hotkey: 'C', onPick: () => push({ k: 'gst-challans' }) },
      { label: 'CMP-08 (composition)', hotkey: '8', onPick: () => push({ k: 'composition' }) },
      { label: 'GSTR-4 (composition, annual)', hotkey: '4', onPick: () => push({ k: 'composition', annual: true }) },
      { label: 'e-Invoice and e-Way Bill', feature: 'edocs', hotkey: 'E', onPick: () => push({ k: 'e-documents' }) },
      { heading: '' },
      { label: 'GST Registration', feature: 'gst', hotkey: 'R', onPick: () => push({ k: 'gst-registration' }) },
      { label: 'Party GSTIN Update', hotkey: 'U', onPick: () => push({ k: 'gst-parties' }) },
      { label: 'Kerala Flood Cess (2019-21)', hotkey: 'K', onPick: () => push({ k: 'kerala-flood-cess' }) },
    ],
    // letters as in TallyPrime's Banking menu
    banking: [
      { label: 'Cheque Printing', feature: 'cheques', hotkey: 'P', onPick: () => push({ k: 'cheque-register', print: true }) },
      { label: 'Cheque Register', feature: 'cheques', hotkey: 'C', onPick: () => push({ k: 'cheque-register' }) },
      { label: 'Post-Dated Summary', feature: 'cheques', hotkey: 'D', onPick: () => push({ k: 'post-dated' }) },
      { label: 'Deposit Slip', hotkey: 'S', onPick: () => push({ k: 'pick-bank', next: 'slip' }) },
      { label: 'Payment Advice', hotkey: 'A', onPick: () => push({ k: 'pick-payment-advice' }) },
      { heading: 'Reconcile' },
      { label: 'Bank Reconciliation', hotkey: 'B', onPick: () => push({ k: 'pick-bank' }) },
      { label: 'Payment Gateway Reconciliation', hotkey: 'G', onPick: () => push({ k: 'gateway-reco' }) },
    ],
    statements: [
      { label: 'Outstandings', feature: 'billwise', hotkey: 'O', onPick: () => push({ k: 'menu', menu: 'outstandings' }) },
      { label: 'Cost Centres', feature: 'costCentres', hotkey: 'C', onPick: () => push({ k: 'menu', menu: 'cost-centres' }) },
      { label: 'Interest Calculations', feature: 'interest', hotkey: 'I', onPick: () => push({ k: 'menu', menu: 'interest' }) },
      { label: 'Statistics', hotkey: 'T', onPick: () => push({ k: 'statistics' }) },
    ],
    // as TallyPrime's Statements of Accounts > Interest Calculations
    interest: [
      { label: 'Interest Receivable', hotkey: 'R', onPick: () => push({ k: 'interest', side: 'receivable' }) },
      { label: 'Interest Payable', hotkey: 'P', onPick: () => push({ k: 'interest', side: 'payable' }) },
      { label: 'Ledger', hotkey: 'L', onPick: () => push({ k: 'pick-interest', of: 'ledger' }) },
      { label: 'Group', hotkey: 'G', onPick: () => push({ k: 'pick-interest', of: 'group' }) },
    ],
    // as TallyPrime's Statements of Accounts > Cost Centres
    'cost-centres': [
      { label: 'Category Summary', hotkey: 'S', onPick: () => push({ k: 'cost-summary' }) },
      { label: 'Cost Centre Break-up', hotkey: 'B', onPick: () => push({ k: 'pick-cost', kind: 'cost-centres', next: 'breakup' }) },
      { label: 'Ledger Break-up', hotkey: 'L', onPick: () => push({ k: 'pick-cost-breakup', of: 'ledger' }) },
      { label: 'Group Break-up', hotkey: 'G', onPick: () => push({ k: 'pick-cost-breakup', of: 'group' }) },
    ],
    outstandings: [
      { label: 'Receivables', hotkey: 'R', onPick: () => push({ k: 'bills', side: 'receivable' }) },
      { label: 'Payables', hotkey: 'P', onPick: () => push({ k: 'bills', side: 'payable' }) },
      { label: 'Ledger', hotkey: 'L', onPick: () => push({ k: 'pick-outstanding', kind: 'ledger' }) },
      { label: 'Group', hotkey: 'G', onPick: () => push({ k: 'pick-outstanding', kind: 'group' }) },
    ],
    exceptions: [
      { label: 'Overdue Receivables', feature: 'billwise', hotkey: 'R', onPick: () => push({ k: 'bills', side: 'receivable', overdue: true }) },
      { label: 'Overdue Payables', feature: 'billwise', hotkey: 'P', onPick: () => push({ k: 'bills', side: 'payable', overdue: true }) },
      { heading: '' },
      { label: 'Negative Ledgers', hotkey: 'N', onPick: () => push({ k: 'negative-ledgers' }) },
      { label: 'Negative Stock', feature: 'inventory', hotkey: 'S', onPick: () => push({ k: 'negative-stock' }) },
      { label: 'Cancelled Vouchers', hotkey: 'C', onPick: () => push({ k: 'cancelled' }) },
      { label: 'Post-Dated Vouchers', feature: 'cheques', hotkey: 'D', onPick: () => push({ k: 'post-dated' }) },
      { label: 'Optional Vouchers', feature: 'optional', hotkey: 'O', onPick: () => push({ k: 'drafts', kind: 'optional' }) },
      { label: 'Memorandum Register', feature: 'optional', hotkey: 'M', onPick: () => push({ k: 'drafts', kind: 'memorandum' }) },
      { label: 'Reversing Journal Register', hotkey: 'V', onPick: () => push({ k: 'reversing-journals' }) },
      { label: 'Tracked Vouchers (notes not invoiced)', feature: 'orders', hotkey: 'T', onPick: () => push({ k: 'tracked-vouchers' }) },
      { label: 'Forex Gain/Loss', feature: 'multiCurrency', hotkey: 'F', onPick: () => push({ k: 'forex-gain-loss' }) },
    ],
    // letters as in TallyPrime's Account Books menu
    'account-books': [
      { label: 'Cash/Bank Books', hotkey: 'C', onPick: () => push({ k: 'group-summary', cashBank: true }) },
      { label: 'Ledger', hotkey: 'L', onPick: () => push({ k: 'ledger-pick' }) },
      { label: 'Group Summary', hotkey: 'G', onPick: () => push({ k: 'pick-group', next: 'summary' }) },
      { label: 'Group Vouchers', hotkey: 'V', onPick: () => push({ k: 'pick-group', next: 'vouchers' }) },
      { heading: 'Registers' },
      { label: 'Contra Register', hotkey: 'T', onPick: () => push({ k: 'register', type: 'Contra' }) },
      { label: 'Payment Register', hotkey: 'Y', onPick: () => push({ k: 'register', type: 'Payment' }) },
      { label: 'Receipts Register', hotkey: 'R', onPick: () => push({ k: 'register', type: 'Receipt' }) },
      { label: 'Sales Register', hotkey: 'S', onPick: () => push({ k: 'register', type: 'Sales' }) },
      { label: 'Purchase Register', hotkey: 'P', onPick: () => push({ k: 'register', type: 'Purchase' }) },
      { label: 'Journal Register', hotkey: 'J', onPick: () => push({ k: 'register', type: 'Journal' }) },
      { label: 'Debit Note Register', hotkey: 'D', onPick: () => push({ k: 'register', type: 'Debit Note' }) },
      { label: 'Credit Note Register', hotkey: 'E', onPick: () => push({ k: 'register', type: 'Credit Note' }) },
      { label: 'POS Register', hotkey: 'O', onPick: () => push({ k: 'pos-register' }) },
    ],
  }
  return (
    <div className="gateway">
      <div className="panel">
        <div className="panel-title">{t(TITLES[menu])}</div>
        <Menu items={featureItems(items[menu], features)} />
      </div>
    </div>
  )
}
