/**
 * Company security over HTTP: the guard every company route passes through, signing in and
 * out, and the Owner's users-and-passwords screen.
 */
import type { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { runAs } from '../db'
import {
  allowed, alterUser, changePassword, createUser, deleteUser, isSecured, listUsers, login, logout, ROLES, sessionUser, type SessionUser,
  alterLevel, createLevel, deleteLevel, getLevel, levelRefuses, listLevels,
} from '../security'
import { today } from '../engine/clock'

/** The session token: the Authorization header, or ?token= for a plain download link. */
const tokenOf = (req: Request) => /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1] ?? (typeof req.query.token === 'string' ? req.query.token : undefined)
const userOf = (res: Response) => res.locals.user as SessionUser | undefined

/** Open companies pass; a secured one needs a session for it, and a role that allows the request. */
export function guard(cid: (req: Request) => number) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const companyId = cid(req)
    if (req.method === 'POST' && req.path === '/login') return next()
    if (!(await isSecured(companyId))) return next()
    const token = tokenOf(req)
    const user = token ? await sessionUser(token) : undefined
    if (!user || user.companyId !== companyId) return res.status(401).json({ error: 'Sign in to this company' })
    if (!allowed(user.role, req.method, req.path)) return res.status(403).json({ error: `Your role (${user.role}) does not allow this` })
    // a security level of the company's own takes away more
    if (user.levelId) {
      const why = levelRefuses(await getLevel(companyId, user.levelId), req.method, req.path, req.body, today())
      if (why) return res.status(403).json({ error: why })
    }
    res.locals.user = user
    runAs(user.username, next) // the Edit Log names them
  }
}

const userBody = z.object({ username: z.string(), password: z.string(), role: z.enum(ROLES), levelId: z.number().int().nullish() })
const levelBody = z.object({
  name: z.string(), baseRole: z.enum(['Accountant', 'Data Entry', 'Viewer']), deniedVouchers: z.array(z.string()).default([]), deniedReports: z.array(z.string()).default([]),
  backDays: z.number().int().min(0).nullable().default(null),
})

export function addSecurityRoutes(company: Router, cid: (req: Request) => number) {
  company.post('/login', async (req, res) => {
    const b = z.object({ username: z.string(), password: z.string() }).parse(req.body)
    res.json(await login(cid(req), b.username, b.password))
  })
  company.post('/logout', async (req, res) => {
    const token = tokenOf(req)
    if (token) await logout(token)
    res.status(204).end()
  })
  /** Whether the company is secured, and who is signed in. */
  company.get('/me', async (req, res) => res.json({ secured: await isSecured(cid(req)), user: userOf(res) ?? null }))
  company.put('/me/password', async (req, res) => {
    const user = userOf(res)
    if (!user) return res.status(400).json({ error: 'This company has no users' })
    const b = z.object({ current: z.string(), next: z.string() }).parse(req.body)
    await changePassword(user, b.current, b.next)
    res.status(204).end()
  })

  company.get('/users', async (req, res) => res.json(await listUsers(cid(req))))
  // on an open company this creates the first user (the Owner), which secures it
  company.post('/users', async (req, res) => res.status(201).json({ id: await createUser(cid(req), userBody.parse(req.body)) }))
  company.put('/users/:id', async (req, res) => {
    await alterUser(cid(req), Number(req.params.id), z.object({ role: z.enum(ROLES), password: z.string().nullish(), levelId: z.number().int().nullish() }).parse(req.body))
    res.status(204).end()
  })
  // security levels: the Owner's, as users are (the /users prefix keeps them to the Owner)
  company.get('/users/levels', async (req, res) => res.json(await listLevels(cid(req))))
  company.post('/users/levels', async (req, res) => res.status(201).json({ id: await createLevel(cid(req), levelBody.parse(req.body)) }))
  company.put('/users/levels/:id', async (req, res) => {
    await alterLevel(cid(req), Number(req.params.id), levelBody.parse(req.body))
    res.status(204).end()
  })
  company.delete('/users/levels/:id', async (req, res) => {
    await deleteLevel(cid(req), Number(req.params.id))
    res.status(204).end()
  })
  company.delete('/users/:id', async (req, res) => {
    if (userOf(res)?.id === Number(req.params.id)) return res.status(400).json({ error: 'You cannot delete yourself' })
    await deleteUser(cid(req), Number(req.params.id))
    res.status(204).end()
  })
}
