import type { Prisma, PrismaClient } from '@prisma/client'

export const organizationRoles = ['OWNER', 'ADMIN', 'MEMBER'] as const
export type OrganizationRoleName = typeof organizationRoles[number]

export const organizationPermissions = {
  'organization:read': 'Read organization details',
  'organization:manage': 'Update organization details',
  'member:read': 'Read organization members',
  'member:manage': 'Add, update, and remove organization members',
  'product:read': 'Read organization products',
  'product:create': 'Create organization products',
  'product:update': 'Update organization products',
  'batch:read': 'Read organization batches',
  'batch:create': 'Create organization batches',
  'batch:update': 'Update organization batches',
  'inventory:read': 'Read organization inventory',
  'inventory:manage': 'Manage organization inventory',
  'quality:read': 'Read organization quality checks',
  'quality:manage': 'Record organization quality checks',
  'shipment:read': 'Read organization shipments',
  'shipment:create': 'Create organization shipments',
  'shipment:update': 'Update organization shipments',
  'traceability:read': 'Read organization traceability history',
  'return:read': 'Read organization returns',
  'return:create': 'Request organization returns',
  'return:update': 'Inspect and restock organization returns',
  'document:read': 'Read organization documents and certificates',
  'document:create': 'Register organization documents and certificates',
  'invoice:read': 'Read organization invoices and payments',
  'invoice:create': 'Create organization invoices',
  'invoice:update': 'Issue invoices and record payments or refunds',
  'notification:read': 'Read organization notifications',
  'notification:update': 'Update organization notifications',
  'report:read': 'Read organization operational reports',
  'audit:read': 'Read organization audit logs',
  'blockchain:read': 'Read organization blockchain anchor status',
  'blockchain:retry': 'Retry organization blockchain anchors',
} as const

const rolePermissions: Record<OrganizationRoleName, Array<keyof typeof organizationPermissions>> = {
  OWNER: Object.keys(organizationPermissions) as Array<keyof typeof organizationPermissions>,
  ADMIN: Object.keys(organizationPermissions) as Array<keyof typeof organizationPermissions>,
  MEMBER: ['organization:read', 'member:read', 'product:read', 'batch:read', 'inventory:read', 'quality:read', 'shipment:read', 'traceability:read', 'return:read', 'return:create', 'document:read', 'invoice:read', 'notification:read', 'notification:update', 'report:read', 'blockchain:read'],
}

type PrismaClientOrTransaction = PrismaClient | Prisma.TransactionClient

export async function ensureOrganizationRbac(client: PrismaClientOrTransaction) {
  const permissions = new Map<string, string>()
  for (const [key, description] of Object.entries(organizationPermissions)) {
    const permission = await client.permission.upsert({ where: { key }, update: {}, create: { key, description } })
    permissions.set(key, permission.id)
  }

  const roles = new Map<OrganizationRoleName, string>()
  for (const name of organizationRoles) {
    const role = await client.role.upsert({ where: { name }, update: {}, create: { name, description: `Organization ${name.toLowerCase()} role` } })
    roles.set(name, role.id)
    for (const permissionKey of rolePermissions[name]) {
      const permissionId = permissions.get(permissionKey)!
      await client.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId } },
        update: {},
        create: { roleId: role.id, permissionId },
      })
    }
  }
  return roles
}
