import { z } from 'zod'

export const pharmaceuticalCategories = ['PRESCRIPTION', 'OTC', 'VACCINE', 'BIOLOGIC', 'MEDICAL_GAS'] as const

const blockedCategories = new Set([
  'food', 'clothing', 'electronics', 'furniture', 'automotive', 'luxury goods',
  'general retail', 'cosmetics', 'grocery', 'perishables', 'automotive parts',
])

const productFieldsSchema = z.object({
  genericName: z.string().trim().min(2).max(180),
  brandName: z.string().trim().min(2).max(180),
  dosageForm: z.string().trim().min(1).max(80),
  strength: z.string().trim().min(1).max(80),
  activeIngredients: z.string().trim().min(2).max(500),
  pharmaceuticalCategory: z.enum(pharmaceuticalCategories),
  prescriptionRequired: z.boolean(),
  manufacturer: z.string().trim().min(2).max(180),
  manufacturerLicenseNumber: z.string().trim().min(2).max(120),
  regulatoryApprovalNumber: z.string().trim().min(2).max(120),
  storageConditions: z.string().trim().min(2).max(300),
  temperatureRange: z.string().trim().min(2).max(80),
  humidityRequirement: z.string().trim().min(2).max(120),
  shelfLifeMonths: z.number().int().positive().max(1200),
  unit: z.string().trim().min(1).max(40),
  packSize: z.number().int().positive().max(1000000),
  packageType: z.string().trim().min(1).max(80),
  countryOfManufacture: z.string().trim().min(2).max(100),
  description: z.string().trim().max(1000),
  status: z.enum(['ACTIVE', 'INACTIVE', 'UNDER_REVIEW']).default('ACTIVE'),
})

export const createProductSchema = productFieldsSchema.extend({
  domain: z.string().optional(),
  category: z.string().optional(),
  productType: z.string().optional(),
}).strict().superRefine((value, context) => {
  for (const [field, candidate] of Object.entries({ domain: value.domain, category: value.category, productType: value.productType })) {
    if (!candidate) continue
    const normalized = candidate.trim().toLowerCase()
    if (field === 'domain' && normalized !== 'pharmaceutical' && normalized !== 'pharmaceuticals') {
      context.addIssue({ code: 'custom', path: [field], message: 'Only pharmaceutical products can be created in this workspace.' })
    }
    if ((field === 'category' || field === 'productType') && blockedCategories.has(normalized)) {
      context.addIssue({ code: 'custom', path: [field], message: 'This product category is not supported.' })
    }
  }
})

export const updateProductSchema = productFieldsSchema.partial().strict().refine((value) => Object.keys(value).length > 0, 'At least one product field is required')

export type CreateProductInput = z.infer<typeof createProductSchema>
export type UpdateProductInput = z.infer<typeof updateProductSchema>
