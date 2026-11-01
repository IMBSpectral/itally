import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type Anthropic from '@anthropic-ai/sdk'
import { pool } from '../src/db'
import { migrate } from '../src/migrate'
import { createCompany, createLedger, loadGroups, postVoucher } from '../src/books'
import { setToday } from '../src/engine/clock'
import { decide, listAgents, moneyMap, reviewQueue, runDueAgents, setAgent, collectionDrafts } from '../src/intelligence'
import { aiSettings, askAi, setAiSettings } from '../src/ai'

const R = (rupees: number) => Math.round(rupees * 100)
before(() => migrate(() => {}))
after(async () => {
  setToday(null)
  await pool.end()
})

test('Money Map, the review queue, the assistants and AI Assist', async () => {
  setToday('2026-10-31')
  const c = await createCompany({ name: `Intel ${Date.now()}`, booksBegin: '2026-04-01' })
  const groups = await loadGroups(pool, c)
  const g = (n: string) => [...groups.values()].find((x) => x.name === n)!.id
  const L = (name: string, group: string, extra: object = {}) => createLedger(c, { name, groupId: g(group), ...extra })
  const bank = await L('HDFC', 'Bank Accounts', { opening: R(100000) })
  await L('Capital', 'Capital Account', { opening: -R(100000) })
  const sales = await L('Sales', 'Sales Accounts', { billwise: false })
  const purchases = await L('Purchases', 'Purchase Accounts', { billwise: false })
  const apex = await L('Apex Auto', 'Sundry Debtors', { billwise: true, creditDays: 30 })
  const bharat = await L('Bharat Steel', 'Sundry Creditors', { billwise: true, creditDays: 15 })
  const sell = (date: string, amount: number, bill: string) => postVoucher(c, { type: 'Sales', date, entries: [
    { ledgerId: apex, amount: R(amount), bills: [{ type: 'New Ref', name: bill, amount: R(amount) }] }, { ledgerId: sales, amount: -R(amount) }] })
  // an old sale (overdue by more than 60 days), a recent one due within 30 days, and the same sale entered twice
  await sell('2026-06-01', 40000, 'S-1')
  await sell('2026-10-20', 25000, 'S-2')
  await sell('2026-10-21', 25000, 'S-3')
  // a supplier bill due on 10 November; a payment from the bank the bank hasn't cleared; a post-dated cheque
  await postVoucher(c, { type: 'Purchase', date: '2026-10-26', entries: [
    { ledgerId: purchases, amount: R(30000) }, { ledgerId: bharat, amount: -R(30000), bills: [{ type: 'New Ref', name: 'B-9', amount: -R(30000) }] }] })
  await postVoucher(c, { type: 'Payment', date: '2026-10-01', entries: [{ ledgerId: purchases, amount: R(5000) }, { ledgerId: bank, amount: -R(5000) }] })
  await postVoucher(c, { type: 'Payment', date: '2026-11-15', postDated: true, entries: [{ ledgerId: purchases, amount: R(8000) }, { ledgerId: bank, amount: -R(8000) }] })

  const m = await moneyMap(c, 30, R(20000))
  assert.equal(m.cashNow, R(95000))
  assert.equal(m.expected, R(90000), 'overdue S-1 and the two due by 30 November')
  assert.equal(m.planned, R(38000), 'B-9 and the post-dated payment')
  assert.deepEqual([m.projected, m.headroom], [R(147000), R(127000)])
  assert.deepEqual(m.priority.map((p) => [p.bill, p.reason]), [['B-9', 'Due on 2026-11-10']])

  const q = await reviewQueue(c)
  const kinds = q.open.map((s) => s.kind).sort()
  assert.deepEqual(kinds, ['bank', 'duplicate', 'overdue'])
  const dup = q.open.find((s) => s.kind === 'duplicate')!
  assert.match(dup.detail, /Apex Auto, ₹25,000.00/)
  assert.equal(q.open[0].severity, 'high', 'the worst first')
  await decide(c, dup.key, 'dismissed', 'owner')
  assert.deepEqual((await reviewQueue(c)).open.map((s) => s.kind).sort(), ['bank', 'overdue'])
  assert.equal((await reviewQueue(c)).decided[0].status, 'dismissed')

  const drafts = await collectionDrafts(c)
  assert.equal(drafts[0].party, 'Apex Auto')
  assert.match(drafts[0].text, /S-1 of 2026-06-01, due 2026-07-01: ₹40,000.00/)

  // an assistant on a schedule: runs once after its time, India time, and not again that day
  await setAgent(c, 'voucher-review', { active: true, schedule: 'daily 09:00' })
  await runDueAgents(new Date('2026-10-31T03:00:00Z')) // 08:30 in India: not yet
  assert.equal((await listAgents(c)).find((a) => a.kind === 'voucher-review')!.lastRun, null)
  await runDueAgents(new Date('2026-10-31T03:45:00Z')) // 09:15
  const ran = (await listAgents(c)).find((a) => a.kind === 'voucher-review')!
  assert.match(ran.lastResult ?? '', /1 suggestion/)
  await assert.rejects(setAgent(c, 'collections', { active: true, schedule: 'hourly' }), /daily HH:MM/)

  // AI Assist: off until switched on with a key; the request carries the screen and the summary
  await assert.rejects(askAi(c, 'How much does Apex owe?', { text: 'x' }), /AI Assist is off/)
  await assert.rejects(setAiSettings(c, { enabled: true }), /API key/)
  await setAiSettings(c, { enabled: true, apiKey: 'sk-ant-test' })
  assert.deepEqual(await aiSettings(c), { enabled: true, apiKeySet: true })
  let sent: Record<string, unknown> | null = null
  const fake = { beta: { messages: { create: async (p: Record<string, unknown>) => {
    sent = p
    return { stop_reason: 'end_turn', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Apex Auto owes ₹90,000.00.' }] }
  } } } } as unknown as Anthropic
  const a = await askAi(c, 'How much does Apex owe?', { title: 'Bills Receivable', text: 'Apex Auto  90,000.00 Dr' }, fake)
  assert.equal(a.answer, 'Apex Auto owes ₹90,000.00.')
  const p = sent as unknown as { model: string; fallbacks: string; betas: string[]; messages: { content: string }[] }
  assert.deepEqual([p.model, p.fallbacks, p.betas], ['claude-opus-5-5', 'default', ['server-side-fallback-2026-07-01']])
  assert.match(p.messages[0].content, /Apex Auto {2}90,000.00 Dr/)
  assert.match(p.messages[0].content, /over 60 days past due/, 'the open review items go with it')
})
