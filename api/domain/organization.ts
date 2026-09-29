import { z } from 'zod'

export const organizationIdSchema = z.string().uuid()
export const createOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(160),
}).strict()
export const updateOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(160),
}).strict()
export const createMemberSchema = z.object({
  email: z.string().trim().email().max(200).transform((email) => email.toLowerCase()),
  roleName: z.enum(['ADMIN', 'MEMBER']).default('MEMBER'),
}).strict()
export const updateMemberRoleSchema = z.object({
  roleName: z.enum(['ADMIN', 'MEMBER']),
}).strict()
