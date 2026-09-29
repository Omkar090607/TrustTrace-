import { Router } from 'express'
import { z } from 'zod'
import bcrypt from 'bcryptjs'
import { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { authenticate } from '../middleware/auth.js'
import { createAccessToken, createRefreshToken, digestRefreshToken } from '../lib/tokens.js'

export const authRouter = Router()
const registerSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(200).transform((email) => email.toLowerCase()),
  password: z.string().min(12).max(128)
    .regex(/[a-z]/, 'Password must contain a lowercase letter')
    .regex(/[A-Z]/, 'Password must contain an uppercase letter')
    .regex(/[0-9]/, 'Password must contain a number')
    .regex(/[^A-Za-z0-9]/, 'Password must contain a symbol')
    .refine((password) => Buffer.byteLength(password, 'utf8') <= 72, 'Password must be at most 72 UTF-8 bytes'),
}).strict()
const loginSchema = z.object({
  email: z.string().trim().email().max(200).transform((email) => email.toLowerCase()),
  password: z.string().min(1).max(128),
}).strict()
const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict' as const,
  path: '/api/auth',
}

function setRefreshCookie(response: import('express').Response, token: string) {
  response.cookie('tt_refresh', token, { ...cookieOptions, maxAge: 30 * 24 * 60 * 60 * 1000 })
}

function badInput(error: z.ZodError) {
  return error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message }))
}

authRouter.post('/register', async (request, response) => {
  const parsed = registerSchema.safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ message: 'Check the highlighted registration details', issues: badInput(parsed.error) })
  if (await prisma.user.findUnique({ where: { email: parsed.data.email } })) return response.status(409).json({ message: 'An account with this email already exists' })

  const passwordHash = await bcrypt.hash(parsed.data.password, 12)
  let user
  try {
    user = await prisma.user.create({ data: { email: parsed.data.email, fullName: parsed.data.fullName, passwordHash } })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return response.status(409).json({ message: 'An account with this email already exists' })
    }
    throw error
  }
  const accessToken = createAccessToken(user.id)
  const refreshToken = await createRefreshToken(user.id)
  setRefreshCookie(response, refreshToken)
  return response.status(201).json({ accessToken, user: { id: user.id, fullName: user.fullName, email: user.email } })
})

authRouter.post('/login', async (request, response) => {
  const parsed = loginSchema.safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ message: 'Enter a valid email and password' })
  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } })
  if (!user || !user.isActive || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) return response.status(401).json({ message: 'Email or password is incorrect' })
  const accessToken = createAccessToken(user.id)
  const refreshToken = await createRefreshToken(user.id)
  setRefreshCookie(response, refreshToken)
  return response.json({ accessToken, user: { id: user.id, fullName: user.fullName, email: user.email } })
})

authRouter.post('/refresh', async (request, response) => {
  const token = request.cookies?.tt_refresh as string | undefined
  if (!token) return response.status(401).json({ message: 'Refresh token is missing' })
  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash: digestRefreshToken(token) }, include: { user: true } })
  if (!stored || stored.revokedAt || stored.expiresAt <= new Date() || !stored.user.isActive) {
    response.clearCookie('tt_refresh', cookieOptions)
    return response.status(401).json({ message: 'Refresh token is invalid or expired' })
  }
  const accessToken = createAccessToken(stored.userId)
  const refreshToken = await prisma.$transaction(async (tx) => {
    const revoked = await tx.refreshToken.updateMany({
      where: { id: stored.id, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { revokedAt: new Date() },
    })
    if (revoked.count !== 1) return null
    return createRefreshToken(stored.userId, tx)
  })
  if (!refreshToken) {
    response.clearCookie('tt_refresh', cookieOptions)
    return response.status(401).json({ message: 'Refresh token is invalid or expired' })
  }
  setRefreshCookie(response, refreshToken)
  return response.json({
    accessToken,
    user: { id: stored.user.id, fullName: stored.user.fullName, email: stored.user.email },
  })
})

authRouter.get('/me', authenticate, async (request, response) => {
  const user = await prisma.user.findUnique({ where: { id: request.auth!.userId }, select: { id: true, fullName: true, email: true, isActive: true } })
  if (!user || !user.isActive) return response.status(401).json({ message: 'Account is unavailable' })
  return response.json({ id: user.id, fullName: user.fullName, email: user.email })
})

authRouter.post('/logout', async (request, response) => {
  const token = request.cookies?.tt_refresh as string | undefined
  if (token) await prisma.refreshToken.updateMany({ where: { tokenHash: digestRefreshToken(token), revokedAt: null }, data: { revokedAt: new Date() } })
  response.clearCookie('tt_refresh', cookieOptions)
  response.clearCookie('tt_access', cookieOptions)
  return response.status(204).end()
})
