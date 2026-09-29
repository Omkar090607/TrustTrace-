import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createProductSchema } from './product.js'

const validProduct = {
  genericName: 'Acetaminophen',
  brandName: 'Northstar 500',
  dosageForm: 'Tablet',
  strength: '500 mg',
  activeIngredients: 'Acetaminophen',
  pharmaceuticalCategory: 'OTC',
  prescriptionRequired: false,
  manufacturer: 'Northstar Therapeutics',
  manufacturerLicenseNumber: 'MFG-1001',
  regulatoryApprovalNumber: 'REG-8891',
  storageConditions: 'Store in a dry place',
  temperatureRange: '15-25 C',
  humidityRequirement: 'Below 60 percent',
  shelfLifeMonths: 36,
  unit: 'tablet',
  packSize: 20,
  packageType: 'Blister pack',
  countryOfManufacture: 'Canada',
  description: '',
  status: 'ACTIVE',
}

describe('pharmaceutical product policy', () => {
  it('accepts valid pharmaceutical attributes', () => {
    assert.equal(createProductSchema.safeParse(validProduct).success, true)
  })

  it('rejects non-pharmaceutical domains', () => {
    assert.equal(createProductSchema.safeParse({ ...validProduct, domain: 'electronics' }).success, false)
  })

  it('rejects blocked product categories', () => {
    assert.equal(createProductSchema.safeParse({ ...validProduct, category: 'Food' }).success, false)
  })

  it('rejects extra unvalidated fields', () => {
    assert.equal(createProductSchema.safeParse({ ...validProduct, unrelated: true }).success, false)
  })
})
