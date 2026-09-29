import { z } from 'zod'

const nullableMoney = z.number().finite().nonnegative().nullable().optional()

export const createBatchSchema = z.object({
  productId: z.string().uuid(),
  batchNumber: z.string().trim().min(1).max(100),
  manufacturingDate: z.coerce.date(),
  expiryDate: z.coerce.date(),
  quantityManufactured: z.number().int().positive().max(1000000000),
  manufacturingLocation: z.string().trim().min(2).max(180),
  storageLocation: z.string().trim().min(2).max(180).optional(),
  unitCost: nullableMoney,
  sellingPrice: nullableMoney,
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()).default('USD'),
}).strict().refine((value) => value.manufacturingDate <= value.expiryDate, {
  path: ['expiryDate'],
  message: 'Expiry date must be on or after the manufacturing date',
})

export const updateBatchSchema = z.object({
  manufacturingLocation: z.string().trim().min(2).max(180).optional(),
  storageLocation: z.string().trim().min(2).max(180).nullable().optional(),
  unitCost: nullableMoney,
  sellingPrice: nullableMoney,
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'At least one permitted batch field is required')
