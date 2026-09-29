import { createHash, randomBytes } from 'node:crypto'
import type { Prisma, PrismaClient } from '@prisma/client'
import jwt from 'jsonwebtoken'
import { prisma } from './prisma.js'

export const accessTokenIssuer = 'trusttrace-api'
export const accessTokenAudience = 'trusttrace-api'
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

export function createAccessToken(userId: string) {
  const secret = process.env.JWT_ACCESS_SECRET
  if (!secret) throw new Error('JWT_ACCESS_SECRET is required')
  return jwt.sign({ tokenType: 'access' }, secret, {
    algorithm: 'HS256',
    subject: userId,
    expiresIn: '15m',
    issuer: accessTokenIssuer,
    audience: accessTokenAudience,
  })
}

export async function createRefreshToken(userId: string, client: PrismaClient | Prisma.TransactionClient = prisma) {
  const token = randomBytes(48).toString('base64url')
  await client.refreshToken.create({
    data: { userId, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
  })
  return token
}

export function digestRefreshToken(token: string) {
  return hashToken(token)
}
