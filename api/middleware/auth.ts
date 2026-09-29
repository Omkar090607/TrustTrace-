import type { NextFunction, Request, Response } from 'express'
import jwt, { type JwtPayload } from 'jsonwebtoken'
import { z } from 'zod'
import { accessTokenAudience, accessTokenIssuer } from '../lib/tokens.js'
import { prisma } from '../lib/prisma.js'

const accessSecret = () => process.env.JWT_ACCESS_SECRET

type AccessPayload = JwtPayload & { sub: string; tokenType: 'access' }
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function authenticate(request: Request, response: Response, next: NextFunction) {
  const authorization = request.get('authorization')
  const bearerToken = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1]
  const token = bearerToken ?? request.cookies?.tt_access
  if (!token || !accessSecret()) return response.status(401).json({ message: 'Authentication required' })

  try {
    const payload = jwt.verify(token, accessSecret()!, {
      algorithms: ['HS256'],
      issuer: accessTokenIssuer,
      audience: accessTokenAudience,
    }) as AccessPayload
    if (payload.tokenType !== 'access' || typeof payload.sub !== 'string' || !uuidPattern.test(payload.sub)) {
      return response.status(401).json({ message: 'Invalid access token' })
    }
    request.auth = { userId: payload.sub, organizationId: '' }
    return next()
  } catch {
    return response.status(401).json({ message: 'Your session has expired' })
  }
}

export async function requireOrganization(request: Request, response: Response, next: NextFunction) {
  if (!request.auth) return response.status(401).json({ message: 'Authentication required' })
  const requestedOrganizationId = request.get('x-organization-id')
  const parsedOrganizationId = requestedOrganizationId ? z.string().uuid().safeParse(requestedOrganizationId) : null
  if (parsedOrganizationId && !parsedOrganizationId.success) {
    return response.status(400).json({ message: 'A valid organization context is required' })
  }
  const membership = await prisma.organizationMember.findFirst({
    where: {
      userId: request.auth.userId,
      ...(parsedOrganizationId?.success ? { organizationId: parsedOrganizationId.data } : {}),
    },
    orderBy: parsedOrganizationId ? undefined : { joinedAt: 'asc' },
    select: { organizationId: true, roleName: true },
  })
  if (!membership) return response.status(403).json({ message: 'Organization access is forbidden' })
  request.auth.organizationId = membership.organizationId
  request.auth.organizationRole = membership.roleName
  return next()
}

export function requireOrganizationContext(parameterName = 'organizationId') {
  return async (request: Request, response: Response, next: NextFunction) => {
    if (!request.auth) return response.status(401).json({ message: 'Authentication required' })
    const organizationId = z.string().uuid().safeParse(request.params[parameterName])
    if (!organizationId.success) return response.status(400).json({ message: 'A valid organization ID is required' })

    const membership = await prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: organizationId.data, userId: request.auth.userId } },
      select: { roleName: true },
    })
    if (!membership) return response.status(403).json({ message: 'Organization access is forbidden' })
    request.auth.organizationId = organizationId.data
    request.auth.organizationRole = membership.roleName
    return next()
  }
}

export function requireOrganizationPermission(permissionKey: string) {
  return async (request: Request, response: Response, next: NextFunction) => {
    if (!request.auth) return response.status(401).json({ message: 'Authentication required' })
    if (!request.auth.organizationId || !request.auth.organizationRole) {
      return response.status(403).json({ message: 'Organization access is forbidden' })
    }
    const permission = await prisma.rolePermission.findFirst({
      where: {
        role: { name: request.auth.organizationRole },
        permission: { key: permissionKey },
      },
      select: { roleId: true },
    })
    if (!permission) return response.status(403).json({ message: 'You do not have permission to perform this action' })
    return next()
  }
}

export function requirePermission(permissionKey: string) {
  return async (request: Request, response: Response, next: NextFunction) => {
    if (!request.auth) return response.status(401).json({ message: 'Authentication required' })
    const user = await prisma.user.findUnique({
      where: { id: request.auth.userId },
      include: { role: { include: { permissions: { include: { permission: true } } } } },
    })
    const allowed = user?.role?.permissions.some((entry) => entry.permission.key === permissionKey)
    if (!allowed) return response.status(403).json({ message: 'You do not have permission to perform this action' })
    return next()
  }
}
