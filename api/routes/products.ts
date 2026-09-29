import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { authenticate, requireOrganization, requireOrganizationPermission } from '../middleware/auth.js'
import { createProductSchema, updateProductSchema } from '../domain/product.js'
import { appendSupplyChainEvent } from '../services/append-event.js'

export const productsRouter = Router()
productsRouter.use(authenticate, requireOrganization)

type ProductWithIdentity = Prisma.ProductGetPayload<{ include: { identity: true } }>

function productResponse(product: ProductWithIdentity) {
  const attributes = product.attributes && typeof product.attributes === 'object'
    ? product.attributes as Record<string, unknown>
    : {}
  return {
    ...attributes,
    id: product.id,
    productCode: product.productCode,
    traceId: product.identity?.traceId ?? null,
    domain: product.domain,
    name: product.name,
    genericName: product.genericName,
    brandName: product.brandName,
    status: product.status,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
  }
}

productsRouter.get('/', requireOrganizationPermission('product:read'), async (request, response) => {
  const search = typeof request.query.search === 'string' ? request.query.search.trim() : ''
  const requestedPage = Number(request.query.page ?? 1)
  const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1
  const requestedStatus = typeof request.query.status === 'string' ? request.query.status : ''
  const status = ['ACTIVE', 'INACTIVE', 'UNDER_REVIEW'].includes(requestedStatus) ? requestedStatus as 'ACTIVE' | 'INACTIVE' | 'UNDER_REVIEW' : undefined
  const sortByName = request.query.sort === 'name'
  const where: Prisma.ProductWhereInput = {
    organizationId: request.auth!.organizationId,
    domain: 'PHARMACEUTICAL',
    ...(status ? { status } : {}),
    ...(search ? { OR: [
      { name: { contains: search, mode: 'insensitive' } },
      { genericName: { contains: search, mode: 'insensitive' } },
      { productCode: { contains: search, mode: 'insensitive' } },
      { identity: { traceId: { contains: search, mode: 'insensitive' } } },
    ] } : {}),
  }
  const [items, total] = await prisma.$transaction([
    prisma.product.findMany({ where, orderBy: sortByName ? { name: 'asc' } : { createdAt: 'desc' }, take: 50, skip: (page - 1) * 50, include: { identity: true } }),
    prisma.product.count({ where }),
  ])
  return response.json({ items: items.map(productResponse), total, page, pageSize: 50 })
})

productsRouter.get('/:id', requireOrganizationPermission('product:read'), async (request, response) => {
  const id = z.string().uuid().safeParse(request.params.id)
  if (!id.success) return response.status(400).json({ message: 'A valid product ID is required' })
  const product = await prisma.product.findFirst({
    where: { id: id.data, organizationId: request.auth!.organizationId, domain: 'PHARMACEUTICAL' },
    include: { identity: true },
  })
  if (!product) return response.status(404).json({ message: 'Product not found' })
  return response.json(productResponse(product))
})

productsRouter.post('/', requireOrganizationPermission('product:create'), async (request, response) => {
  const parsed = createProductSchema.safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ message: 'Only valid pharmaceutical products can be created', issues: parsed.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })) })

  const input = parsed.data
  const productCode = `PH-${randomUUID().slice(0, 8).toUpperCase()}`
  const traceId = `TT-${randomUUID().toUpperCase()}`
  const { genericName, brandName, status, domain: _domain, category: _category, productType: _productType, ...attributes } = input

  try {
    const product = await prisma.$transaction(async (tx) => {
      const category = await tx.productCategory.upsert({
        where: { name_domain: { name: input.pharmaceuticalCategory, domain: 'PHARMACEUTICAL' } },
        update: {},
        create: { name: input.pharmaceuticalCategory, domain: 'PHARMACEUTICAL' },
      })
      const created = await tx.product.create({
        data: {
          productCode,
          domain: 'PHARMACEUTICAL',
          categoryId: category.id,
          organizationId: request.auth!.organizationId,
          name: brandName,
          brandName,
          genericName,
          status,
          attributes: attributes as Prisma.InputJsonObject,
          identity: { create: { traceId } },
        },
        include: { identity: true },
      })
      await appendSupplyChainEvent(tx, {
        productId: created.id,
        actorId: request.auth!.userId,
        organizationId: request.auth!.organizationId,
        eventType: 'PRODUCT_CREATED',
        metadata: { traceId, productCode, domain: 'PHARMACEUTICAL' },
      })
      await tx.auditLog.create({
        data: {
          actorId: request.auth!.userId,
          organizationId: request.auth!.organizationId,
          action: 'PRODUCT_CREATED',
          resourceType: 'Product',
          resourceId: created.id,
          metadata: { traceId, productCode },
        },
      })
      return created
    })
    return response.status(201).json(productResponse(product))
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return response.status(409).json({ message: 'A product with this identity already exists' })
    throw error
  }
})

productsRouter.patch('/:id', requireOrganizationPermission('product:update'), async (request, response) => {
  const id = z.string().uuid().safeParse(request.params.id)
  const parsed = updateProductSchema.safeParse(request.body)
  if (!id.success) return response.status(400).json({ message: 'A valid product ID is required' })
  if (!parsed.success) return response.status(400).json({ message: 'Invalid pharmaceutical product details', issues: parsed.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })) })

  try {
    const product = await prisma.$transaction(async (tx) => {
      const existing = await tx.product.findFirst({
        where: { id: id.data, organizationId: request.auth!.organizationId, domain: 'PHARMACEUTICAL' },
      })
      if (!existing) return null

      const { genericName, brandName, status, ...attributeUpdates } = parsed.data
      const previousAttributes = existing.attributes && typeof existing.attributes === 'object'
        ? existing.attributes as Record<string, unknown>
        : {}
      const categoryId = parsed.data.pharmaceuticalCategory
        ? (await tx.productCategory.upsert({
          where: { name_domain: { name: parsed.data.pharmaceuticalCategory, domain: 'PHARMACEUTICAL' } },
          update: {},
          create: { name: parsed.data.pharmaceuticalCategory, domain: 'PHARMACEUTICAL' },
        })).id
        : existing.categoryId
      const updated = await tx.product.update({
        where: { id: existing.id },
        data: {
          name: brandName ?? existing.name,
          brandName: brandName ?? existing.brandName,
          genericName: genericName ?? existing.genericName,
          status: status ?? existing.status,
          categoryId,
          attributes: { ...previousAttributes, ...attributeUpdates } as Prisma.InputJsonObject,
        },
        include: { identity: true },
      })
      await tx.auditLog.create({
        data: {
          actorId: request.auth!.userId,
          organizationId: request.auth!.organizationId,
          action: 'PRODUCT_UPDATED',
          resourceType: 'Product',
          resourceId: updated.id,
          metadata: { changedFields: Object.keys(parsed.data) },
        },
      })
      return updated
    })
    if (!product) return response.status(404).json({ message: 'Product not found' })
    return response.json(productResponse(product))
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return response.status(409).json({ message: 'A product with this identity already exists' })
    }
    throw error
  }
})
