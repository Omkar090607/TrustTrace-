import type { Prisma } from '@prisma/client'

export async function notifyOrganizationMembers(
  client: Prisma.TransactionClient,
  organizationId: string,
  title: string,
  body: string,
) {
  const members = await client.organizationMember.findMany({ where: { organizationId }, select: { userId: true } })
  if (!members.length) return
  await client.notification.createMany({ data: members.map((member: { userId: string }) => ({ userId: member.userId, organizationId, title, body })) })
}