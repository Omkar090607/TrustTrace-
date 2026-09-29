import { Router } from 'express'
import { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { authenticate, requireOrganizationContext, requireOrganizationPermission } from '../middleware/auth.js'
import { createMemberSchema, createOrganizationSchema, organizationIdSchema, updateMemberRoleSchema, updateOrganizationSchema } from '../domain/organization.js'
import { ensureOrganizationRbac } from '../services/organization-rbac.js'

export const organizationsRouter = Router()
organizationsRouter.use(authenticate)

const organizationContext = requireOrganizationContext()
const organizationRead = [organizationContext, requireOrganizationPermission('organization:read')]
const organizationManage = [organizationContext, requireOrganizationPermission('organization:manage')]
const memberRead = [organizationContext, requireOrganizationPermission('member:read')]
const memberManage = [organizationContext, requireOrganizationPermission('member:manage')]

function actorRole(request: import('express').Request) {
  return request.auth?.organizationRole
}

organizationsRouter.post('/', async (request, response) => {
  const parsed = createOrganizationSchema.safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ message: 'Invalid organization details' })

  const organization = await prisma.$transaction(async (tx) => {
    await ensureOrganizationRbac(tx)
    const created = await tx.organization.create({ data: { name: parsed.data.name } })
    await tx.organizationMember.create({
      data: { organizationId: created.id, userId: request.auth!.userId, roleName: 'OWNER' },
    })
    return created
  })
  return response.status(201).json({ id: organization.id, name: organization.name, createdAt: organization.createdAt, roleName: 'OWNER' })
})

organizationsRouter.get('/', async (request, response) => {
  const memberships = await prisma.organizationMember.findMany({
    where: { userId: request.auth!.userId },
    orderBy: { joinedAt: 'asc' },
    include: { organization: { select: { id: true, name: true, createdAt: true } } },
  })
  return response.json({ items: memberships.map(({ organization, roleName, joinedAt }) => ({ ...organization, roleName, joinedAt })) })
})

organizationsRouter.get('/:organizationId', ...organizationRead, async (request, response) => {
  const organization = await prisma.organization.findUnique({
    where: { id: request.auth!.organizationId },
    select: { id: true, name: true, createdAt: true },
  })
  if (!organization) return response.status(404).json({ message: 'Organization not found' })
  return response.json(organization)
})

organizationsRouter.patch('/:organizationId', ...organizationManage, async (request, response) => {
  const parsed = updateOrganizationSchema.safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ message: 'Invalid organization details' })
  const organization = await prisma.organization.update({
    where: { id: request.auth!.organizationId },
    data: { name: parsed.data.name },
    select: { id: true, name: true, createdAt: true },
  })
  return response.json(organization)
})

organizationsRouter.get('/:organizationId/members', ...memberRead, async (request, response) => {
  const memberships = await prisma.organizationMember.findMany({
    where: { organizationId: request.auth!.organizationId },
    orderBy: { joinedAt: 'asc' },
    include: { user: { select: { id: true, email: true, fullName: true, isActive: true } } },
  })
  return response.json({ items: memberships.map(({ user, roleName, joinedAt }) => ({ ...user, roleName, joinedAt })) })
})

organizationsRouter.post('/:organizationId/members', ...memberManage, async (request, response) => {
  const parsed = createMemberSchema.safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ message: 'Invalid organization member details' })
  if (parsed.data.roleName === 'ADMIN' && actorRole(request) !== 'OWNER') {
    return response.status(403).json({ message: 'Only an organization owner can assign the admin role' })
  }
  const user = await prisma.user.findUnique({
    where: { email: parsed.data.email },
    select: { id: true, email: true, fullName: true, isActive: true },
  })
  if (!user || !user.isActive) return response.status(404).json({ message: 'An active existing user is required' })
  try {
    const membership = await prisma.organizationMember.create({
      data: { organizationId: request.auth!.organizationId, userId: user.id, roleName: parsed.data.roleName },
      select: { roleName: true, joinedAt: true },
    })
    return response.status(201).json({ ...user, ...membership })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return response.status(409).json({ message: 'User is already a member of this organization' })
    }
    throw error
  }
})

organizationsRouter.patch('/:organizationId/members/:userId', ...memberManage, async (request, response) => {
  const userId = organizationIdSchema.safeParse(request.params.userId)
  const parsed = updateMemberRoleSchema.safeParse(request.body)
  if (!userId.success || !parsed.success) return response.status(400).json({ message: 'Invalid organization member details' })

  const membership = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId: request.auth!.organizationId, userId: userId.data } },
    select: { roleName: true },
  })
  if (!membership) return response.status(404).json({ message: 'Organization member not found' })
  if (membership.roleName === 'OWNER') return response.status(403).json({ message: 'Organization ownership cannot be changed through this operation' })
  if ((membership.roleName === 'ADMIN' || parsed.data.roleName === 'ADMIN') && actorRole(request) !== 'OWNER') {
    return response.status(403).json({ message: 'Only an organization owner can change admin assignments' })
  }
  const updated = await prisma.organizationMember.update({
    where: { organizationId_userId: { organizationId: request.auth!.organizationId, userId: userId.data } },
    data: { roleName: parsed.data.roleName },
    include: { user: { select: { id: true, email: true, fullName: true, isActive: true } } },
  })
  return response.json({ ...updated.user, roleName: updated.roleName, joinedAt: updated.joinedAt })
})

organizationsRouter.delete('/:organizationId/members/:userId', ...memberManage, async (request, response) => {
  const userId = organizationIdSchema.safeParse(request.params.userId)
  if (!userId.success) return response.status(400).json({ message: 'A valid user ID is required' })
  const membership = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId: request.auth!.organizationId, userId: userId.data } },
    select: { roleName: true },
  })
  if (!membership) return response.status(404).json({ message: 'Organization member not found' })
  if (membership.roleName === 'OWNER') return response.status(403).json({ message: 'The organization owner cannot be removed' })
  if (membership.roleName === 'ADMIN' && actorRole(request) !== 'OWNER') {
    return response.status(403).json({ message: 'Only an organization owner can remove an admin' })
  }
  await prisma.organizationMember.delete({
    where: { organizationId_userId: { organizationId: request.auth!.organizationId, userId: userId.data } },
  })
  return response.status(204).end()
})
