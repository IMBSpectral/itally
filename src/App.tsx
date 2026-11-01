import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api, CONFIG_DEFAULTS, setSession, SIGN_IN_EVENT, storedSession, type AppConfig, type Company, type InventoryMaster, type PendingType, type Period, type User } from './api'
import type { VoucherType } from '../server/src/engine/voucher'
import { CompanySelect } from './screens/CompanySelect'
import { Gateway, SubMenu, type MenuName } from './screens/Gateway'
import { VoucherScreen } from './screens/Invoice'
import { GstRegistration, Gstr1View, Gstr3bView } from './screens/Gst'
import { ChangePassword, SignIn, UserForm, UsersView } from './screens/Security'
import { InventoryPick, StockItemForm, StockItemVouchersView, StockSummaryView, TreeForm, UnitForm } from './screens/Inventory'
import { GodownSummaryView, PendingView } from './screens/Orders'
import {
  CancelledView, DraftsView, ChequePrint, ChequeRegisterView, DepositSlipView, NegativeLedgersView, NegativeStockView, PaymentAdvice, PaymentAdvicePick, PostDatedView,
} from './screens/Cheques'
import { InterestPick, InterestView, LedgerInterestView } from './screens/Interest'
import { CentreBreakupView, CostBreakupPick, CostBreakupView, CostCategoryForm, CostCentreForm, CostPick, CostSummaryView } from './screens/CostCentres'
import { GroupForm, LedgerForm, MasterPick, StockValue } from './screens/Masters'
import { ChartOfAccounts, LedgerPick, LedgerStatement } from './screens/Accounts'
import { DayBook } from './screens/DayBook'
import { BalanceSheetView, ProfitLossView, TrialBalanceView } from './screens/Reports'
import { PeriodScreen } from './screens/PeriodScreen'
import { BillsView, GroupOutstandingView, LedgerOutstandingView, OutstandingPick } from './screens/Outstandings'
import { EDocRegisterView, EDocumentView, GspSettingsForm } from './screens/EDocs'
import { GstClassificationForm, GstClassificationPick } from './screens/Classifications'
import { CurrencyForm, CurrencyPick, ForexGainLossView, RatesForm } from './screens/Forex'
import {
  AttendanceSheetView, AttendanceTypeForm, EmployeeForm, EmployeeGroupForm, EsiView, GratuityView, NpsView, PayHeadForm, PayrollPick, PayrollRegisterView,
  PaySheetView, PayslipView, PfView, ProfessionalTaxView, SalaryDetailsForm, SalaryTaxView, LoansView, TaxDeclarationsForm, ArrearsView, StatutoryPaymentView,
} from './screens/Payroll'
import { BomForm, CostEstimationView, JobWorkView } from './screens/Manufacturing'
import { ChallanReconciliationView, Form26QView, TdsChallanForm, TdsComputationView, TdsDetailsForm, TdsNatureForm, TdsNaturePick, TdsOutstandingsView, TdsPartyRatesView } from './screens/Tds'
import { MsmeForm1View, MsmeInterestView, MsmeUpdateView } from './screens/Msme'
import { ConfigForm, ImportScreen, SplitScreen } from './screens/CompanyTools'
import { lang, setLang, t, type Lang } from './i18n'
import { translatePage } from './i18nDom'
import { OrderAnalysisView, PosRegisterView, TallyAuditView, TrackedVouchersView } from './screens/Registers'
import { BatchesView, CostTracksView } from './screens/Batches'
import { GatewayRecoView, KeralaFloodCessView } from './screens/GatewayReco'
import { CompositionView, GstAdvancesView, GstChallansView, GstPartiesView, GstRecoView, Gstr9View } from './screens/GstMore'
import { BudgetForm, BudgetPick, BudgetVarianceView, ReversingJournalsView, ScenarioForm, ScenarioPick } from './screens/Budgets'
import { FeaturesForm, StockCategorySummaryView, StockQueryView, VoucherTypeForm, VoucherTypePick, VoucherTypeProvider } from './screens/VoucherTypes'
import { captureScreen, CompanyDetailsForm, EmailScreen, MailLogView, MailSettingsForm } from './screens/Company'
import { CashFlowView, DashboardView, FundsFlowView, ItemMovementView, MovementView, RatiosView, ReorderView, StatisticsView, StockAgeingView } from './screens/Analysis'
import { GroupPick, GroupSummaryView, GroupVouchersView, LedgerMonthlyView, RegisterView } from './screens/Books'
import { BankPick, BankRecoView } from './screens/Banking'
import { EditHistoryView, EditLogView } from './screens/EditLog'
import { DataScreen } from './screens/Data'
import { exportScreen, VoucherPrint } from './screens/Print'
import { ActiveCtx, fmtDate } from './ui'
import { AgentsView, AiAssistPanel, AiSettingsForm, MoneyMapView, ReviewView } from './screens/Intelligence'

export type Screen =
  | { k: 'gateway' }
  | { k: 'menu'; menu: MenuName }
  | { k: 'voucher'; type: VoucherType; id?: number; invoice?: boolean; voucherTypeId?: number }
  | { k: 'ledger'; id?: number; name?: string; onCreated?: (id: number) => void }
  | { k: 'group'; id?: number }
  | { k: 'pick-master'; kind: 'ledger' | 'group' }
  | { k: 'stock-value' }
  | { k: 'chart' }
  | { k: 'daybook'; type?: VoucherType; range?: Period }
  | { k: 'tb' }
  | { k: 'pl' }
  | { k: 'bs' }
  | { k: 'cash-flow'; month?: string }
  | { k: 'funds-flow' }
  | { k: 'ratios' }
  | { k: 'statistics' }
  | { k: 'tds-details' }
  | { k: 'employee'; id?: number }
  | { k: 'employee-group'; id?: number }
  | { k: 'attendance-type'; id?: number }
  | { k: 'pay-head'; id?: number }
  | { k: 'salary-details'; centreId?: number }
  | { k: 'pick-payroll'; kind: 'employee' | 'employee-group' | 'attendance-type' | 'pay-head' }
  | { k: 'pay-sheet' }
  | { k: 'bom'; itemId?: number }
  | { k: 'cost-estimation' }
  | { k: 'job-work' }
  | { k: 'payslip'; employeeId?: number }
  | { k: 'attendance-sheet' }
  | { k: 'payroll-register' }
  | { k: 'pf' }
  | { k: 'esi' }
  | { k: 'professional-tax' }
  | { k: 'nps' }
  | { k: 'salary-tax' }
  | { k: 'gratuity' }
  | { k: 'loans' }
  | { k: 'tax-declarations' }
  | { k: 'arrears' }
  | { k: 'statutory-payment' }
  | { k: 'currency'; id?: number }
  | { k: 'pick-currency' }
  | { k: 'rates' }
  | { k: 'forex-gain-loss' }
  | { k: 'tds-nature'; id?: number; kind?: 'TDS' | 'TCS' }
  | { k: 'pick-tds-nature'; kind?: 'TDS' | 'TCS' }
  | { k: 'tds-computation'; kind?: 'TDS' | 'TCS' }
  | { k: 'tds-outstandings'; kind?: 'TDS' | 'TCS' }
  | { k: 'challan-reconciliation' }
  | { k: 'msme-update' }
  | { k: 'msme-form1' }
  | { k: 'msme-interest' }
  | { k: 'tds-party-rates' }
  | { k: 'budget'; id?: number }
  | { k: 'pick-budget'; next?: 'variance' }
  | { k: 'budget-variance'; id: number }
  | { k: 'scenario'; id?: number }
  | { k: 'pick-scenario' }
  | { k: 'reversing-journals' }
  | { k: 'config' }
  | { k: 'tally-audit' }
  | { k: 'batches' }
  | { k: 'gateway-reco' }
  | { k: 'kerala-flood-cess' }
  | { k: 'cost-tracks' }
  | { k: 'pos-register' }
  | { k: 'order-analysis'; type: 'Sales Order' | 'Purchase Order' }
  | { k: 'tracked-vouchers' }
  | { k: 'import' }
  | { k: 'split' }
  | { k: 'gst-reco'; source: '2B' | 'GSTR-1' }
  | { k: 'gst-advances' }
  | { k: 'gstr9' }
  | { k: 'composition'; annual?: boolean }
  | { k: 'gst-challans' }
  | { k: 'gst-parties' }
  | { k: 'tds-challan'; voucherId: number }
  | { k: 'form-26q'; form?: '26Q' | '27Q' | '27EQ' }
  | { k: 'dashboard' }
  | { k: 'stock-ageing' }
  | { k: 'e-documents' }
  | { k: 'gsp-settings' }
  | { k: 'money-map' }
  | { k: 'review' }
  | { k: 'agents' }
  | { k: 'ai-settings' }
  | { k: 'voucher-type'; id?: number }
  | { k: 'pick-voucher-type' }
  | { k: 'gst-classification'; id?: number }
  | { k: 'pick-gst-classification' }
  | { k: 'features' }
  | { k: 'stock-category-summary'; categoryId?: number }
  | { k: 'stock-query'; itemId: number }
  | { k: 'e-document'; voucherId: number }
  | { k: 'company-details' }
  | { k: 'mail-settings' }
  | { k: 'mail-log' }
  | { k: 'email'; html: string; subject: string; to: string; voucherId: number | null; pdf?: string }
  | { k: 'movement'; itemId?: number }
  | { k: 'reorder' }
  | { k: 'ledger-pick' }
  | { k: 'statement'; ledgerId: number; range?: Period }
  | { k: 'period' }
  | { k: 'bills'; side: 'receivable' | 'payable'; overdue?: boolean }
  | { k: 'ledger-outstanding'; ledgerId: number }
  | { k: 'group-outstanding'; groupId?: number }
  | { k: 'pick-outstanding'; kind: 'ledger' | 'group' }
  | { k: 'group-summary'; groupId?: number; cashBank?: boolean }
  | { k: 'group-vouchers'; groupId: number }
  | { k: 'register'; type: VoucherType }
  | { k: 'ledger-monthly'; ledgerId: number }
  | { k: 'pick-group'; next: 'summary' | 'vouchers' }
  | { k: 'pick-bank'; next?: 'reco' | 'cheques' | 'slip' }
  | { k: 'cheque-register'; bankId?: number; print?: boolean }
  | { k: 'cheque-print'; voucherId: number; chequeNo?: string | null }
  | { k: 'deposit-slip'; bankId: number }
  | { k: 'payment-advice'; voucherId: number }
  | { k: 'pick-payment-advice' }
  | { k: 'post-dated' }
  | { k: 'cancelled' }
  | { k: 'drafts'; kind: 'optional' | 'memorandum' }
  | { k: 'negative-ledgers' }
  | { k: 'negative-stock' }
  | { k: 'bank-reco'; ledgerId: number }
  | { k: 'edit-log' }
  | { k: 'data' }
  | { k: 'voucher-print'; id: number }
  | { k: 'edit-history'; entity: string; id: number; label: string }
  | { k: 'unit'; id?: number; symbol?: string; onCreated?: (id: number) => void }
  | { k: 'tree-master'; kind: 'stock-groups' | 'godowns' | 'stock-categories'; id?: number }
  | { k: 'stock-item'; id?: number; name?: string; onCreated?: (id: number) => void }
  | { k: 'pick-inventory'; kind: InventoryMaster; next?: 'alter' | 'vouchers' | 'query' }
  | { k: 'stock-summary'; groupId?: number }
  | { k: 'stock-item-vouchers'; itemId: number }
  | { k: 'godown-summary' }
  | { k: 'cost-category'; id?: number }
  | { k: 'cost-centre'; id?: number }
  | { k: 'pick-cost'; kind: 'cost-categories' | 'cost-centres'; next?: 'alter' | 'breakup' }
  | { k: 'pick-cost-breakup'; of: 'ledger' | 'group' }
  | { k: 'cost-summary' }
  | { k: 'interest'; side?: 'receivable' | 'payable'; groupId?: number }
  | { k: 'ledger-interest'; ledgerId: number }
  | { k: 'pick-interest'; of: 'ledger' | 'group' }
  | { k: 'centre-breakup'; centreId: number }
  | { k: 'cost-breakup'; ledgerId?: number; groupId?: number }
  | { k: 'pending'; type: PendingType }
  | { k: 'gst-registration' }
  | { k: 'gstr1' }
  | { k: 'gstr3b' }
  | { k: 'users' }
  | { k: 'user'; id?: number }
  | { k: 'change-password' }

interface Ctx {
  company: Company
  period: Period
  setPeriod: (p: Period) => void
  push: (s: Screen) => void
  pop: () => void
  /** replace the top screen (e.g. a picker opening the item it picked) */
  replace: (s: Screen) => void
  closeCompany: () => void
  /** switch to another company (e.g. one just restored) */
  openCompany: (c: Company) => void
  /** bumps after any posting so open reports refetch */
  version: number
  changed: () => void
  /** who is signed in (null when the company has no users) */
  user: User | null
  /** a sign-in made from inside the company (the first Owner just created) */
  signedIn: (u: User, token: string) => void
  /** F11 features; a feature switched off hides its menus (absent = on) */
  features: Record<string, boolean>
  /** F12 configuration */
  config: AppConfig
  /** the screens' language, chosen per computer (F12) */
  language: Lang
  setLanguage: (l: Lang) => void
}

/** A new voucher's date: today (or the period's start, if today is outside it), or with F12 so set, the last voucher's date. */
export function newVoucherDate(period: Period, config: AppConfig) {
  const last = config.voucherDate === 'last' ? config.lastVoucherDate : null
  if (last && last >= period.from && last <= period.to) return last
  const now = new Date().toLocaleDateString('en-CA')
  return now >= period.from && now <= period.to ? now : period.from
}

const AppCtx = createContext<Ctx | null>(null)
export const useApp = () => useContext(AppCtx)!

/**
 * Voucher hotkeys, as in TallyPrime: F4 Contra … F9 Purchase, Ctrl+F8/F9 the notes, Alt+F5 Sales
 * Order, Alt/Ctrl+F7 Stock Journal / Physical Stock, Alt+F8/F9 Delivery / Receipt Note. Tally's
 * Alt+F4 for Purchase Order would close the window here, so it is on F10 (every type, by letter).
 */
export const VOUCHER_KEYS: { key?: string; ctrl?: boolean; alt?: boolean; type: VoucherType; label: string; letter: string }[] = [
  { key: 'F4', type: 'Contra', label: 'F4 Contra', letter: 'C' },
  { key: 'F5', type: 'Payment', label: 'F5 Payment', letter: 'P' },
  { key: 'F6', type: 'Receipt', label: 'F6 Receipt', letter: 'R' },
  { key: 'F7', type: 'Journal', label: 'F7 Journal', letter: 'J' },
  { key: 'F8', type: 'Sales', label: 'F8 Sales', letter: 'S' },
  { key: 'F9', type: 'Purchase', label: 'F9 Purchase', letter: 'U' },
  { key: 'F8', ctrl: true, type: 'Credit Note', label: 'Ctrl+F8 Credit Note', letter: 'E' },
  { key: 'F9', ctrl: true, type: 'Debit Note', label: 'Ctrl+F9 Debit Note', letter: 'D' },
  { key: 'F5', alt: true, type: 'Sales Order', label: 'Alt+F5 Sales Order', letter: 'O' },
  { type: 'Purchase Order', label: 'Purchase Order', letter: 'H' },
  { key: 'F8', alt: true, type: 'Delivery Note', label: 'Alt+F8 Delivery Note', letter: 'L' },
  { key: 'F9', alt: true, type: 'Receipt Note', label: 'Alt+F9 Receipt Note', letter: 'N' },
  { key: 'F7', alt: true, type: 'Stock Journal', label: 'Alt+F7 Stock Journal', letter: 'K' },
  { key: 'F7', ctrl: true, type: 'Physical Stock', label: 'Ctrl+F7 Physical Stock', letter: 'Y' },
  { key: 'F10', ctrl: true, type: 'Memorandum', label: 'Ctrl+F10 Memorandum', letter: 'M' },
  // Tally's Ctrl+F4 / Ctrl+F5 close a browser tab and reload it, so these two are on F10
  { type: 'Payroll', label: 'Payroll', letter: 'Z' },
  { type: 'Attendance', label: 'Attendance', letter: 'A' },
  { type: 'Manufacturing Journal', label: 'Manufacturing Journal', letter: 'F' },
  { type: 'Rejections In', label: 'Rejections In', letter: 'I' },
  { type: 'Rejections Out', label: 'Rejections Out', letter: 'T' },
  { type: 'Job Work Out Order', label: 'Job Work Out Order', letter: 'Q' },
  { type: 'Job Work In Order', label: 'Job Work In Order', letter: 'B' },
  { type: 'Material Out', label: 'Material Out', letter: 'X' },
  { type: 'Material In', label: 'Material In', letter: 'W' },
  { type: 'Reversing Journal', label: 'Reversing Journal', letter: 'V' },
]
/** The voucher type a key press opens, if any. */
export const voucherKey = (e: { key: string; ctrlKey: boolean; altKey: boolean }) =>
  VOUCHER_KEYS.find((v) => v.key === e.key && !!v.ctrl === e.ctrlKey && !!v.alt === e.altKey)
/** The voucher types a feature brings (the rest are always there). */
export const VOUCHER_FEATURE: Partial<Record<VoucherType, string>> = {
  'Sales Order': 'orders', 'Purchase Order': 'orders', 'Delivery Note': 'orders', 'Receipt Note': 'orders',
  'Stock Journal': 'inventory', 'Physical Stock': 'inventory', Memorandum: 'optional', Payroll: 'payroll', Attendance: 'payroll',
  'Manufacturing Journal': 'inventory', 'Rejections In': 'inventory', 'Rejections Out': 'inventory',
  'Job Work Out Order': 'jobWork', 'Job Work In Order': 'jobWork', 'Material Out': 'jobWork', 'Material In': 'jobWork',
}
/** Whether the company's features (F11) leave a voucher type in use. */
export const voucherInUse = (type: VoucherType, features: Record<string, boolean>) => {
  const f = VOUCHER_FEATURE[type]
  return !f || features[f] !== false
}

function fyOf(c: Company): Period {
  const d = new Date(c.fyStart + 'T00:00:00Z')
  d.setUTCFullYear(d.getUTCFullYear() + 1)
  d.setUTCDate(d.getUTCDate() - 1)
  return { from: c.fyStart, to: d.toISOString().slice(0, 10) }
}

export function App() {
  const [company, setCompany] = useState<Company | null>(null)
  const [period, setPeriod] = useState<Period | null>(null)
  const [stack, setStack] = useState<Screen[]>([{ k: 'gateway' }])
  const [version, setVersion] = useState(0)
  const [user, setUser] = useState<User | null>(null)
  const [features, setFeatures] = useState<Record<string, boolean>>({})
  const [config, setConfig] = useState<AppConfig>(CONFIG_DEFAULTS)
  const [assist, setAssist] = useState(false)
  const [language, setLanguageState] = useState<Lang>(lang())
  const setLanguage = useCallback((l: Lang) => {
    setLang(l)
    setLanguageState(l)
  }, [])
  // the words on forms and reports follow the language too (i18nDom: labels and headings only)
  useEffect(() => translatePage(language === 'hi'), [language])
  useEffect(() => {
    if (!company) return setFeatures({})
    api.features(company.id).then((f) => setFeatures(f.features), () => setFeatures({}))
    api.config(company.id).then(setConfig, () => setConfig(CONFIG_DEFAULTS))
  }, [company, version])
  const featuresRef = useRef(features)
  featuresRef.current = features
  // a secured company waiting for its name and password (over the screens if it is already open)
  const [signIn, setSignIn] = useState<Company | null>(null)
  const companyRef = useRef<Company | null>(null)
  const beforeSignIn = useRef<Element | null>(null) // the field to return to after signing in again
  companyRef.current = company
  // focus to give back to each screen when the one above it closes
  const focusStack = useRef<(Element | null)[]>([])
  const restore = useRef<Element | null>(null)

  // the stack lives in a ref as well, so push/pop do their focus bookkeeping exactly once
  // (side effects inside a state updater would run twice under StrictMode)
  const stackRef = useRef(stack)
  const commit = useCallback((next: Screen[]) => {
    stackRef.current = next
    setStack(next)
  }, [])
  const push = useCallback(
    (s: Screen) => {
      focusStack.current.push(document.activeElement)
      commit([...stackRef.current, s])
    },
    [commit],
  )
  const pop = useCallback(() => {
    if (stackRef.current.length <= 1) return
    restore.current = focusStack.current.pop() ?? null
    commit(stackRef.current.slice(0, -1))
  }, [commit])
  const replace = useCallback((s: Screen) => commit([...stackRef.current.slice(0, -1), s]), [commit])
  const changed = useCallback(() => setVersion((v) => v + 1), [])

  useLayoutEffect(() => {
    const el = restore.current as HTMLElement | null
    restore.current = null
    if (el && el.isConnected && el !== document.body) el.focus()
    // nothing to go back to (focus was on the page itself): a menu screen takes the keys again
    else if (!document.activeElement || document.activeElement === document.body)
      document.querySelector<HTMLElement>('.screen:not([hidden]) .menu')?.focus()
  }, [stack])

  // reopen the company used last; kept on the server so the desktop app remembers it too
  useEffect(() => {
    Promise.all([api.lastCompany(), api.companies()])
      .then(([id, cs]) => cs.find((c) => c.id === id))
      .then((c) => c && open(c))
      .catch(() => {})
  }, [])

  /** Open a company: straight in when it has no users or the tab still holds a session, else ask. */
  async function open(c: Company) {
    setSession(c.id, storedSession(c.id))
    const me = await api.me(c.id).catch(() => null) // 401: a sign-in is needed
    if (me && (!me.secured || me.user)) return enter({ ...c, secured: me.secured }, me.user)
    setSignIn(c)
  }

  function enter(c: Company, u: User | null) {
    setUser(u)
    setSignIn(null)
    if (companyRef.current?.id === c.id) {
      // signed in again over the open screens: carry on where the work was
      const el = beforeSignIn.current as HTMLElement | null
      setTimeout(() => el?.isConnected && el.focus(), 0)
      return
    }
    setCompany(c)
    setPeriod(fyOf(c))
    commit([{ k: 'gateway' }])
    focusStack.current = []
    api.setLastCompany(c.id).catch(() => {})
  }

  function closeCompany() {
    if (company && user) api.logout(company.id).catch(() => {})
    if (company) setSession(company.id, null)
    setUser(null)
    setSignIn(null)
    setCompany(null)
    api.setLastCompany(null).catch(() => {})
  }

  // the server wants a sign-in (the session ran out): ask over the open screens
  useEffect(() => {
    const ask = () => {
      if (!companyRef.current) return
      beforeSignIn.current = document.activeElement
      setSignIn(companyRef.current)
    }
    window.addEventListener(SIGN_IN_EVENT, ask)
    return () => window.removeEventListener(SIGN_IN_EVENT, ask)
  }, [])

  useEffect(() => {
    if (!company || signIn) return
    const onKey = (e: KeyboardEvent) => {
      // Esc and Ctrl+Q both quit the current screen (screens with unsaved work intercept first)
      if (e.key === 'Escape' || (e.ctrlKey && (e.key === 'q' || e.key === 'Q'))) {
        e.preventDefault()
        pop()
        return
      }
      // Ctrl+Space: AI Assist about the screen underneath
      if (e.ctrlKey && e.code === 'Space') {
        e.preventDefault()
        setAssist((x) => !x)
        return
      }
      if (moveInReport(e)) return
      // Ctrl+A accepts the form being filled, as in Tally (voucher screens handle it themselves first)
      if (e.ctrlKey && !e.altKey && (e.key === 'a' || e.key === 'A') && !e.defaultPrevented) {
        const form = (document.activeElement as HTMLElement | null)?.closest('form')
        if (form) {
          e.preventDefault()
          form.requestSubmit()
          return
        }
      }
      // Alt+P prints the screen (Save as PDF is in the print dialog); Alt+E exports its tables
      if (e.altKey && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault()
        window.print()
        return
      }
      if (e.altKey && (e.key === 'e' || e.key === 'E')) {
        e.preventDefault()
        exportScreen(company.name)
        return
      }
      if (e.key === 'F11' && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        push({ k: 'features' })
        return
      }
      // F12 Configure (a browser may keep F12 for its developer tools: Ctrl+F12 too)
      if (e.key === 'F12' && !e.altKey) {
        e.preventDefault()
        push({ k: 'config' })
        return
      }
      // Alt+M e-mails the screen (a voucher's print, a report), as Tally's E-mail button
      if (e.altKey && (e.key === 'm' || e.key === 'M')) {
        e.preventDefault()
        const shot = captureScreen()
        if (shot) push({ k: 'email', html: shot.html, subject: shot.title, to: shot.to, voucherId: shot.voucherId, pdf: shot.pdf })
        return
      }
      if (e.altKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        push({ k: 'menu', menu: 'company' })
        return
      }
      if (e.altKey && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault()
        push({ k: 'data' })
        return
      }
      if (e.altKey && e.key === 'F2') {
        e.preventDefault()
        push({ k: 'period' })
        return
      }
      const vk = voucherKey(e)
      if (vk && voucherInUse(vk.type, featuresRef.current)) {
        e.preventDefault()
        push({ k: 'voucher', type: vk.type })
      }
      if (e.key === 'F10' && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        push({ k: 'menu', menu: 'voucher-types' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [company, push, pop, signIn])

  if (!company || !period)
    return signIn ? <SignIn company={signIn} onDone={(u) => enter(signIn, u)} onCancel={() => setSignIn(null)} /> : <CompanySelect onOpen={open} />

  const signedIn = (u: User, token: string) => {
    setSession(company.id, token)
    setUser(u)
    setCompany({ ...company, secured: true })
  }
  const ctx: Ctx = { company, period, setPeriod, push, pop, replace, closeCompany, openCompany: open, version, changed, user, signedIn, features, config, language, setLanguage }

  return (
    <AppCtx.Provider value={ctx}>
      <div className="shell">
        <header className="topbar">
          <span className="brand">
            <span className="brand-mark" aria-hidden="true">B</span>Books
          </span>
          <span className="sep" />
          <span className="co">{company.name}</span>
          {user && (
            <span className="muted-on-band">
              {user.username} ({user.role})
            </span>
          )}
          <button className="linkish" onClick={closeCompany} title="Change company">
            change
          </button>
          <span className="spacer" />
          <span className="muted-on-band">
            {t('Period')}: {fmtDate(period.from)} to {fmtDate(period.to)}
          </span>
        </header>
        <main className="body">
          {stack.map((s, i) => (
            // every open screen stays mounted so nothing typed is lost; only the top one shows
            <section className="screen" key={i} hidden={i !== stack.length - 1}>
              <ActiveCtx.Provider value={i === stack.length - 1}>{render(s)}</ActiveCtx.Provider>
            </section>
          ))}
          <aside className="buttonbar">
            <div className="rail-heading">{t('Company')}</div>
            <button onClick={() => push({ k: 'period' })}>
              <b>Alt+F2</b> {t('Period')}
            </button>
            <button onClick={() => push({ k: 'data' })}>
              <b>Alt+Y</b> {t('Data')}
            </button>
            <button onClick={() => window.print()}>
              <b>Alt+P</b> {t('Print')}
            </button>
            <button onClick={() => exportScreen(company.name)}>
              <b>Alt+E</b> {t('Export')}
            </button>
            <button
              onClick={() => {
                const shot = captureScreen()
                if (shot) push({ k: 'email', html: shot.html, subject: shot.title, to: shot.to, voucherId: shot.voucherId, pdf: shot.pdf })
              }}
            >
              <b>Alt+M</b> {t('E-mail')}
            </button>
            <div className="rail-heading">{t('Vouchers')}</div>
            {VOUCHER_KEYS.filter((v) => v.key && voucherInUse(v.type, features)).map((v) => (
              <button key={v.label} onClick={() => push({ k: 'voucher', type: v.type })}>
                <b>{v.label.split(' ')[0]}</b> {t(v.type)}
              </button>
            ))}
            <button onClick={() => push({ k: 'menu', menu: 'voucher-types' })}>
              <b>F10</b> {t('Other Vouchers')}
            </button>
            {stack.length > 1 && (
              <button onClick={pop}>
                <b>Esc</b> {t('Back')}
              </button>
            )}
          </aside>
        </main>
        <footer className="keybar">
          <span><b>Enter</b> {t('Open')}</span>
          <span><b>Esc</b> {t('Back')}</span>
          <span><b>Ctrl+A</b> {t('Accept')}</span>
          <span><b>Ctrl+Space</b> AI Assist</span>
          <span className="spacer" />
          <span><b>Q</b> {t('Quit')}</span>
        </footer>
      </div>
      {assist && <AiAssistPanel onClose={() => setAssist(false)} />}
      {signIn && <SignIn company={signIn} over onDone={(u) => enter(signIn, u)} onCancel={closeCompany} />}
    </AppCtx.Provider>
  )
}

function render(s: Screen) {
  switch (s.k) {
    case 'gateway':
      return <Gateway />
    case 'menu':
      return <SubMenu menu={s.menu} />
    case 'voucher':
      return (
        <VoucherTypeProvider voucherTypeId={s.voucherTypeId} voucherId={s.id}>
          <VoucherScreen type={s.type} id={s.id} invoice={s.invoice} />
        </VoucherTypeProvider>
      )
    case 'ledger':
      return <LedgerForm id={s.id} initialName={s.name} onCreated={s.onCreated} />
    case 'group':
      return <GroupForm id={s.id} />
    case 'pick-master':
      return <MasterPick kind={s.kind} />
    case 'stock-value':
      return <StockValue />
    case 'chart':
      return <ChartOfAccounts />
    case 'daybook':
      return <DayBook type={s.type} range={s.range} />
    case 'tb':
      return <TrialBalanceView />
    case 'pl':
      return <ProfitLossView />
    case 'bs':
      return <BalanceSheetView />
    case 'cash-flow':
      return <CashFlowView month={s.month} />
    case 'funds-flow':
      return <FundsFlowView />
    case 'ratios':
      return <RatiosView />
    case 'stock-ageing':
      return <StockAgeingView />
    case 'e-documents':
      return <EDocRegisterView />
    case 'voucher-type':
      return <VoucherTypeForm id={s.id} />
    case 'pick-voucher-type':
      return <VoucherTypePick />
    case 'gst-classification':
      return <GstClassificationForm id={s.id} />
    case 'pick-gst-classification':
      return <GstClassificationPick />
    case 'statistics':
      return <StatisticsView />
    case 'tds-details':
      return <TdsDetailsForm />
    case 'employee':
      return <EmployeeForm id={s.id} />
    case 'employee-group':
      return <EmployeeGroupForm id={s.id} />
    case 'attendance-type':
      return <AttendanceTypeForm id={s.id} />
    case 'pay-head':
      return <PayHeadForm id={s.id} />
    case 'salary-details':
      return <SalaryDetailsForm centreId={s.centreId} />
    case 'pick-payroll':
      return <PayrollPick kind={s.kind} />
    case 'pay-sheet':
      return <PaySheetView />
    case 'bom':
      return <BomForm itemId={s.itemId} />
    case 'cost-estimation':
      return <CostEstimationView />
    case 'job-work':
      return <JobWorkView />
    case 'payslip':
      return <PayslipView employeeId={s.employeeId} />
    case 'attendance-sheet':
      return <AttendanceSheetView />
    case 'payroll-register':
      return <PayrollRegisterView />
    case 'pf':
      return <PfView />
    case 'esi':
      return <EsiView />
    case 'professional-tax':
      return <ProfessionalTaxView />
    case 'nps':
      return <NpsView />
    case 'salary-tax':
      return <SalaryTaxView />
    case 'gratuity':
      return <GratuityView />
    case 'loans':
      return <LoansView />
    case 'tax-declarations':
      return <TaxDeclarationsForm />
    case 'arrears':
      return <ArrearsView />
    case 'statutory-payment':
      return <StatutoryPaymentView />
    case 'currency':
      return <CurrencyForm id={s.id} />
    case 'pick-currency':
      return <CurrencyPick />
    case 'rates':
      return <RatesForm />
    case 'forex-gain-loss':
      return <ForexGainLossView />
    case 'tds-nature':
      return <TdsNatureForm id={s.id} kind={s.kind} />
    case 'pick-tds-nature':
      return <TdsNaturePick kind={s.kind} />
    case 'tds-computation':
      return <TdsComputationView kind={s.kind} />
    case 'tds-outstandings':
      return <TdsOutstandingsView kind={s.kind} />
    case 'challan-reconciliation':
      return <ChallanReconciliationView />
    case 'msme-update':
      return <MsmeUpdateView />
    case 'msme-form1':
      return <MsmeForm1View />
    case 'msme-interest':
      return <MsmeInterestView />
    case 'tds-party-rates':
      return <TdsPartyRatesView />
    case 'budget':
      return <BudgetForm key={s.id ?? 'new'} id={s.id} />
    case 'pick-budget':
      return <BudgetPick next={s.next} />
    case 'budget-variance':
      return <BudgetVarianceView id={s.id} />
    case 'scenario':
      return <ScenarioForm key={s.id ?? 'new'} id={s.id} />
    case 'pick-scenario':
      return <ScenarioPick />
    case 'reversing-journals':
      return <ReversingJournalsView />
    case 'config':
      return <ConfigForm />
    case 'tally-audit':
      return <TallyAuditView />
    case 'batches':
      return <BatchesView />
    case 'gateway-reco':
      return <GatewayRecoView />
    case 'kerala-flood-cess':
      return <KeralaFloodCessView />
    case 'cost-tracks':
      return <CostTracksView />
    case 'pos-register':
      return <PosRegisterView />
    case 'order-analysis':
      return <OrderAnalysisView key={s.type} type={s.type} />
    case 'tracked-vouchers':
      return <TrackedVouchersView />
    case 'import':
      return <ImportScreen />
    case 'split':
      return <SplitScreen />
    case 'gst-reco':
      return <GstRecoView key={s.source} source={s.source} />
    case 'gst-advances':
      return <GstAdvancesView />
    case 'gstr9':
      return <Gstr9View />
    case 'composition':
      return <CompositionView key={String(s.annual)} annual={s.annual} />
    case 'gst-challans':
      return <GstChallansView />
    case 'gst-parties':
      return <GstPartiesView />
    case 'tds-challan':
      return <TdsChallanForm voucherId={s.voucherId} />
    case 'form-26q':
      return <Form26QView key={s.form} form={s.form} />
    case 'dashboard':
      return <DashboardView />
    case 'features':
      return <FeaturesForm />
    case 'stock-category-summary':
      return <StockCategorySummaryView categoryId={s.categoryId} />
    case 'stock-query':
      return <StockQueryView itemId={s.itemId} />
    case 'e-document':
      return <EDocumentView voucherId={s.voucherId} />
    case 'company-details':
      return <CompanyDetailsForm />
    case 'gsp-settings':
      return <GspSettingsForm />
    case 'money-map':
      return <MoneyMapView />
    case 'review':
      return <ReviewView />
    case 'agents':
      return <AgentsView />
    case 'ai-settings':
      return <AiSettingsForm />
    case 'mail-settings':
      return <MailSettingsForm />
    case 'mail-log':
      return <MailLogView />
    case 'email':
      return <EmailScreen html={s.html} subject={s.subject} to={s.to} voucherId={s.voucherId} pdf={s.pdf} />
    case 'movement':
      return s.itemId ? <ItemMovementView itemId={s.itemId} /> : <MovementView />
    case 'reorder':
      return <ReorderView />
    case 'ledger-pick':
      return <LedgerPick />
    case 'statement':
      return <LedgerStatement ledgerId={s.ledgerId} range={s.range} />
    case 'period':
      return <PeriodScreen />
    case 'bills':
      return <BillsView side={s.side} overdue={s.overdue} />
    case 'ledger-outstanding':
      return <LedgerOutstandingView ledgerId={s.ledgerId} />
    case 'group-outstanding':
      return <GroupOutstandingView groupId={s.groupId} />
    case 'pick-outstanding':
      return <OutstandingPick kind={s.kind} />
    case 'group-summary':
      return <GroupSummaryView groupId={s.groupId} cashBank={s.cashBank} />
    case 'group-vouchers':
      return <GroupVouchersView groupId={s.groupId} />
    case 'register':
      return <RegisterView type={s.type} />
    case 'ledger-monthly':
      return <LedgerMonthlyView ledgerId={s.ledgerId} />
    case 'pick-group':
      return <GroupPick next={s.next} />
    case 'pick-bank':
      return <BankPick next={s.next} />
    case 'cheque-register':
      return <ChequeRegisterView bankId={s.bankId} print={s.print} />
    case 'cheque-print':
      return <ChequePrint voucherId={s.voucherId} chequeNo={s.chequeNo} />
    case 'deposit-slip':
      return <DepositSlipView bankId={s.bankId} />
    case 'payment-advice':
      return <PaymentAdvice voucherId={s.voucherId} />
    case 'pick-payment-advice':
      return <PaymentAdvicePick />
    case 'post-dated':
      return <PostDatedView />
    case 'cancelled':
      return <CancelledView />
    case 'drafts':
      return <DraftsView kind={s.kind} />
    case 'negative-ledgers':
      return <NegativeLedgersView />
    case 'negative-stock':
      return <NegativeStockView />
    case 'bank-reco':
      return <BankRecoView ledgerId={s.ledgerId} />
    case 'edit-log':
      return <EditLogView />
    case 'data':
      return <DataScreen />
    case 'voucher-print':
      return <VoucherPrint id={s.id} />
    case 'edit-history':
      return <EditHistoryView entity={s.entity} id={s.id} label={s.label} />
    case 'unit':
      return <UnitForm id={s.id} initialSymbol={s.symbol} onCreated={s.onCreated} />
    case 'tree-master':
      return <TreeForm kind={s.kind} id={s.id} />
    case 'stock-item':
      return <StockItemForm id={s.id} initialName={s.name} onCreated={s.onCreated} />
    case 'pick-inventory':
      return <InventoryPick kind={s.kind} next={s.next} />
    case 'stock-summary':
      return <StockSummaryView groupId={s.groupId} />
    case 'stock-item-vouchers':
      return <StockItemVouchersView itemId={s.itemId} />
    case 'godown-summary':
      return <GodownSummaryView />
    case 'cost-category':
      return <CostCategoryForm id={s.id} />
    case 'cost-centre':
      return <CostCentreForm id={s.id} />
    case 'pick-cost':
      return <CostPick kind={s.kind} next={s.next} />
    case 'pick-cost-breakup':
      return <CostBreakupPick of={s.of} />
    case 'cost-summary':
      return <CostSummaryView />
    case 'interest':
      return s.groupId ? <InterestView groupId={s.groupId} /> : <InterestView side={s.side ?? 'receivable'} />
    case 'ledger-interest':
      return <LedgerInterestView ledgerId={s.ledgerId} />
    case 'pick-interest':
      return <InterestPick of={s.of} />
    case 'centre-breakup':
      return <CentreBreakupView centreId={s.centreId} />
    case 'cost-breakup':
      return s.ledgerId ? <CostBreakupView ledgerId={s.ledgerId} /> : <CostBreakupView groupId={s.groupId!} />
    case 'pending':
      return <PendingView type={s.type} />
    case 'gst-registration':
      return <GstRegistration />
    case 'gstr1':
      return <Gstr1View />
    case 'gstr3b':
      return <Gstr3bView />
    case 'users':
      return <UsersView />
    case 'user':
      return <UserForm id={s.id} />
    case 'change-password':
      return <ChangePassword />
  }
}

/**
 * Reports drill down from the keyboard, as in Tally: ↑/↓ move a highlight over the rows that
 * open something, Enter opens it. Screens with their own row keys (Day Book) opt out with
 * data-own-keys. Ignored while typing in a field.
 */
function moveInReport(e: KeyboardEvent): boolean {
  if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(e.key) || e.ctrlKey || e.altKey) return false
  const t = e.target as HTMLElement
  if (t.closest('input, select, textarea, .menu, button')) return false
  const screen = document.querySelector<HTMLElement>('.screen:not([hidden])')
  if (!screen || screen.querySelector('[data-own-keys]')) return false
  // rows, or (in a two-sided statement) cells: the left column first, then the right
  const rows = [...screen.querySelectorAll<HTMLElement>('tr.clickable, td.clickable')].sort(
    (a, b) => Number(a.dataset.col ?? 0) - Number(b.dataset.col ?? 0),
  )
  if (!rows.length) return false
  let i = rows.findIndex((r) => r.classList.contains('sel'))
  if (e.key === 'Enter') {
    if (i < 0) return false
    rows[i].click()
  } else {
    i = e.key === 'ArrowDown' ? Math.min(i + 1, rows.length - 1) : Math.max(i - 1, 0)
    rows.forEach((r, n) => r.classList.toggle('sel', n === i))
    rows[i].scrollIntoView({ block: 'nearest' })
  }
  e.preventDefault()
  return true
}
