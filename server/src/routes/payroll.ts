/**
 * Payroll: employee groups and employees, attendance / production types, pay heads, salary
 * details, the Payroll voucher's auto-fill and the payroll reports.
 */
import type { Router, Request } from 'express'
import { z } from 'zod'
import { pool } from '../db'
import { PAY_TYPES, STATUTORY, type Statutory } from '../engine/payroll'
import {
  alterAttendanceType, alterEmployee, alterEmployeeGroup, alterPayHead, attendanceSheet, createAttendanceType, createEmployee, createEmployeeGroup, createPayHead,
  deleteAttendanceType, deletePayHead, deletePayrollCentre, esiReport, gratuityReport, npsReport, payrollFill, payrollMasters, payrollRegister, paySheet, payslip, pfReport,
  ptReport, salaryTaxReport, setSalary, createLoan, deleteLoan, loanSchedule, getDeclarations, setDeclarations, payrollArrears, statutoryDues, type StatutoryKind,
} from '../payroll'

type Period = { from: string; to: string }

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const text = z.string().nullish()
const group = z.object({ name: z.string().trim().min(1), categoryId: z.number().int().nullish(), parentId: z.number().int().nullish() })
const employee = z.object({
  name: z.string().trim().min(1),
  categoryId: z.number().int().nullish(),
  groupId: z.number().int().nullish(),
  number: text, designation: text, department: text, location: text,
  gender: z.enum(['Male', 'Female', 'Other']).nullish(),
  dateOfBirth: date.nullish(),
  dateOfJoining: date,
  dateOfLeaving: date.nullish(),
  pan: text, uan: text, pfNumber: text, esiNumber: text, pran: text, bankName: text, accountNo: text, ifsc: text,
  taxRegime: z.enum(['new', 'old']).default('new'),
})
const attendanceType = z.object({
  name: z.string().trim().min(1),
  kind: z.enum(['attendance', 'leave with pay', 'leave without pay', 'production']),
  unit: z.string().optional(),
})
const payHead = z.object({
  name: z.string().trim().min(1),
  groupId: z.number().int(),
  payType: z.enum(PAY_TYPES),
  statutory: z.enum(Object.keys(STATUTORY) as [Statutory, ...Statutory[]]).nullish(),
  calculation: z.enum(['user', 'flat', 'attendance', 'production', 'computed']),
  attendanceTypeId: z.number().int().nullish(),
  perDayDays: z.number().int().min(1).max(31).nullish(),
  formula: z.array(z.object({ payHeadId: z.number().int(), sign: z.union([z.literal(1), z.literal(-1)]) })).default([]),
  ceiling: z.number().int().positive().nullish(),
  slabs: z.array(z.object({ upTo: z.number().int().nullable(), rate: z.number().int(), value: z.number().int() })).default([]),
  rounding: z.enum(['normal', 'up', 'down', 'none']).default('normal'),
  roundTo: z.number().int().positive().default(100),
  expenseLedgerId: z.number().int().nullish(),
  taxComponent: z.enum(['basic', 'hra']).nullish(),
})

export function addPayrollRoutes(company: Router, cid: (req: Request) => number, period: (req: Request) => Promise<Period>) {
  const id = (req: Request) => Number(req.params.id)
  company.get('/payroll', async (req, res) => res.json(await payrollMasters(pool, cid(req))))

  company.post('/employee-groups', async (req, res) => res.status(201).json({ id: await createEmployeeGroup(cid(req), group.parse(req.body)) }))
  company.put('/employee-groups/:id', async (req, res) => {
    await alterEmployeeGroup(cid(req), id(req), group.parse(req.body))
    res.status(204).end()
  })
  company.post('/employees', async (req, res) => res.status(201).json({ id: await createEmployee(cid(req), employee.parse(req.body)) }))
  company.put('/employees/:id', async (req, res) => {
    await alterEmployee(cid(req), id(req), employee.parse(req.body))
    res.status(204).end()
  })
  // an employee or an employee group
  company.delete('/employees/:id', async (req, res) => {
    await deletePayrollCentre(cid(req), id(req))
    res.status(204).end()
  })

  company.post('/attendance-types', async (req, res) => res.status(201).json({ id: await createAttendanceType(cid(req), attendanceType.parse(req.body)) }))
  company.put('/attendance-types/:id', async (req, res) => {
    await alterAttendanceType(cid(req), id(req), attendanceType.parse(req.body))
    res.status(204).end()
  })
  company.delete('/attendance-types/:id', async (req, res) => {
    await deleteAttendanceType(cid(req), id(req))
    res.status(204).end()
  })

  company.post('/pay-heads', async (req, res) => res.status(201).json({ id: await createPayHead(cid(req), payHead.parse(req.body)) }))
  company.put('/pay-heads/:id', async (req, res) => {
    await alterPayHead(cid(req), id(req), payHead.parse(req.body))
    res.status(204).end()
  })
  company.delete('/pay-heads/:id', async (req, res) => {
    await deletePayHead(cid(req), id(req))
    res.status(204).end()
  })

  /** Salary details of an employee or group from a date (no lines removes that revision). */
  company.put('/salary/:id', async (req, res) => {
    const b = z.object({ effectiveFrom: date, lines: z.array(z.object({ payHeadId: z.number().int(), rate: z.number().int().nullable() })) }).parse(req.body)
    await setSalary(cid(req), id(req), b.effectiveFrom, b.lines)
    res.status(204).end()
  })

  company.post('/payroll/fill', async (req, res) => {
    const b = z.object({
      from: date, to: date, date, payableLedgerId: z.number().int(), groupId: z.number().int().nullish(), employeeIds: z.array(z.number().int()).optional(),
      values: z.array(z.object({ employeeId: z.number().int(), payHeadId: z.number().int(), amount: z.number().int().min(0) })).optional(),
      voucherId: z.number().int().optional(),
      arrears: z.object({ payHeadId: z.number().int(), from: date, to: date }).optional(),
    }).parse(req.body)
    res.json(await payrollFill(cid(req), b))
  })
  // loans and advances to employees
  company.get('/payroll/loans', async (req, res) =>
    res.json(await loanSchedule(pool, cid(req), typeof req.query.asOf === 'string' && date.safeParse(req.query.asOf).success ? req.query.asOf : '9999-12-31')))
  company.post('/payroll/loans', async (req, res) => {
    const b = z.object({ employeeId: z.number().int(), payHeadId: z.number().int(), givenOn: date, amount: z.number().int(), instalment: z.number().int(), recoverFrom: date,
      note: z.string().optional() }).parse(req.body)
    res.status(201).json({ id: await createLoan(cid(req), b) })
  })
  company.delete('/payroll/loans/:id', async (req, res) => {
    await deleteLoan(cid(req), id(req))
    res.status(204).end()
  })
  // the old regime's declarations of an employee for a financial year (?fy=yyyy-04-01)
  const fyQ = (req: Request) => date.parse(req.query.fy)
  company.get('/employees/:id/declarations', async (req, res) => res.json(await getDeclarations(cid(req), id(req), fyQ(req))))
  company.put('/employees/:id/declarations', async (req, res) => {
    const amount = z.number().int().min(0).default(0)
    const b = z.object({ rentPaid: amount, metro: z.boolean().default(false), sec80c: amount, sec80d: amount, sec80ccd1b: amount, sec24b: amount, other: amount }).parse(req.body)
    await setDeclarations(cid(req), id(req), fyQ(req), b)
    res.status(204).end()
  })
  company.get('/reports/payroll-arrears', async (req, res) => {
    const p = await period(req)
    res.json(await payrollArrears(cid(req), p.from, p.to, req.query.payHead ? Number(req.query.payHead) : undefined))
  })
  company.get('/reports/statutory-dues', async (req, res) => {
    const p = await period(req)
    res.json(await statutoryDues(pool, cid(req), z.enum(['pf', 'esi', 'pt', 'income-tax', 'nps']).parse(req.query.kind) as StatutoryKind, p.from, p.to))
  })

  const groupQ = (req: Request) => (req.query.group ? Number(req.query.group) : null)
  company.get('/reports/pay-sheet', async (req, res) => {
    const p = await period(req)
    res.json(await paySheet(pool, cid(req), p.from, p.to, groupQ(req)))
  })
  company.get('/reports/payslip/:id', async (req, res) => {
    const p = await period(req)
    res.json(await payslip(pool, cid(req), id(req), p.from, p.to))
  })
  company.get('/reports/attendance-sheet', async (req, res) => {
    const p = await period(req)
    res.json(await attendanceSheet(pool, cid(req), p.from, p.to))
  })
  company.get('/reports/payroll-register', async (req, res) => {
    const p = await period(req)
    res.json(await payrollRegister(pool, cid(req), p.from, p.to))
  })
  company.get('/reports/pf', async (req, res) => {
    const p = await period(req)
    res.json(await pfReport(pool, cid(req), p.from, p.to))
  })
  company.get('/reports/esi', async (req, res) => {
    const p = await period(req)
    res.json(await esiReport(pool, cid(req), p.from, p.to))
  })
  company.get('/reports/professional-tax', async (req, res) => {
    const p = await period(req)
    res.json(await ptReport(pool, cid(req), p.from, p.to))
  })
  company.get('/reports/nps', async (req, res) => {
    const p = await period(req)
    res.json(await npsReport(pool, cid(req), p.from, p.to))
  })
  /** Income tax on salary for the financial year starting ?fy, as of ?asOf. */
  company.get('/reports/salary-tax', async (req, res) => {
    const q = z.object({ fy: date, asOf: date }).parse(req.query)
    res.json(await salaryTaxReport(pool, cid(req), q.fy, q.asOf))
  })
  company.get('/reports/gratuity', async (req, res) => {
    const q = z.object({ asOf: date }).parse(req.query)
    res.json(await gratuityReport(pool, cid(req), q.asOf))
  })
}
