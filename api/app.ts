import 'dotenv/config'
import express from 'express'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import helmet from 'helmet'
import { rateLimit } from 'express-rate-limit'
import { authRouter } from './routes/auth.js'
import { dashboardRouter } from './routes/dashboard.js'
import { productsRouter } from './routes/products.js'
import { publicRouter } from './routes/public.js'
import { organizationsRouter } from './routes/organizations.js'
import { batchesRouter } from './routes/batches.js'
import { inventoryRouter } from './routes/inventory.js'
import { shipmentsRouter } from './routes/shipments.js'
import { traceabilityRouter } from './routes/traceability.js'
import { phase4Router } from './routes/phase4.js'
import { blockchainRouter } from './routes/blockchain.js'
import { prisma } from './lib/prisma.js'

export const app = express()
app.disable('x-powered-by')
app.use(helmet())
app.use(cors({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173', credentials: true }))
app.use(express.json({ limit: '1mb' }))
app.use(cookieParser())
app.use('/api', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }))
app.use('/api/auth', rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false }))

app.get('/api/health', async (_request, response) => {
  await prisma.$queryRaw`SELECT 1`
  return response.json({ status: 'ok', database: 'connected' })
})
app.use('/api/auth', authRouter)
app.use('/api/organizations', organizationsRouter)
app.use('/api/dashboard', dashboardRouter)
app.use('/api/products', productsRouter)
app.use('/api/batches', batchesRouter)
app.use('/api/inventory', inventoryRouter)
app.use('/api/shipments', shipmentsRouter)
app.use('/api/traceability', traceabilityRouter)
app.use('/api/public', publicRouter)
app.use('/api/blockchain', blockchainRouter)
app.use('/api', phase4Router)
app.use((_request, response) => response.status(404).json({ message: 'Resource not found' }))
app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  console.error(error)
  return response.status(500).json({ message: 'An unexpected server error occurred' })
})
