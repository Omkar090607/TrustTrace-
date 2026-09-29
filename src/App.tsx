import QRCode from 'qrcode'
import { createContext, lazy, Suspense, useContext, useEffect, useRef, useState } from 'react'
import type { BrowserMultiFormatReader, IScannerControls } from '@zxing/browser'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom'
import { z } from 'zod'
import {
  Activity, AlertTriangle, ArrowDownRight, ArrowRight, BadgeCheck,
  Bell, Boxes, Building2, ChevronDown, CircleHelp, ClipboardCheck, ClipboardList,
  Clock3, FileCheck2, FileText, FlaskConical, LayoutDashboard, LockKeyhole,
  LogOut, Menu, Package, Pencil, Plus, QrCode, RotateCw, Search, Settings2, ShieldCheck, ShieldQuestion,
  Truck, X,
} from 'lucide-react'
import './App.css'

const ActivityChart = lazy(() => import('./components/ActivityChart'))

type DashboardSummary = {
  products: number
  batches: number
  activeBatches: number
  inventory: number
  shipments: number
  returns: number
  payments: number
}

type Product = {
  id: string
  productCode: string
  traceId: string | null
  domain: string
  name: string
  genericName: string
  brandName: string
  strength: string
  dosageForm: string
  activeIngredients: string
  pharmaceuticalCategory: string
  prescriptionRequired: boolean
  manufacturer: string
  manufacturerLicenseNumber: string
  regulatoryApprovalNumber: string
  storageConditions: string
  temperatureRange: string
  humidityRequirement: string
  shelfLifeMonths: number
  unit: string
  packSize: number
  packageType: string
  countryOfManufacture: string
  description: string
  status: string
  createdAt: string
  updatedAt: string
}

type BatchRecord = {
  id: string
  batchNumber: string
  productId: string
  manufacturingDate: string
  expiryDate: string
  quantityManufactured: number
  available: number
  reserved: number
  dispatched: number
  delivered: number
  unitCost: string | number | null
  sellingPrice: string | number | null
  currency: string
  manufacturingLocation: string
  storageLocation: string | null
  qualityStatus: string
  status: string
  product: { id: string; name: string; genericName: string | null; brandName: string | null; traceId: string | null }
  qualityChecks?: Array<{ id: string; result: string; details: { notes?: string }; checkedAt: string | null; createdAt: string }>
}

type InventoryRow = { id: string; batchId: string; batchNumber: string; productName: string; traceId: string | null; locationId: string; locationName: string; onHand: number; reserved: number; available: number; updatedAt: string }
type ShipmentRow = { id: string; trackingNumber: string; status: string; destination: string; dispatchedAt: string | null; deliveredAt: string | null; createdAt: string; items: Array<{ batchId: string; batchNumber: string; productName: string; quantity: number }>; statusHistory: Array<{ id: string; status: string; note: string | null; occurredAt: string }> }
type AnchorInfo = { id: string; eventHash: string; status: string; transactionHash: string | null; blockNumber: string | null; contractAddress: string | null; chainId: string | null; networkName: string | null; failureCode: string | null; attemptCount: number; anchoredAt: string | null }
type TimelineData = { databaseChainVerified: boolean; product?: { id: string; name: string; traceId: string | null }; batch?: { id: string; batchNumber: string; productName: string }; events: Array<{ eventId: string; eventType: string; timestamp: string; organizationName: string; actorName: string | null; locationName: string | null; quantity: number | null; previousHash: string | null; currentHash: string; blockchainStatus: string; blockchainTransactionHash: string | null; anchor?: AnchorInfo | null }> }
type PublicBlockchainVerification = { status: string; anchorCount: number; totalEventCount: number; proofs: Array<{ eventId: string; eventHash: string; status: string; transactionHash: string | null; blockNumber: string | null; timestamp: string | null; contractAddress: string | null; chainId: string | null; networkName: string | null }> }
type ReturnRecord = { id: string; returnNumber: string; status: string; reason: string; createdAt: string; shipment: { id: string; trackingNumber: string; status: string } | null; items: Array<{ id: string; batchId: string; quantity: number; batch: { id: string; batchNumber: string; product: { id: string; name: string } }; inspections: Array<{ outcome: string; notes: string | null }> }> }
type InvoiceRecord = { id: string; invoiceNumber: string; status: string; currency: string; subtotal: string; total: string; createdAt: string; items: Array<{ id: string; description: string; quantity: number; unitPrice: string }>; payments: Array<{ id: string; amount: string; currency: string; status: string; method: string | null; providerRef: string | null; refunds: Array<{ id: string; amount: string; reason: string }> }>; _count?: { items: number; payments: number } }
type DocumentRecord = { id: string; name: string; contentType: string; sizeBytes: number; checksum: string; uploadedAt: string; downloadAvailable: boolean; product?: { id: string; name: string } | null; batch?: { id: string; batchNumber: string } | null; shipment?: { id: string; trackingNumber: string } | null; returnRecord?: { id: string; returnNumber: string } | null }
type CertificateRecord = { id: string; certificateNumber: string; type: string; issuer: string; issuedAt: string | null; expiresAt: string | null; verifiedAt: string | null; status: string; isPublic: boolean; product: { id: string; name: string } | null; batch: { id: string; batchNumber: string } | null }
type NotificationRecord = { id: string; title: string; body: string; readAt: string | null; createdAt: string }

type RecentEvent = { id: string; eventType: string; productName: string; traceId: string; currentHash: string; blockchainStatus: string; createdAt: string }
type IntegritySummary = { eventCount: number; databaseChainVerified: boolean; anchors: Record<string, number>; certificateCount: number; verifiedCertificates: number }
type AttentionSummary = { expiredBatches: number; expiringBatches: number; recalledBatches: number; pendingQualityChecks: number; activeRecalls: number; expiringCertificates: number }
type WorkspaceTraceEvent = TimelineData['events'][number] & { productId: string | null; productName: string | null; traceId: string | null; batchId: string | null; batchNumber: string | null }

type SessionUser = { id: string; fullName: string; email: string }
type Organization = { id: string; name: string; roleName: string; joinedAt: string; createdAt: string }
type OrganizationContextValue = {
  organizations: Organization[]
  currentOrganization: Organization | null
  selectOrganization: (organizationId: string) => void
  isLoading: boolean
}

const OrganizationContext = createContext<OrganizationContextValue | null>(null)
let onSessionExpired: (() => void) | undefined

export function useOrganizationContext() {
  const context = useContext(OrganizationContext)
  if (!context) throw new Error('Organization context is only available inside the authenticated workspace')
  return context
}

let accessToken = ''
let activeOrganizationHeader: string | undefined

function setAccessToken(token: string) {
  accessToken = token
}

const productSchema = z.object({
  genericName: z.string().trim().min(2, 'Enter a generic name'),
  brandName: z.string().trim().min(2, 'Enter a brand name'),
  dosageForm: z.string().trim().min(1, 'Choose a dosage form'),
  strength: z.string().trim().min(1, 'Enter product strength'),
  activeIngredients: z.string().trim().min(2, 'Enter at least one active ingredient'),
  pharmaceuticalCategory: z.enum(['PRESCRIPTION', 'OTC', 'VACCINE', 'BIOLOGIC', 'MEDICAL_GAS']),
  prescriptionRequired: z.boolean(),
  manufacturer: z.string().trim().min(2, 'Enter a manufacturer'),
  manufacturerLicenseNumber: z.string().trim().min(2, 'Enter a license number'),
  regulatoryApprovalNumber: z.string().trim().min(2, 'Enter an approval number'),
  storageConditions: z.string().trim().min(2, 'Enter storage conditions'),
  temperatureRange: z.string().trim().min(2, 'Enter a temperature range'),
  humidityRequirement: z.string().trim().min(2, 'Enter a humidity requirement'),
  shelfLifeMonths: z.coerce.number().int().positive('Shelf life must be positive'),
  unit: z.string().trim().min(1, 'Enter a unit'),
  packSize: z.coerce.number().int().positive('Pack size must be positive'),
  packageType: z.string().trim().min(1, 'Choose a package type'),
  countryOfManufacture: z.string().trim().min(2, 'Enter country of manufacture'),
  description: z.string().trim().max(1000),
  status: z.enum(['ACTIVE', 'INACTIVE', 'UNDER_REVIEW']),
})

type ProductForm = z.infer<typeof productSchema>

const navigation = [
  { label: 'Dashboard', to: '/', icon: LayoutDashboard },
  { label: 'Supply Chain', to: '/products', icon: Package },
  { label: 'Logistics', to: '/shipments', icon: Truck },
  { label: 'Documents & Compliance', to: '/documents', icon: FileCheck2 },
  { label: 'Finance', to: '/invoices', icon: FileText },
  { label: 'Traceability', to: '/traceability', icon: Activity },
  { label: 'Reports', to: '/reports', icon: FileText },
  { label: 'Administration', to: '/settings', icon: Settings2 },
]

function isWorkspaceNavigationActive(to: string, pathname: string) {
  const groupedPaths: Record<string, string[]> = {
    '/products': ['/products', '/batches', '/inventory', '/quality'],
    '/shipments': ['/shipments', '/returns'],
    '/documents': ['/documents', '/certificates'],
    '/invoices': ['/invoices', '/finance'],
    '/traceability': ['/traceability', '/blockchain'],
    '/settings': ['/settings', '/audit-logs'],
  }
  const paths = groupedPaths[to] ?? [to]
  return to === '/' ? pathname === '/' : paths.some((path) => pathname === path || pathname.startsWith(`${path}/`))
}

async function api<T>(path: string, init?: RequestInit, canRefresh = true): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}), ...(activeOrganizationHeader ? { 'X-Organization-Id': activeOrganizationHeader } : {}), ...init?.headers },
  })
  const refreshExcludedPaths = ['/api/auth/login', '/api/auth/register', '/api/auth/refresh', '/api/auth/logout']
  if (response.status === 401 && canRefresh && !refreshExcludedPaths.includes(path)) {
    try {
      const refreshResponse = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })
      if (refreshResponse.ok) {
        const refreshed = await refreshResponse.json() as { accessToken?: string }
        if (typeof refreshed.accessToken === 'string' && refreshed.accessToken.length > 0) {
          setAccessToken(refreshed.accessToken)
          return api<T>(path, init, false)
        }
      }
    } catch {
      setAccessToken('')
    }
    setAccessToken('')
    onSessionExpired?.()
  }
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.message ?? 'The request could not be completed')
  return payload as T
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/verify" element={<PublicVerification />} />
        <Route path="/verify/:traceId" element={<PublicVerification />} />
        <Route path="*" element={<AuthGate />} />
      </Routes>
    </BrowserRouter>
  )
}

function AuthGate() {
  const queryClient = useQueryClient()
  const location = useLocation()
  const isAuthPage = location.pathname === '/login' || location.pathname === '/register'
  const session = useQuery<SessionUser | null>({
    queryKey: ['session'],
    queryFn: async () => {
      const response = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })
      if (!response.ok) throw new Error('Sign in to continue')
      const result = await response.json() as { accessToken?: string }
      if (typeof result.accessToken !== 'string' || result.accessToken.length === 0) throw new Error('Sign in to continue')
      setAccessToken(result.accessToken)
      return api<SessionUser>('/api/auth/me')
    },
    retry: false,
    staleTime: 60_000,
  })
  if (session.isPending) return <div className="auth-loading"><span className="brand-mark"><Activity size={19} /></span><span>Opening secure workspace...</span></div>
  onSessionExpired = () => {
    setAccessToken('')
    queryClient.removeQueries({ queryKey: ['organizations'] })
    queryClient.setQueryData<SessionUser | null>(['session'], null)
  }
  if (session.isError || !session.data) {
    if (!isAuthPage) return <Navigate to="/login" replace />
    return <AuthPage onAuthenticated={(user) => queryClient.setQueryData(['session'], user)} />
  }
  if (isAuthPage) return <Navigate to="/" replace />
  return <Workspace user={session.data} onLogout={async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined)
    setAccessToken('')
    queryClient.clear()
    queryClient.setQueryData<SessionUser | null>(['session'], null)
  }} />
}

function AuthPage({ onAuthenticated }: { onAuthenticated: (user: SessionUser) => void }) {
  const location = useLocation()
  const navigate = useNavigate()
  const mode = location.pathname === '/register' ? 'register' : 'login'
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      const result = await api<{ accessToken: string }>(`/api/auth/${mode === 'login' ? 'login' : 'register'}`, {
        method: 'POST',
        body: JSON.stringify(mode === 'login' ? { email, password } : { fullName, email, password }),
      })
      setAccessToken(result.accessToken)
      onAuthenticated(await api<SessionUser>('/api/auth/me'))
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Authentication could not be completed')
    } finally {
      setSubmitting(false)
    }
  }

  return <main className="auth-page"><div className="auth-art"><div className="auth-art-grid" /><div className="auth-art-brand"><span className="brand-mark"><Activity size={19} /></span><span className="brand-copy"><strong>TRUSTTRACE</strong><small>SUPPLY CHAIN INTELLIGENCE</small></span></div><div className="auth-art-copy"><span className="auth-eyebrow">A MORE TRUSTED JOURNEY</span><h1>Every handoff,<br />accounted for.</h1><p>Give products a verifiable identity and make every movement visible to the people who depend on it.</p><div className="auth-proof"><ShieldCheck size={17} /><span>Tamper-evident records, from origin to customer.</span></div></div><div className="auth-art-footer">TRUST EVERY STEP OF THE SUPPLY CHAIN.</div></div><section className="auth-form-side"><div className="auth-form-wrap"><span className="auth-mobile-mark"><span className="brand-mark"><Activity size={19} /></span>TRUSTTRACE</span><span className="section-kicker">SECURE ACCOUNT ACCESS</span><h2>{mode === 'login' ? 'Welcome back' : 'Create your account'}</h2><p className="auth-subtitle">{mode === 'login' ? 'Sign in to your TrustTrace account.' : 'Register a TrustTrace account to continue.'}</p><form className="auth-form" onSubmit={submit}>
    {mode === 'register' && <label className="field"><span>Full name</span><input autoComplete="name" value={fullName} onChange={(event) => setFullName(event.target.value)} required minLength={2} /></label>}
    <label className="field"><span>Work email</span><input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label><label className="field"><span>Password</span><input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={(event) => setPassword(event.target.value)} required minLength={mode === 'login' ? 1 : 12} />{mode === 'register' && <small className="auth-hint">12+ characters with uppercase, lowercase, number and symbol.</small>}</label>
    {error && <div className="form-error"><AlertTriangle size={15} />{error}</div>}<button className="button button-primary auth-submit" disabled={submitting}>{submitting ? 'Please wait...' : mode === 'login' ? 'Sign in securely' : 'Create account'}<ArrowRight size={15} /></button>
  </form><div className="auth-switch">{mode === 'login' ? 'New to TrustTrace?' : 'Already have an account?'} <button type="button" onClick={() => { setError(''); navigate(mode === 'login' ? '/register' : '/login') }}>{mode === 'login' ? 'Create account' : 'Sign in'}</button></div><div className="auth-disclaimer"><LockKeyhole size={13} /><span>Account registration creates no organization or business records. Create or join an organization after signing in.</span></div></div></section></main>
}

function Workspace({ user, onLogout }: { user: SessionUser; onLogout: () => void }) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [selectedOrganizationId, setSelectedOrganizationId] = useState('')
  const [newOrganizationName, setNewOrganizationName] = useState('')
  const [organizationError, setOrganizationError] = useState('')
  const [creatingOrganization, setCreatingOrganization] = useState(false)
  const queryClient = useQueryClient()
  const organizationQuery = useQuery({
    queryKey: ['organizations'],
    queryFn: () => api<{ items: Organization[] }>('/api/organizations'),
    retry: 1,
  })
  const organizations = organizationQuery.data?.items ?? []
  const currentOrganization = organizations.find((organization) => organization.id === selectedOrganizationId) ?? organizations[0] ?? null
  const selectOrganization = (organizationId: string) => {
    activeOrganizationHeader = organizationId
    setSelectedOrganizationId(organizationId)
    void queryClient.invalidateQueries()
  }
  const organizationContext: OrganizationContextValue = {
    organizations,
    currentOrganization,
    selectOrganization,
    isLoading: organizationQuery.isPending,
  }
  const location = useLocation()
  const pageTitle = navigation.find((item) => isWorkspaceNavigationActive(item.to, location.pathname))?.label ?? 'Dashboard'

  useEffect(() => {
    activeOrganizationHeader = currentOrganization?.id
    if (organizationQuery.data && selectedOrganizationId && !organizations.some((organization) => organization.id === selectedOrganizationId)) {
      setSelectedOrganizationId(organizations[0]?.id ?? '')
    }
  }, [organizationQuery.data, organizations, selectedOrganizationId])

  const createOrganization = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setOrganizationError('')
    setCreatingOrganization(true)
    try {
      const organization = await api<Organization>('/api/organizations', {
        method: 'POST',
        body: JSON.stringify({ name: newOrganizationName }),
      })
      activeOrganizationHeader = organization.id
      setSelectedOrganizationId(organization.id)
      setNewOrganizationName('')
      await queryClient.invalidateQueries({ queryKey: ['organizations'] })
    } catch (error) {
      setOrganizationError(error instanceof Error ? error.message : 'Organization could not be created')
    } finally {
      setCreatingOrganization(false)
    }
  }

  return (
    <div className="app-shell">
      {mobileNavOpen && <button className="nav-scrim" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} />}
      <aside className={`sidebar ${mobileNavOpen ? 'sidebar-open' : ''}`}>
        <Link className="brand" to="/" onClick={() => setMobileNavOpen(false)}>
          <span className="brand-mark"><Activity size={19} strokeWidth={2.5} /></span>
          <span className="brand-copy"><strong>TRUSTTRACE</strong><small>SUPPLY CHAIN INTELLIGENCE</small></span>
        </Link>
        <label className="workspace-switcher">
          <span className="workspace-avatar"><Building2 size={17} /></span>
          <span className="workspace-select-wrap"><select aria-label="Current organization" value={currentOrganization?.id ?? ''} disabled={organizationQuery.isPending || organizations.length === 0} onChange={(event) => selectOrganization(event.target.value)}>{organizations.length === 0 ? <option value="">{organizationQuery.isError ? 'Organizations unavailable' : organizationQuery.isPending ? 'Loading organizations...' : 'No organization selected'}</option> : organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}</select><small>{currentOrganization?.roleName ?? 'Organization'}</small></span>
          <ChevronDown size={15} className="switcher-chevron" />
        </label>
        <div className="nav-caption">WORKSPACE</div>
        <nav className="primary-nav" aria-label="Main navigation">
          {navigation.map(({ label, to, icon: Icon }) => (
            <NavLink key={to} to={to} end={to === '/'} onClick={() => setMobileNavOpen(false)} className={() => `nav-item ${isWorkspaceNavigationActive(to, location.pathname) ? 'active' : ''}`}>
              <Icon size={17} strokeWidth={1.8} /><span>{label}</span>
              {label === 'Recalls' && <span className="nav-dot" />}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-help"><span className="help-icon"><CircleHelp size={16} /></span><div><strong>Need a hand?</strong><small>Visit the help center</small></div><ArrowRight size={15} /></div>
          <div className="account-row"><span className="account-avatar">{user.fullName.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase()}</span><span><strong>{user.fullName}</strong><small>{user.email}</small></span><button className="account-logout" aria-label="Sign out" title="Sign out" onClick={onLogout}><LogOut size={15} /></button></div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <button className="icon-button menu-button" aria-label="Open navigation" onClick={() => setMobileNavOpen(true)}><Menu size={19} /></button>
          <div className="breadcrumbs"><span>Workspace</span><span className="crumb-slash">/</span><strong>{pageTitle}</strong></div>
          <div className="topbar-actions">
            <label className="global-search"><Search size={16} /><input placeholder="Search anything..." aria-label="Search" /><kbd>⌘ K</kbd></label>
            <NotificationCenter organizationId={currentOrganization?.id} />
            <span className="topbar-divider" />
            <span className="environment-chip"><span />LIVE ENVIRONMENT</span>
          </div>
        </header>
        <OrganizationContext.Provider value={organizationContext}><div className="page-content">
          {organizationQuery.isError ? <div className="connection-alert"><AlertTriangle size={16} /><span>Organizations could not be loaded. Check the API connection and try again.</span></div> : organizationQuery.isPending ? <div className="surface organization-state">Loading organizations...</div> : organizations.length === 0 ? <section className="surface organization-state"><div className="catalog-empty-mark"><Building2 size={21} /></div><span className="section-kicker">WORKSPACE SETUP</span><h2>No organizations yet</h2><p>Create an organization to establish your workspace context. No sample organizations are preloaded.</p><form className="organization-create-form" onSubmit={createOrganization}><label className="field"><span>Organization name</span><input value={newOrganizationName} onChange={(event) => setNewOrganizationName(event.target.value)} minLength={2} maxLength={160} required /></label>{organizationError && <div className="form-error"><AlertTriangle size={15} />{organizationError}</div>}<button className="button button-primary" disabled={creatingOrganization}>{creatingOrganization ? 'Creating...' : 'Create organization'}<ArrowRight size={15} /></button></form></section> : <Routes>
            <Route path="/" element={<Dashboard />} />
                        <Route path="/products/new" element={<SupplyChainWorkspace />} />
                        <Route path="/products/:id/edit" element={<SupplyChainWorkspace />} />
                        <Route path="/products/:id" element={<SupplyChainWorkspace />} />
                        <Route path="/products" element={<SupplyChainWorkspace />} />
                        <Route path="/batches/new" element={<SupplyChainWorkspace />} />
                        <Route path="/batches/:id" element={<SupplyChainWorkspace />} />
                        <Route path="/batches" element={<SupplyChainWorkspace />} />
                        <Route path="/inventory" element={<SupplyChainWorkspace />} />
                        <Route path="/quality" element={<Navigate to="/products?tab=quality" replace />} />
                        <Route path="/shipments/new" element={<LogisticsWorkspace />} />
                        <Route path="/shipments/:id" element={<LogisticsWorkspace />} />
                        <Route path="/shipments" element={<LogisticsWorkspace />} />
                        <Route path="/recalls" element={<Navigate to="/shipments?tab=recalls" replace />} />
                        <Route path="/returns/new" element={<LogisticsWorkspace />} />
                        <Route path="/returns/:id" element={<LogisticsWorkspace />} />
                        <Route path="/returns" element={<LogisticsWorkspace />} />
                        <Route path="/documents" element={<DocumentsWorkspace />} />
                        <Route path="/certificates" element={<Navigate to="/documents?tab=certificates" replace />} />
                        <Route path="/invoices/new" element={<FinanceWorkspace />} />
                        <Route path="/invoices/:id" element={<FinanceWorkspace />} />
                        <Route path="/invoices" element={<FinanceWorkspace />} />
                        <Route path="/finance" element={<Navigate to="/invoices?tab=payments" replace />} />
                        <Route path="/traceability" element={<TraceabilityWorkspace />} />
                        <Route path="/blockchain" element={<Navigate to="/traceability?tab=blockchain" replace />} />
                        <Route path="/reports" element={<ReportsWorkspace />} />
                        <Route path="/settings" element={<AdministrationWorkspace />} />
                        <Route path="/audit-logs" element={<Navigate to="/settings?tab=audit-logs" replace />} />
            <Route path="/scan" element={<ScanPage />} />
            <Route path="*" element={<ModulePage title={pageTitle} description="Monitor and manage this part of your supply chain." />} />
          </Routes>}
        </div>
        </OrganizationContext.Provider>
      </main>
    </div>
  )
}

type WorkspaceTabDefinition = { id: string; label: string; href: string }

  function WorkspaceTabs({ title, tabs, activeTab, children }: { title: string; tabs: WorkspaceTabDefinition[]; activeTab: string; children: React.ReactNode }) {
    const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      const links = [...event.currentTarget.querySelectorAll<HTMLAnchorElement>('[role="tab"]')]
      const index = links.indexOf(document.activeElement as HTMLAnchorElement)
      if (index < 0) return
      event.preventDefault()
      links[(index + (event.key === 'ArrowRight' ? 1 : links.length - 1)) % links.length]?.focus()
    }
    const active = tabs.find((tab) => tab.id === activeTab) ?? tabs[0]
    return <section className="workspace-frame"><div className="workspace-tabbar"><span className="workspace-name">{title} workspace</span><div className="workspace-tablist" role="tablist" aria-label={`${title} sections`} onKeyDown={onKeyDown}>{tabs.map((tab) => <Link key={tab.id} id={`tab-${title.toLowerCase().replaceAll(' ', '-')}-${tab.id}`} role="tab" aria-selected={tab.id === active.id} aria-controls="workspace-tab-panel" tabIndex={tab.id === active.id ? 0 : -1} className={`workspace-tab ${tab.id === active.id ? 'active' : ''}`} to={tab.href}>{tab.label}</Link>)}</div></div><div id="workspace-tab-panel" className="workspace-tab-panel" role="tabpanel" aria-labelledby={`tab-${title.toLowerCase().replaceAll(' ', '-')}-${active.id}`}>{children}</div></section>
  }

  function useWorkspaceTab(param: string, fallback: string, validTabs: string[], pathTab: string) {
    const location = useLocation()
    const fromUrl = new URLSearchParams(location.search).get(param)
    return validTabs.includes(fromUrl ?? '') ? fromUrl! : pathTab || fallback
  }

  function SupplyChainWorkspace() {
    const { pathname } = useLocation()
    const tabs = [
      { id: 'products', label: 'Products', href: '/products?tab=products' },
      { id: 'batches', label: 'Batches', href: '/products?tab=batches' },
      { id: 'inventory', label: 'Inventory', href: '/products?tab=inventory' },
      { id: 'quality', label: 'Quality', href: '/products?tab=quality' },
    ]
    const detailOrForm = pathname !== '/products' && pathname !== '/batches' && pathname !== '/inventory' && pathname !== '/quality'
    const pathTab = pathname.startsWith('/batches') ? 'batches' : pathname === '/inventory' ? 'inventory' : pathname === '/quality' ? 'quality' : 'products'
    const requestedTab = useWorkspaceTab('tab', 'products', tabs.map((tab) => tab.id), pathTab)
    const activeTab = detailOrForm ? pathTab : requestedTab
    let page: React.ReactNode
    if (pathname === '/products/new' || /^\/products\/[^/]+\/edit$/.test(pathname)) page = <ProductFormPage />
    else if (/^\/products\/[^/]+$/.test(pathname)) page = <ProductDetailPage />
    else if (pathname === '/batches/new') page = <BatchFormPage />
    else if (/^\/batches\/[^/]+$/.test(pathname)) page = <BatchDetailPage />
    else if (activeTab === 'batches') page = <BatchesPage />
    else if (activeTab === 'inventory') page = <InventoryPage />
    else if (activeTab === 'quality') page = <QualityPage />
    else page = <ProductsPage />
    return <WorkspaceTabs title="Supply Chain" tabs={tabs} activeTab={activeTab}>{page}</WorkspaceTabs>
  }

  function LogisticsWorkspace() {
    const { pathname } = useLocation()
    const tabs = [
      { id: 'shipments', label: 'Shipments', href: '/shipments?tab=shipments' },
      { id: 'returns', label: 'Returns', href: '/shipments?tab=returns' },
      { id: 'tracking', label: 'Tracking / Status', href: '/shipments?tab=tracking' },
      { id: 'recalls', label: 'Recalls', href: '/shipments?tab=recalls' },
    ]
    const detailOrForm = pathname !== '/shipments' && pathname !== '/returns'
    const pathTab = pathname.startsWith('/returns') ? 'returns' : 'shipments'
    const requestedTab = useWorkspaceTab('tab', 'shipments', tabs.map((tab) => tab.id), pathTab)
    const activeTab = detailOrForm ? pathTab : requestedTab
    let page: React.ReactNode
    if (pathname === '/shipments/new') page = <ShipmentFormPage />
    else if (/^\/shipments\/[^/]+$/.test(pathname)) page = <ShipmentDetailPage />
    else if (pathname === '/returns/new') page = <ReturnFormPage />
    else if (/^\/returns\/[^/]+$/.test(pathname)) page = <ReturnDetailPage />
    else if (activeTab === 'returns') page = <ReturnsPage />
    else if (activeTab === 'tracking') page = <TrackingPage />
    else if (activeTab === 'recalls') page = <ModulePage title="Recalls" description="Review and manage organization recall notices." />
    else page = <ShipmentsPage />
    return <WorkspaceTabs title="Logistics" tabs={tabs} activeTab={activeTab}>{page}</WorkspaceTabs>
  }

  function DocumentsWorkspace() {
    const activeTab = useWorkspaceTab('tab', 'documents', ['documents', 'certificates'], 'documents')
    const tabs = [
      { id: 'documents', label: 'Documents', href: '/documents?tab=documents' },
      { id: 'certificates', label: 'Certificates', href: '/documents?tab=certificates' },
    ]
    return <WorkspaceTabs title="Documents & Compliance" tabs={tabs} activeTab={activeTab}><div className={activeTab === 'certificates' ? 'certificate-mode' : 'documents-mode'}><DocumentsPage /></div></WorkspaceTabs>
  }

  function FinanceWorkspace() {
    const { pathname } = useLocation()
    const tabs = [
      { id: 'invoices', label: 'Invoices', href: '/invoices?tab=invoices' },
      { id: 'payments', label: 'Payments', href: '/invoices?tab=payments' },
      { id: 'refunds', label: 'Refunds', href: '/invoices?tab=refunds' },
    ]
    const invoiceDetail = pathname === '/invoices/new' || /^\/invoices\/[^/]+$/.test(pathname)
    const requestedTab = useWorkspaceTab('tab', 'invoices', tabs.map((tab) => tab.id), 'invoices')
    const activeTab = invoiceDetail ? 'invoices' : requestedTab
    const page = pathname === '/invoices/new' ? <InvoiceFormPage /> : /^\/invoices\/[^/]+$/.test(pathname) ? <InvoiceDetailPage /> : activeTab === 'payments' ? <PaymentsPage /> : activeTab === 'refunds' ? <RefundsPage /> : <InvoicesPage />
    return <WorkspaceTabs title="Finance" tabs={tabs} activeTab={activeTab}>{page}</WorkspaceTabs>
  }

  function TraceabilityWorkspace() {
    const tabs = [
      { id: 'timeline', label: 'Timeline / Traceability', href: '/traceability?tab=timeline' },
      { id: 'blockchain', label: 'Blockchain', href: '/traceability?tab=blockchain' },
      { id: 'verification', label: 'Public Verification', href: '/traceability?tab=verification' },
    ]
    const activeTab = useWorkspaceTab('tab', 'timeline', tabs.map((tab) => tab.id), 'timeline')
    const page = activeTab === 'blockchain' ? <BlockchainPage /> : activeTab === 'verification' ? <ScanPage /> : <TraceabilityPage />
    return <WorkspaceTabs title="Traceability" tabs={tabs} activeTab={activeTab}>{page}</WorkspaceTabs>
  }

  function ReportsWorkspace() {
    const tabs = [
      { id: 'operations', label: 'Operations', href: '/reports?tab=operations' },
      { id: 'inventory', label: 'Inventory', href: '/reports?tab=inventory' },
      { id: 'traceability', label: 'Traceability', href: '/reports?tab=traceability' },
    ]
    const activeTab = useWorkspaceTab('tab', 'operations', tabs.map((tab) => tab.id), 'operations')
    const page = activeTab === 'inventory' ? <InventoryReportPage /> : activeTab === 'traceability' ? <TraceabilityReportPage /> : <ReportsPage />
    return <WorkspaceTabs title="Reports" tabs={tabs} activeTab={activeTab}>{page}</WorkspaceTabs>
  }

  function AdministrationWorkspace() {
    const { currentOrganization } = useOrganizationContext()
    const tabs = [
      { id: 'organization', label: 'Organization', href: '/settings?tab=organization' },
      { id: 'members', label: 'Users / Members', href: '/settings?tab=members' },
      ...((currentOrganization?.roleName === 'OWNER' || currentOrganization?.roleName === 'ADMIN') ? [{ id: 'audit-logs', label: 'Audit Logs', href: '/settings?tab=audit-logs' }] : []),
      { id: 'notifications', label: 'Notifications', href: '/settings?tab=notifications' },
    ]
    const activeTab = useWorkspaceTab('tab', 'organization', tabs.map((tab) => tab.id), 'organization')
    const page = activeTab === 'members' ? <OrganizationMembersPage /> : activeTab === 'audit-logs' ? <AuditLogsPage /> : activeTab === 'notifications' ? <NotificationsPage /> : <OrganizationSettingsPage />
    return <WorkspaceTabs title="Administration" tabs={tabs} activeTab={activeTab}>{page}</WorkspaceTabs>
  }

  function QualityPage() {
    const { currentOrganization } = useOrganizationContext()
    const batches = useQuery({ queryKey: ['quality-batches', currentOrganization?.id], queryFn: () => api<{ items: BatchRecord[] }>('/api/batches'), enabled: Boolean(currentOrganization), retry: false })
    const needsReview = (batches.data?.items ?? []).filter((batch) => batch.qualityStatus === 'PENDING' || batch.qualityStatus === 'FAILED')
    return <><section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" />QUALITY CONTROL</div><h1>Quality review</h1><p>Review batch quality state; opening a batch provides its existing inspection actions.</p></div></section>{batches.isError && <div className="connection-alert" role="alert">{batches.error.message}</div>}{batches.isPending ? <div className="surface module-empty">Loading quality records...</div> : needsReview.length ? <section className="surface operations-table"><div className="operations-table-head quality-columns"><span>BATCH</span><span>PRODUCT</span><span>QUALITY</span><span>STATUS</span><span /></div>{needsReview.map((batch) => <Link className="operations-row quality-columns" key={batch.id} to={`/batches/${batch.id}`}><strong>{batch.batchNumber}</strong><span>{batch.product.name}</span><span className="status-pill">{batch.qualityStatus}</span><span>{batch.status.replaceAll('_', ' ')}</span><span>Open batch →</span></Link>)}</section> : <div className="surface module-empty"><div className="catalog-empty-mark"><ClipboardCheck size={21} /></div><h2>No batches need quality review</h2><p>Quality-pending and failed batches will appear here.</p></div>}</>
  }

  function TrackingPage() {
    const { currentOrganization } = useOrganizationContext()
    const shipments = useQuery({ queryKey: ['shipment-tracking', currentOrganization?.id], queryFn: () => api<{ items: ShipmentRow[] }>('/api/shipments'), enabled: Boolean(currentOrganization), retry: false })
    const active = (shipments.data?.items ?? []).filter((shipment) => !['DELIVERED', 'CANCELLED'].includes(shipment.status))
    return <><section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" />LIVE MOVEMENT</div><h1>Tracking / Status</h1><p>Shipment progression and recorded status timestamps.</p></div></section>{shipments.isError && <div className="connection-alert" role="alert">{shipments.error.message}</div>}{shipments.isPending ? <div className="surface module-empty">Loading shipment status...</div> : active.length ? <section className="surface operations-list tracking-list">{active.map((shipment) => <article className="document-row" key={shipment.id}><strong><Link to={`/shipments/${shipment.id}`}>{shipment.trackingNumber}</Link> · {shipment.status.replaceAll('_', ' ')}</strong><span>{shipment.destination} · {shipment.items.map((item) => item.batchNumber).join(', ')}</span><small>{shipment.statusHistory.at(-1) ? `Last update ${new Date(shipment.statusHistory.at(-1)!.occurredAt).toLocaleString()}` : 'No status history'}</small></article>)}</section> : <div className="surface module-empty"><div className="catalog-empty-mark"><Truck size={21} /></div><h2>No active shipments</h2><p>Shipment status tracking appears here after dispatch.</p></div>}</>
  }

  function PaymentsPage() {
    const { currentOrganization } = useOrganizationContext()
    const payments = useQuery({ queryKey: ['payments', currentOrganization?.id], queryFn: () => api<{ items: Array<{ id: string; amount: string; currency: string; status: string; method: string | null; providerRef: string | null; createdAt: string; invoice: { id: string; invoiceNumber: string; status: string }; refunds: Array<{ amount: string }> }> }>('/api/payments'), enabled: Boolean(currentOrganization), retry: false })
    return <><section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" />FINANCE</div><h1>Payments</h1><p>Operational payment records by invoice.</p></div></section>{payments.isError && <div className="connection-alert" role="alert">{payments.error.message}</div>}{payments.isPending ? <div className="surface module-empty">Loading payments...</div> : payments.data?.items.length ? <section className="surface operations-table"><div className="operations-table-head payment-columns"><span>DATE</span><span>INVOICE</span><span>METHOD / REFERENCE</span><span>AMOUNT</span><span>STATUS</span><span /></div>{payments.data.items.map((payment) => <Link className="operations-row payment-columns" key={payment.id} to={`/invoices/${payment.invoice.id}`}><time>{new Date(payment.createdAt).toLocaleDateString()}</time><strong>{payment.invoice.invoiceNumber}</strong><span>{payment.method ?? '—'} · {payment.providerRef ?? 'No reference'}</span><span>{payment.currency} {payment.amount}</span><span className="status-pill">{payment.status.replaceAll('_', ' ')}</span><span>{payment.refunds.length ? `${payment.refunds.length} refunds` : ''}</span></Link>)}</section> : <div className="surface module-empty"><div className="catalog-empty-mark"><FileText size={21} /></div><h2>No payments recorded</h2><p>Payments appear here when recorded from an issued invoice.</p><Link className="button button-primary" to="/invoices"><FileText size={15} />View invoices</Link></div>}</>
  }

  function RefundsPage() {
    const { currentOrganization } = useOrganizationContext()
    const refunds = useQuery({ queryKey: ['refunds', currentOrganization?.id], queryFn: () => api<{ items: Array<{ id: string; amount: string; reason: string; createdAt: string; payment: { id: string; currency: string; invoice: { id: string; invoiceNumber: string } } }> }>('/api/refunds'), enabled: Boolean(currentOrganization), retry: false })
    return <><section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" />FINANCE</div><h1>Refunds</h1><p>Refunds recorded against eligible invoice payments.</p></div></section>{refunds.isError && <div className="connection-alert" role="alert">{refunds.error.message}</div>}{refunds.isPending ? <div className="surface module-empty">Loading refunds...</div> : refunds.data?.items.length ? <section className="surface operations-table"><div className="operations-table-head refund-columns"><span>DATE</span><span>INVOICE</span><span>PAYMENT</span><span>AMOUNT</span><span>REASON</span></div>{refunds.data.items.map((refund) => <Link className="operations-row refund-columns" key={refund.id} to={`/invoices/${refund.payment.invoice.id}`}><time>{new Date(refund.createdAt).toLocaleDateString()}</time><strong>{refund.payment.invoice.invoiceNumber}</strong><span>{refund.payment.id}</span><span>{refund.payment.currency} {refund.amount}</span><span>{refund.reason}</span></Link>)}</section> : <div className="surface module-empty"><div className="catalog-empty-mark"><ArrowDownRight size={21} /></div><h2>No refunds recorded</h2><p>Refunds can be submitted from the invoice payment record.</p></div>}</>
  }

  function NotificationsPage() {
    const { currentOrganization } = useOrganizationContext()
    const queryClient = useQueryClient()
    const notifications = useQuery({ queryKey: ['notifications', currentOrganization?.id], queryFn: () => api<{ items: NotificationRecord[]; unread: number }>('/api/notifications'), enabled: Boolean(currentOrganization), retry: false })
    const markRead = async (id?: string) => {
      await api(id ? `/api/notifications/${encodeURIComponent(id)}/read` : '/api/notifications/read-all', { method: 'PATCH' })
      await queryClient.invalidateQueries({ queryKey: ['notifications'] })
      await queryClient.invalidateQueries({ queryKey: ['notifications-unread'] })
    }
    return <><section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" />WORKSPACE UPDATES</div><h1>Notifications</h1><p>Operational events for your organization account.</p></div><button className="button button-secondary" disabled={!notifications.data?.unread} onClick={() => void markRead()}>Mark all read</button></section>{notifications.isError && <div className="connection-alert" role="alert">{notifications.error.message}</div>}{notifications.isPending ? <div className="surface module-empty">Loading notifications...</div> : notifications.data?.items.length ? <section className="surface operations-list notification-page-list">{notifications.data.items.map((item) => <button className={`notification-row ${item.readAt ? '' : 'unread'}`} key={item.id} onClick={() => !item.readAt && void markRead(item.id)}><strong>{item.title}</strong><span>{item.body}</span><time>{new Date(item.createdAt).toLocaleString()}</time></button>)}</section> : <div className="surface module-empty"><div className="catalog-empty-mark"><Bell size={21} /></div><h2>No notifications</h2><p>Important shipment, return, and finance updates will appear here.</p></div>}</>
  }

  function Dashboard() {
  const summary = useQuery({ queryKey: ['dashboard-summary'], queryFn: () => api<DashboardSummary>('/api/dashboard/summary'), retry: 1 })
  const activity = useQuery({ queryKey: ['dashboard-activity'], queryFn: () => api<Array<{ day: string; events: number; anchors: number }>>('/api/dashboard/activity'), retry: 1 })
  const recentEvents = useQuery({ queryKey: ['dashboard-recent-events'], queryFn: () => api<RecentEvent[]>('/api/dashboard/recent-events'), retry: 1 })
  const integrity = useQuery({ queryKey: ['dashboard-integrity'], queryFn: () => api<IntegritySummary>('/api/dashboard/integrity'), retry: 1 })
  const attention = useQuery({ queryKey: ['dashboard-attention'], queryFn: () => api<AttentionSummary>('/api/dashboard/attention'), retry: 1 })
  const values = summary.data
  const alertCount = attention.data ? Object.values(attention.data).reduce((total, value) => total + value, 0) : null
  const anchoredCount = integrity.data?.anchors.ANCHORED ?? 0
  const pendingAnchorCount = integrity.data?.anchors.PENDING ?? 0
  const failedAnchorCount = integrity.data?.anchors.ANCHOR_FAILED ?? 0
  const anchorStatus = integrity.isError ? 'ERROR' : failedAnchorCount ? 'FAILED' : pendingAnchorCount ? 'PENDING' : anchoredCount ? 'ANCHORED' : 'IDLE'
  const cards = [
    { label: 'Products', value: values?.products, icon: Package, tint: 'mint', note: 'Registered identities' },
    { label: 'Active batches', value: values?.activeBatches, icon: Boxes, tint: 'blue', note: 'Open supply lots' },
    { label: 'Inventory units', value: values?.inventory, icon: ClipboardList, tint: 'gold', note: 'Available to fulfill' },
    { label: 'Active shipments', value: values?.shipments, icon: Truck, tint: 'coral', note: 'Currently in transit' },
    { label: 'Returns', value: values?.returns, icon: ArrowDownRight, tint: 'blue', note: 'Return requests' },
    { label: 'Expiring batches', value: attention.data?.expiringBatches, icon: Clock3, tint: 'gold', note: 'Within 30 days' },
    { label: 'Recalled batches', value: attention.data?.recalledBatches, icon: AlertTriangle, tint: 'coral', note: 'Active risk records' },
    { label: 'Blockchain anchors', value: integrity.data ? anchoredCount : undefined, icon: LockKeyhole, tint: 'mint', note: 'Verified proofs' },
    { label: 'Failed anchors', value: integrity.data ? failedAnchorCount : undefined, icon: ShieldQuestion, tint: 'coral', note: 'Retry available' },
    { label: 'Payments', value: values?.payments, icon: FileText, tint: 'gold', note: 'Recorded payments' },
  ]

  return (
    <>
      <section className="page-heading dashboard-heading">
        <div><div className="eyebrow"><span className="eyebrow-line" />{new Date().toLocaleDateString(undefined, { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }).toUpperCase()}</div><h1>Supply chain overview</h1><p>A clear view of every handoff, from manufacturer to destination.</p></div>
        <Link className="button button-secondary" to="/scan"><QrCode size={16} />Scan identity</Link>
      </section>
      {summary.isError && <div className="connection-alert"><AlertTriangle size={16} /><span>Live data is unavailable. Connect the API and database to load workspace records.</span></div>}
      <section className="metric-grid" aria-label="Supply chain totals">
        {cards.map(({ label, value, icon: Icon, tint, note }, index) => (
          <article className={`metric-card enter enter-${index + 1}`} key={label}>
            <div className="metric-top"><span className={`metric-icon ${tint}`}><Icon size={18} /></span><span className="metric-context">{note}</span></div>
            <div className="metric-number">{summary.isPending ? <span className="number-loading" /> : summary.isError ? '—' : value?.toLocaleString() ?? '—'}</div>
            <div className="metric-label">{label}</div>
          </article>
        ))}
      </section>
      <section className="dashboard-grid">
        <article className="surface journey-panel enter enter-5">
          <div className="section-heading"><div><span className="section-kicker">OPERATIONS</span><h2>Journey activity</h2></div><button className="text-button" type="button">Last 30 days <ChevronDown size={14} /></button></div>
          <div className="chart-area">
            {activity.data?.length ? <Suspense fallback={<div className="chart-loading" />}><ActivityChart data={activity.data} /></Suspense> : <div className="empty-chart"><div className="chart-gridlines"><i /><i /><i /><i /><i /></div><div className="chart-empty-mark"><Activity size={19} /></div><strong>{activity.isError ? 'Activity data unavailable' : 'No journey activity yet'}</strong><span>{activity.isError ? 'Reconnect to the API to load event history.' : 'Supply-chain events will appear here as products move.'}</span></div>}
          </div>
          <div className="chart-legend"><span><i className="legend-dot events" />Supply-chain events</span><span><i className="legend-dot anchors" />Blockchain anchors</span></div>
        </article>
        <article className="surface integrity-panel enter enter-6">
          <div className="section-heading"><div><span className="section-kicker">TRUST LAYER</span><h2>Record integrity</h2></div><ShieldCheck size={19} className="integrity-icon" /></div>
          <div className="integrity-status"><span className="integrity-indicator"><span /></span><div><strong>{integrity.isError ? 'Integrity data unavailable' : integrity.data?.eventCount ? integrity.data.databaseChainVerified ? 'Database chain verified' : 'Verification requires review' : 'Awaiting first record'}</strong><small>{integrity.isError ? 'Reconnect to load verification status.' : `${integrity.data?.eventCount ?? 0} events in this organization`}</small></div></div>
          <div className="integrity-list">
            <div><span className="status-icon muted"><ShieldCheck size={15} /></span><span><strong>Database chain</strong><small>Hash linked event history</small></span><span className="status-pending">{integrity.isError ? 'ERROR' : integrity.data?.eventCount ? integrity.data.databaseChainVerified ? 'VERIFIED' : 'REVIEW' : 'IDLE'}</span></div>
            <div><span className="status-icon muted"><LockKeyhole size={15} /></span><span><strong>Blockchain anchors</strong><small>{integrity.isError ? 'Anchor data unavailable' : `${anchoredCount} anchored · ${pendingAnchorCount} pending · ${failedAnchorCount} failed`}</small></span><span className="status-pending">{anchorStatus}</span></div>
            <div><span className="status-icon muted"><BadgeCheck size={15} /></span><span><strong>Certificates</strong><small>Issuer and signature checks</small></span><span className="status-pending">{integrity.isError ? 'ERROR' : integrity.data?.certificateCount ? `${integrity.data.verifiedCertificates}/${integrity.data.certificateCount}` : 'NONE'}</span></div>
          </div>
          <Link to="/traceability" className="panel-link">View verification details <ArrowRight size={15} /></Link>
        </article>
      </section>
      <section className="lower-grid">
        <article className="surface recent-panel">
          <div className="section-heading"><div><span className="section-kicker">LATEST RECORDS</span><h2>Recent supply-chain events</h2></div><Link className="text-button" to="/traceability">View all <ArrowRight size={14} /></Link></div>
          {recentEvents.data?.length ? <div className="recent-event-list">{recentEvents.data.map((event) => <div className="recent-event-row" key={event.id}><span className="recent-event-mark"><Activity size={14} /></span><span><strong>{event.eventType.replaceAll('_', ' ').toLowerCase()}</strong><small>{event.productName} · {event.traceId}</small></span><span className="recent-event-time">{new Date(event.createdAt).toLocaleString()}</span></div>)}</div> : <div className="table-empty"><span className="empty-icon"><Clock3 size={18} /></span><strong>{recentEvents.isError ? 'Event history unavailable' : 'No events recorded'}</strong><span>{recentEvents.isError ? 'Reconnect to load organization activity.' : 'Events are added automatically as products move through the supply chain.'}</span></div>}
        </article>
        <article className="surface attention-panel">
          <div className="section-heading"><div><span className="section-kicker">ATTENTION</span><h2>Needs your attention</h2></div><span className="attention-count">{attention.isError || attention.isPending ? '—' : alertCount}</span></div>
          {alertCount === 0 ? <div className="attention-empty"><div className="attention-check"><ShieldCheck size={20} /></div><strong>No active alerts</strong><span>Expiry, quality, recall and certificate alerts are clear.</span></div> : attention.data ? <div className="alert-list">{attention.data.expiredBatches > 0 && <div><AlertTriangle size={15} /><span>Expired batches</span><strong>{attention.data.expiredBatches}</strong></div>}{attention.data.pendingQualityChecks > 0 && <div><ClipboardCheck size={15} /><span>Quality checks pending</span><strong>{attention.data.pendingQualityChecks}</strong></div>}{attention.data.activeRecalls > 0 && <div><AlertTriangle size={15} /><span>Active recalls</span><strong>{attention.data.activeRecalls}</strong></div>}{attention.data.expiringCertificates > 0 && <div><FileCheck2 size={15} /><span>Certificates expiring soon</span><strong>{attention.data.expiringCertificates}</strong></div>}</div> : <div className="attention-empty"><div className="attention-check"><ShieldQuestion size={20} /></div><strong>Alert data unavailable</strong><span>Reconnect to load expiry, quality and recall checks.</span></div>}
        </article>
      </section>
      <div className="dashboard-footer"><span><ShieldCheck size={14} /> Trust every step of the supply chain.</span><span>Traceability does not establish medical safety.</span></div>
    </>
  )
}

function ProductApiScopeNotice({ children }: { children: React.ReactNode }) {
  const { currentOrganization, isLoading } = useOrganizationContext()
  if (isLoading) return <div className="surface module-empty">Loading organization context...</div>
  if (!currentOrganization) return <div className="surface module-empty"><Building2 size={20} /><h2>Select an organization</h2><p>Choose an organization before viewing product records.</p></div>
  return <>{children}</>
}

function matchesProductApiOrganization(organizations: Organization[], currentOrganization: Organization | null) {
  return Boolean(currentOrganization && organizations.some((organization) => organization.id === currentOrganization.id))
}

function ProductsPage() {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const { organizations, currentOrganization } = useOrganizationContext()
  const organizationMatchesApi = matchesProductApiOrganization(organizations, currentOrganization)
  const products = useQuery({
    queryKey: ['products', currentOrganization?.id, search, status],
    queryFn: () => {
      const params = new URLSearchParams()
      if (search.trim()) params.set('search', search.trim())
      if (status) params.set('status', status)
      return api<{ items: Product[]; total: number; page: number; pageSize: number }>(`/api/products${params.size ? `?${params}` : ''}`)
    },
    enabled: organizationMatchesApi,
    retry: false,
  })

  return <ProductApiScopeNotice><>
    <section className="page-heading products-heading"><div><div className="eyebrow"><span className="eyebrow-line" />PRODUCT CATALOG</div><h1>Products</h1><p>Pharmaceutical identities registered to your organization.</p></div><Link className="button button-primary" to="/products/new"><Plus size={16} />Create product</Link></section>
    <div className="catalog-toolbar"><label className="catalog-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search brand, generic name or Trace ID" aria-label="Search products" /></label><select className="catalog-filter" aria-label="Filter products by status" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All statuses</option><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option><option value="UNDER_REVIEW">Under review</option></select><button className="button button-secondary" type="button" onClick={() => void products.refetch()} disabled={products.isFetching}><RotateCw size={15} />Refresh</button></div>
    {products.isError && <div className="connection-alert" role="alert"><AlertTriangle size={16} /><span>{products.error instanceof Error ? products.error.message : 'Products could not be loaded.'}</span></div>}
    <div className="surface products-table-wrap">
      <div className="table-head product-columns"><span>PRODUCT</span><span>TRACE ID</span><span>FORM / STRENGTH</span><span>MANUFACTURER</span><span>CATEGORY</span><span>STATUS</span><span /></div>
      {products.isPending ? <div className="catalog-empty"><span className="number-loading" /><span className="table-muted">Loading product records...</span></div> : products.data?.items.length ? products.data.items.map((product) => (
        <div className="table-row product-columns" key={product.id}><Link className="product-name product-name-link" to={`/products/${product.id}`}><span className="product-row-icon"><FlaskConical size={17} /></span><span><strong>{product.brandName}</strong><small>{product.genericName}</small></span></Link><code className="trace-id">{product.traceId ?? '—'}</code><span className="table-muted">{product.dosageForm} · {product.strength}</span><span className="table-muted">{product.manufacturer}</span><span className="table-muted">{product.pharmaceuticalCategory.replaceAll('_', ' ')}</span><span className={`status-pill status-${product.status.toLowerCase()}`}>{product.status.replaceAll('_', ' ')}</span><Link className="row-action" aria-label={`View ${product.brandName}`} title="View product" to={`/products/${product.id}`}><ArrowRight size={16} /></Link></div>
      )) : products.isError ? null : <div className="catalog-empty"><div className="catalog-empty-mark"><Package size={22} /></div><span className="section-kicker">YOUR CATALOG STARTS HERE</span><h2>{search || status ? 'No matching products' : 'No products registered'}</h2><p>{search || status ? 'Adjust your search or status filter.' : 'Create a pharmaceutical product identity to begin. No demo products are preloaded.'}</p>{!search && !status && <Link className="button button-primary" to="/products/new"><Plus size={16} />Create product</Link>}</div>}
    </div>
    {products.data && <div className="table-pagination"><span>{products.data.total} products</span><span>Page {products.data.page} of {Math.max(1, Math.ceil(products.data.total / products.data.pageSize))}</span></div>}
  </></ProductApiScopeNotice>
}

function ProductDetailPage() {
  const { id = '' } = useParams()
  const { organizations, currentOrganization } = useOrganizationContext()
  const organizationMatchesApi = matchesProductApiOrganization(organizations, currentOrganization)
  const product = useQuery({
    queryKey: ['product', currentOrganization?.id, id],
    queryFn: () => api<Product>(`/api/products/${encodeURIComponent(id)}`),
    enabled: Boolean(id && organizationMatchesApi),
    retry: false,
  })
  const timeline = useQuery({
    queryKey: ['product-timeline', currentOrganization?.id, id],
    queryFn: () => api<TimelineData>(`/api/traceability/products/${encodeURIComponent(id)}`),
    enabled: Boolean(id && organizationMatchesApi),
    retry: false,
  })

  return <ProductApiScopeNotice>{product.isPending ? <div className="surface module-empty">Loading product...</div> : product.isError ? <section className="surface product-error-state"><div className="catalog-empty-mark"><AlertTriangle size={21} /></div><h2>{product.error.message === 'Product not found' ? 'Product not found' : product.error.message.toLowerCase().includes('permission') || product.error.message.toLowerCase().includes('forbidden') ? 'Access restricted' : 'Product unavailable'}</h2><p>{product.error.message}</p><Link className="button button-secondary" to="/products">Back to products</Link></section> : product.data ? <ProductDetail product={product.data} timeline={timeline.data} timelineLoading={timeline.isPending} timelineError={timeline.error} /> : null}</ProductApiScopeNotice>
}

function ProductDetail({ product, timeline, timelineLoading, timelineError }: { product: Product; timeline: TimelineData | undefined; timelineLoading: boolean; timelineError: Error | null }) {
  return <>
    <section className="page-heading product-detail-heading"><div><div className="eyebrow"><span className="eyebrow-line" />PRODUCT IDENTITY · {product.traceId}</div><h1>{product.brandName}</h1><p>{product.genericName} · {product.dosageForm} · {product.strength}</p></div><div className="product-detail-actions"><Link className="button button-secondary" to="/products">Back to products</Link><ProductQrAction product={product} /><Link className="button button-primary" to={`/products/${product.id}/edit`}><Pencil size={15} />Edit product</Link></div></section>
    <TraceabilityTimeline timeline={timeline} loading={timelineLoading} error={timelineError} />
    <div className="operations-inline-link"><Link className="text-button" to={`/documents?productId=${encodeURIComponent(product.id)}`}><FileCheck2 size={14} />Product documents and certificates<ArrowRight size={14} /></Link></div>
    <div className="product-detail-grid">
      <section className="surface product-detail-panel"><div className="section-heading"><div><span className="section-kicker">PRODUCT IDENTITY</span><h2>Pharmaceutical information</h2></div><span className={`status-pill status-${product.status.toLowerCase()}`}>{product.status.replaceAll('_', ' ')}</span></div><dl className="product-details"><div><dt>Trace ID</dt><dd className="trace-id">{product.traceId ?? 'Not assigned'}</dd></div><div><dt>Generic name</dt><dd>{product.genericName}</dd></div><div><dt>Brand name</dt><dd>{product.brandName}</dd></div><div><dt>Dosage form</dt><dd>{product.dosageForm}</dd></div><div><dt>Strength</dt><dd>{product.strength}</dd></div><div><dt>Active ingredients</dt><dd>{product.activeIngredients}</dd></div><div><dt>Pharmaceutical category</dt><dd>{product.pharmaceuticalCategory.replaceAll('_', ' ')}</dd></div><div><dt>Prescription required</dt><dd>{product.prescriptionRequired ? 'Yes' : 'No'}</dd></div><div><dt>Pack size</dt><dd>{product.packSize} {product.unit}</dd></div><div><dt>Package type</dt><dd>{product.packageType}</dd></div><div><dt>Shelf life</dt><dd>{product.shelfLifeMonths} months</dd></div><div><dt>Description</dt><dd>{product.description || '—'}</dd></div></dl></section>
      <div className="product-detail-side"><section className="surface product-detail-panel"><span className="section-kicker">MANUFACTURER</span><h2 className="detail-subheading">{product.manufacturer}</h2><dl className="product-details"><div><dt>Manufacturer license</dt><dd>{product.manufacturerLicenseNumber}</dd></div><div><dt>Country of manufacture</dt><dd>{product.countryOfManufacture}</dd></div><div><dt>Regulatory approval</dt><dd>{product.regulatoryApprovalNumber}</dd></div></dl></section><section className="surface product-detail-panel"><span className="section-kicker">STORAGE REQUIREMENTS</span><dl className="product-details"><div><dt>Storage conditions</dt><dd>{product.storageConditions}</dd></div><div><dt>Temperature range</dt><dd>{product.temperatureRange}</dd></div><div><dt>Humidity requirement</dt><dd>{product.humidityRequirement}</dd></div></dl></section><div className="product-disclaimer"><ShieldQuestion size={15} /><span>Product traceability records do not themselves establish regulatory approval, product quality, authenticity, or medical safety.</span></div></div>
    </div>
  </>
}

function ProductFormPage() {
  const { id = '' } = useParams()
  const editing = Boolean(id)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { organizations, currentOrganization } = useOrganizationContext()
  const organizationMatchesApi = matchesProductApiOrganization(organizations, currentOrganization)
  const [formData, setFormData] = useState<Partial<ProductForm>>({ pharmaceuticalCategory: 'PRESCRIPTION', prescriptionRequired: false, unit: 'tablet', status: 'ACTIVE', description: '' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [submitError, setSubmitError] = useState('')
  const [saving, setSaving] = useState(false)
  const existing = useQuery({
    queryKey: ['product', currentOrganization?.id, id],
    queryFn: () => api<Product>(`/api/products/${encodeURIComponent(id)}`),
    enabled: editing && organizationMatchesApi,
    retry: false,
  })
  useEffect(() => {
    if (existing.data) setFormData({
      ...existing.data,
      pharmaceuticalCategory: existing.data.pharmaceuticalCategory as ProductForm['pharmaceuticalCategory'],
      status: existing.data.status as ProductForm['status'],
    })
  }, [existing.data])

  const fields: Array<{ name: keyof ProductForm; label: string; type?: string; options?: string[]; wide?: boolean; placeholder?: string }> = [
    { name: 'genericName', label: 'Generic name' }, { name: 'brandName', label: 'Brand name' },
    { name: 'dosageForm', label: 'Dosage form', options: ['Tablet', 'Capsule', 'Oral solution', 'Injection', 'Topical cream', 'Inhaler', 'Eye drops', 'Vaccine'] }, { name: 'strength', label: 'Strength', placeholder: 'e.g. 500 mg' },
    { name: 'activeIngredients', label: 'Active ingredient(s)', wide: true },
    { name: 'pharmaceuticalCategory', label: 'Pharmaceutical category', options: ['PRESCRIPTION', 'OTC', 'VACCINE', 'BIOLOGIC', 'MEDICAL_GAS'] },
    { name: 'manufacturer', label: 'Manufacturer' }, { name: 'manufacturerLicenseNumber', label: 'Manufacturer license number' },
    { name: 'regulatoryApprovalNumber', label: 'Regulatory approval number' }, { name: 'storageConditions', label: 'Storage conditions' },
    { name: 'temperatureRange', label: 'Temperature range', placeholder: 'e.g. 2–8 °C' }, { name: 'humidityRequirement', label: 'Humidity requirement' },
    { name: 'shelfLifeMonths', label: 'Shelf life (months)', type: 'number' }, { name: 'unit', label: 'Unit', options: ['tablet', 'capsule', 'vial', 'bottle', 'ampoule', 'dose', 'pack'] },
    { name: 'packSize', label: 'Pack size', type: 'number' }, { name: 'packageType', label: 'Package type', options: ['Blister pack', 'Bottle', 'Vial', 'Ampoule', 'Carton', 'Sachet', 'Prefilled syringe'] },
    { name: 'countryOfManufacture', label: 'Country of manufacture' }, { name: 'status', label: 'Status', options: ['ACTIVE', 'INACTIVE', 'UNDER_REVIEW'] },
    { name: 'description', label: 'Description', wide: true },
  ]

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const parsed = productSchema.safeParse(formData)
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((issue) => [String(issue.path[0]), issue.message])))
      return
    }
    setErrors({})
    setSubmitError('')
    setSaving(true)
    try {
      const saved = await api<Product>(editing ? `/api/products/${encodeURIComponent(id)}` : '/api/products', {
        method: editing ? 'PATCH' : 'POST',
        body: JSON.stringify(parsed.data),
      })
      await queryClient.invalidateQueries({ queryKey: ['products'] })
      await queryClient.invalidateQueries({ queryKey: ['product', currentOrganization?.id, id] })
      navigate(`/products/${saved.id}`)
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : `Product could not be ${editing ? 'updated' : 'created'}`)
    } finally {
      setSaving(false)
    }
  }

  return <ProductApiScopeNotice>{editing && existing.isPending ? <div className="surface module-empty">Loading product...</div> : editing && existing.isError ? <section className="surface product-error-state"><h2>{existing.error.message}</h2><Link className="button button-secondary" to="/products">Back to products</Link></section> : <>
    <section className="page-heading products-heading"><div><div className="eyebrow"><span className="eyebrow-line" />PRODUCT CATALOG</div><h1>{editing ? 'Edit product' : 'Create product'}</h1><p>{editing ? 'Update pharmaceutical identity details.' : 'Register a pharmaceutical product identity.'}</p></div><Link className="button button-secondary" to={editing ? `/products/${id}` : '/products'}>Cancel</Link></section>
    {editing && existing.data?.traceId && <div className="product-form-trace"><span>TRACE ID</span><code>{existing.data.traceId}</code><small>Trace ID is assigned by TrustTrace and cannot be edited.</small></div>}
    <form className="surface product-form" onSubmit={submit} noValidate><div className="modal-fields">
      {fields.map(({ name, label, type, options, wide, placeholder }) => <label className={`field ${wide ? 'field-wide' : ''}`} key={name}><span>{label}{name !== 'description' && <small className="required-indicator">Required</small>}</span>{options ? <select value={String(formData[name] ?? '')} onChange={(event) => setFormData({ ...formData, [name]: event.target.value })}><option value="" disabled>Select {label.toLowerCase()}</option>{options.map((option) => <option key={option} value={option}>{option.replaceAll('_', ' ')}</option>)}</select> : name === 'description' ? <textarea rows={3} value={String(formData[name] ?? '')} onChange={(event) => setFormData({ ...formData, [name]: event.target.value })} placeholder="Optional product description" /> : <input type={type ?? 'text'} value={String(formData[name] ?? '')} onChange={(event) => setFormData({ ...formData, [name]: type === 'number' ? Number(event.target.value) : event.target.value })} placeholder={placeholder} />}{errors[name] && <small className="field-error">{errors[name]}</small>}</label>)}
      <label className="prescription-toggle field-wide"><input type="checkbox" checked={Boolean(formData.prescriptionRequired)} onChange={(event) => setFormData({ ...formData, prescriptionRequired: event.target.checked })} /><span><strong>Prescription required</strong><small>Dispensing requires a valid prescription.</small></span></label>
    </div>{submitError && <div className="form-error" role="alert"><AlertTriangle size={15} />{submitError}</div>}<div className="modal-actions"><button type="submit" className="button button-primary" disabled={saving}>{saving ? 'Saving...' : editing ? 'Save changes' : 'Create product'}</button></div></form>
  </>}</ProductApiScopeNotice>
}

function BatchesPage() {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const { currentOrganization } = useOrganizationContext()
  const batches = useQuery({
    queryKey: ['batches', currentOrganization?.id, search, status],
    queryFn: () => {
      const params = new URLSearchParams()
      if (search.trim()) params.set('search', search.trim())
      if (status) params.set('status', status)
      return api<{ items: BatchRecord[]; total: number }>(`/api/batches${params.size ? `?${params}` : ''}`)
    },
    enabled: Boolean(currentOrganization),
    retry: false,
  })
  return <>
    <section className="page-heading products-heading"><div><div className="eyebrow"><span className="eyebrow-line" />LOT MANAGEMENT</div><h1>Batches</h1><p>Manufacturing lots, quality status and expiry.</p></div><Link className="button button-primary" to="/batches/new"><Plus size={16} />Create batch</Link></section>
    <div className="catalog-toolbar"><label className="catalog-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search batch or product" aria-label="Search batches" /></label><select className="catalog-filter" value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Filter by batch status"><option value="">All statuses</option>{['MANUFACTURED', 'QUALITY_CHECK', 'APPROVED', 'QUARANTINED', 'IN_WAREHOUSE', 'DISPATCHED', 'IN_TRANSIT', 'DELIVERED', 'EXPIRED', 'DAMAGED'].map((item) => <option key={item} value={item}>{item.replaceAll('_', ' ')}</option>)}</select><button className="button button-secondary" onClick={() => void batches.refetch()} disabled={batches.isFetching}><RotateCw size={15} />Refresh</button></div>
    {batches.isError && <div className="connection-alert" role="alert"><AlertTriangle size={16} />{batches.error.message}</div>}
    <div className="surface products-table-wrap"><div className="table-head batch-columns"><span>BATCH</span><span>PRODUCT</span><span>QUALITY</span><span>QUANTITY</span><span>EXPIRY</span><span>STATUS</span><span /></div>{batches.isPending ? <div className="catalog-empty"><span className="number-loading" /><span className="table-muted">Loading batches...</span></div> : batches.data?.items.length ? batches.data.items.map((batch) => <div className="table-row batch-columns" key={batch.id}><Link className="table-link" to={`/batches/${batch.id}`}><strong>{batch.batchNumber}</strong><small>{batch.product.traceId ?? 'No product Trace ID'}</small></Link><span className="table-muted">{batch.product.name}</span><span className={`status-pill status-${batch.qualityStatus.toLowerCase()}`}>{batch.qualityStatus}</span><span className="table-muted">{batch.available.toLocaleString()} available</span><span className={`table-muted ${new Date(batch.expiryDate) <= new Date() ? 'text-expired' : ''}`}>{new Date(batch.expiryDate).toLocaleDateString()}</span><span className={`status-pill status-${batch.status.toLowerCase()}`}>{batch.status.replaceAll('_', ' ')}</span><Link className="row-action" aria-label={`View batch ${batch.batchNumber}`} to={`/batches/${batch.id}`}><ArrowRight size={16} /></Link></div>) : batches.isError ? null : <div className="catalog-empty"><div className="catalog-empty-mark"><Boxes size={22} /></div><span className="section-kicker">BATCH RECORDS</span><h2>{search || status ? 'No matching batches' : 'No batches created'}</h2><p>{search || status ? 'Change the search or status filter.' : 'Create a batch for an existing pharmaceutical product. No batches are preloaded.'}</p>{!search && !status && <Link className="button button-primary" to="/batches/new"><Plus size={16} />Create batch</Link>}</div>}</div>
    {batches.data && <div className="table-pagination"><span>{batches.data.total} batches</span><span>Showing latest 50</span></div>}
  </>
}

function BatchFormPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { currentOrganization } = useOrganizationContext()
  const products = useQuery({ queryKey: ['products', currentOrganization?.id, 'batch-form'], queryFn: () => api<{ items: Product[] }>('/api/products'), enabled: Boolean(currentOrganization) })
  const [values, setValues] = useState({ productId: '', batchNumber: '', manufacturingDate: '', expiryDate: '', quantityManufactured: '', manufacturingLocation: '', storageLocation: '', unitCost: '', sellingPrice: '', currency: 'USD' })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    if (new Date(values.manufacturingDate) > new Date(values.expiryDate)) { setError('Expiry date must be on or after manufacturing date.'); return }
    if (Number(values.quantityManufactured) <= 0) { setError('Quantity manufactured must be greater than zero.'); return }
    setSaving(true)
    try {
      const batch = await api<BatchRecord>('/api/batches', { method: 'POST', body: JSON.stringify({ ...values, quantityManufactured: Number(values.quantityManufactured), unitCost: values.unitCost ? Number(values.unitCost) : null, sellingPrice: values.sellingPrice ? Number(values.sellingPrice) : null }) })
      await queryClient.invalidateQueries({ queryKey: ['batches'] })
      navigate(`/batches/${batch.id}`)
    } catch (submitError) { setError(submitError instanceof Error ? submitError.message : 'Batch could not be created') }
    finally { setSaving(false) }
  }
  return <><section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" />NEW LOT</div><h1>Create batch</h1><p>Register a manufacturing lot for a product in this organization.</p></div><Link className="button button-secondary" to="/batches">Cancel</Link></section>{products.isError && <div className="connection-alert"><AlertTriangle size={16} />Products could not be loaded.</div>}<form className="surface product-form" onSubmit={submit}><div className="modal-fields">
    <label className="field field-wide"><span>Product</span><select required value={values.productId} onChange={(event) => setValues({ ...values, productId: event.target.value })}><option value="" disabled>Select a pharmaceutical product</option>{products.data?.items.map((product) => <option key={product.id} value={product.id}>{product.brandName} · {product.genericName}</option>)}</select></label>
    <label className="field"><span>Batch number</span><input required value={values.batchNumber} onChange={(event) => setValues({ ...values, batchNumber: event.target.value })} /></label><label className="field"><span>Quantity manufactured</span><input type="number" min="1" step="1" required value={values.quantityManufactured} onChange={(event) => setValues({ ...values, quantityManufactured: event.target.value })} /></label>
    <label className="field"><span>Manufacturing date</span><input type="date" required value={values.manufacturingDate} onChange={(event) => setValues({ ...values, manufacturingDate: event.target.value })} /></label><label className="field"><span>Expiry date</span><input type="date" required value={values.expiryDate} onChange={(event) => setValues({ ...values, expiryDate: event.target.value })} /></label>
    <label className="field"><span>Manufacturing location</span><input required value={values.manufacturingLocation} onChange={(event) => setValues({ ...values, manufacturingLocation: event.target.value })} /></label><label className="field"><span>Storage location</span><input value={values.storageLocation} onChange={(event) => setValues({ ...values, storageLocation: event.target.value })} /></label>
    <label className="field"><span>Unit cost</span><input type="number" min="0" step="0.0001" value={values.unitCost} onChange={(event) => setValues({ ...values, unitCost: event.target.value })} /></label><label className="field"><span>Selling price</span><input type="number" min="0" step="0.0001" value={values.sellingPrice} onChange={(event) => setValues({ ...values, sellingPrice: event.target.value })} /></label><label className="field"><span>Currency</span><input maxLength={3} minLength={3} required value={values.currency} onChange={(event) => setValues({ ...values, currency: event.target.value.toUpperCase() })} /></label>
  </div>{error && <div className="form-error" role="alert"><AlertTriangle size={15} />{error}</div>}<div className="modal-actions"><button className="button button-primary" disabled={saving || products.isPending || !products.data?.items.length}>{saving ? 'Creating...' : 'Create batch'}</button></div></form></>
}

function BatchDetailPage() {
  const { id = '' } = useParams()
  const { currentOrganization } = useOrganizationContext()
  const queryClient = useQueryClient()
  const batch = useQuery({ queryKey: ['batch', currentOrganization?.id, id], queryFn: () => api<BatchRecord>(`/api/batches/${encodeURIComponent(id)}`), enabled: Boolean(currentOrganization && id), retry: false })
  const timeline = useQuery({ queryKey: ['batch-timeline', currentOrganization?.id, id], queryFn: () => api<TimelineData>(`/api/traceability/batches/${encodeURIComponent(id)}`), enabled: Boolean(currentOrganization && id), retry: false })
  const [qualityError, setQualityError] = useState('')
  const [checking, setChecking] = useState(false)
  const qualityCheck = async (result: 'PASS' | 'FAIL') => {
    if (result === 'FAIL' && !window.confirm('Fail and quarantine this batch? This cannot be undone from this screen.')) return
    setChecking(true); setQualityError('')
    try { await api(`/api/batches/${encodeURIComponent(id)}/quality-checks`, { method: 'POST', body: JSON.stringify({ result }) }); await queryClient.invalidateQueries({ queryKey: ['batch', currentOrganization?.id, id] }); await queryClient.invalidateQueries({ queryKey: ['batches'] }); await queryClient.invalidateQueries({ queryKey: ['batch-timeline', currentOrganization?.id, id] }) }
    catch (error) { setQualityError(error instanceof Error ? error.message : 'Quality check could not be recorded') }
    finally { setChecking(false) }
  }
  if (batch.isPending) return <div className="surface module-empty">Loading batch...</div>
  if (batch.isError) return <section className="surface product-error-state"><h2>{batch.error.message}</h2><Link className="button button-secondary" to="/batches">Back to batches</Link></section>
  const item = batch.data
  return <><section className="page-heading product-detail-heading"><div><div className="eyebrow"><span className="eyebrow-line" />BATCH · {item.batchNumber}</div><h1>{item.product.name}</h1><p>{item.product.genericName} · {item.product.traceId ?? 'No Trace ID'}</p></div><div className="product-detail-actions"><Link className="button button-secondary" to="/batches">Back to batches</Link><Link className="button button-secondary" to={`/documents?batchId=${encodeURIComponent(item.id)}`}>Documents</Link></div></section><TraceabilityTimeline timeline={timeline.data} loading={timeline.isPending} error={timeline.error} />
    <div className="product-detail-grid"><section className="surface product-detail-panel"><div className="section-heading"><div><span className="section-kicker">BATCH RECORD</span><h2>{item.batchNumber}</h2></div><span className={`status-pill status-${item.status.toLowerCase()}`}>{item.status.replaceAll('_', ' ')}</span></div><dl className="product-details"><div><dt>Product</dt><dd>{item.product.name}</dd></div><div><dt>Batch number</dt><dd>{item.batchNumber}</dd></div><div><dt>Manufacturing date</dt><dd>{new Date(item.manufacturingDate).toLocaleDateString()}</dd></div><div><dt>Expiry date</dt><dd>{new Date(item.expiryDate).toLocaleDateString()}</dd></div><div><dt>Manufactured</dt><dd>{item.quantityManufactured}</dd></div><div><dt>Available</dt><dd>{item.available}</dd></div><div><dt>Reserved / dispatched</dt><dd>{item.reserved} / {item.dispatched}</dd></div><div><dt>Delivered</dt><dd>{item.delivered}</dd></div><div><dt>Quality</dt><dd>{item.qualityStatus}</dd></div><div><dt>Manufacturing location</dt><dd>{item.manufacturingLocation}</dd></div><div><dt>Storage location</dt><dd>{item.storageLocation ?? 'Not assigned'}</dd></div></dl></section>
      <section className="surface product-detail-panel"><span className="section-kicker">QUALITY CONTROL</span><h2 className="detail-subheading">Record quality result</h2><p className="table-muted">A pass makes this batch eligible for approved inventory and dispatch.</p>{qualityError && <div className="form-error" role="alert">{qualityError}</div>}<div className="modal-actions"><button className="button button-secondary" disabled={checking} onClick={() => void qualityCheck('FAIL')}>Fail / quarantine</button><button className="button button-primary" disabled={checking} onClick={() => void qualityCheck('PASS')}>Pass / approve</button></div></section></div>
  </>
}

function InventoryPage() {
  const { currentOrganization } = useOrganizationContext()
  const queryClient = useQueryClient()
  const inventory = useQuery({ queryKey: ['inventory', currentOrganization?.id], queryFn: () => api<{ items: InventoryRow[] }>('/api/inventory'), enabled: Boolean(currentOrganization), retry: false })
  const batches = useQuery({ queryKey: ['batches', currentOrganization?.id, 'inventory-select'], queryFn: () => api<{ items: BatchRecord[] }>('/api/batches'), enabled: Boolean(currentOrganization), retry: false })
  const [mode, setMode] = useState<'receive' | 'transfer'>('receive')
  const [batchId, setBatchId] = useState('')
  const [locationName, setLocationName] = useState('')
  const [locationId, setLocationId] = useState('')
  const [destinationId, setDestinationId] = useState('')
  const [quantity, setQuantity] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const locations = [...new Map((inventory.data?.items ?? []).map((item) => [item.locationId, { id: item.locationId, name: item.locationName }])).values()]
  const selectedRows = (inventory.data?.items ?? []).filter((item) => item.batchId === batchId)
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError(''); setNotice(''); setSaving(true)
    try {
      if (mode === 'receive') await api('/api/inventory/receive', { method: 'POST', body: JSON.stringify({ batchId, locationName, quantity: Number(quantity) }) })
      else await api('/api/inventory/transfer', { method: 'POST', body: JSON.stringify({ batchId, fromLocationId: locationId, toLocationId: destinationId, quantity: Number(quantity) }) })
      setNotice(mode === 'receive' ? 'Inventory received.' : 'Inventory transfer completed.')
      setQuantity(''); await queryClient.invalidateQueries({ queryKey: ['inventory'] }); await queryClient.invalidateQueries({ queryKey: ['batches'] })
    } catch (submitError) { setError(submitError instanceof Error ? submitError.message : 'Inventory action failed') }
    finally { setSaving(false) }
  }
  return <><section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" />STOCK CONTROL</div><h1>Inventory</h1><p>Available and reserved quantities by approved batch and location.</p></div></section>
    <section className="surface inventory-action"><div className="section-heading"><div><span className="section-kicker">INVENTORY MOVEMENT</span><h2>{mode === 'receive' ? 'Receive approved batch' : 'Transfer stock'}</h2></div><div className="mode-switch"><button className={mode === 'receive' ? 'selected' : ''} onClick={() => { setMode('receive'); setError(''); setNotice('') }}>Receive</button><button className={mode === 'transfer' ? 'selected' : ''} onClick={() => { setMode('transfer'); setError(''); setNotice('') }}>Transfer</button></div></div><form className="inventory-form" onSubmit={submit}><label className="field"><span>Approved batch</span><select required value={batchId} onChange={(event) => { setBatchId(event.target.value); setLocationId('') }}><option value="" disabled>Select batch</option>{(batches.data?.items ?? []).filter((batch) => batch.qualityStatus === 'PASSED' && ['APPROVED', 'IN_WAREHOUSE'].includes(batch.status)).map((batch) => <option key={batch.id} value={batch.id}>{batch.batchNumber} · {batch.product.name}</option>)}</select></label>{mode === 'receive' ? <label className="field"><span>Location</span><input required minLength={2} value={locationName} onChange={(event) => setLocationName(event.target.value)} placeholder="Warehouse or storage location" /></label> : <><label className="field"><span>From location</span><select required value={locationId} onChange={(event) => setLocationId(event.target.value)}><option value="" disabled>Select source</option>{selectedRows.map((row) => <option key={row.locationId} value={row.locationId}>{row.locationName} · {row.available} available</option>)}</select></label><label className="field"><span>To location</span><select required value={destinationId} onChange={(event) => setDestinationId(event.target.value)}><option value="" disabled>Select destination</option>{locations.filter((location) => location.id !== locationId).map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}</select></label></>}<label className="field"><span>Quantity</span><input required type="number" min="1" step="1" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label><button className="button button-primary" disabled={saving || !batchId}>{saving ? 'Saving...' : mode === 'receive' ? 'Receive stock' : 'Transfer stock'}</button></form>{notice && <div className="inline-success">{notice}</div>}{error && <div className="form-error" role="alert">{error}</div>}</section>
    {inventory.isError && <div className="connection-alert" role="alert"><AlertTriangle size={16} />{inventory.error.message}</div>}<div className="surface products-table-wrap inventory-table"><div className="table-head inventory-columns"><span>BATCH</span><span>PRODUCT</span><span>LOCATION</span><span>ON HAND</span><span>RESERVED</span><span>AVAILABLE</span></div>{inventory.isPending ? <div className="catalog-empty">Loading inventory...</div> : inventory.data?.items.length ? inventory.data.items.map((item) => <div className="table-row inventory-columns" key={item.id}><Link className="table-link" to={`/batches/${item.batchId}`}><strong>{item.batchNumber}</strong><small>{item.traceId ?? 'No Trace ID'}</small></Link><span className="table-muted">{item.productName}</span><span className="table-muted">{item.locationName}</span><span className="table-muted">{item.onHand}</span><span className="table-muted">{item.reserved}</span><strong className="table-muted">{item.available}</strong></div>) : <div className="catalog-empty"><div className="catalog-empty-mark"><ClipboardList size={22} /></div><h2>No inventory recorded</h2><p>Quality-approved batch receipts will appear here.</p></div>}</div>
  </>
}

function ShipmentsPage() {
  const { currentOrganization } = useOrganizationContext()
  const shipments = useQuery({ queryKey: ['shipments', currentOrganization?.id], queryFn: () => api<{ items: ShipmentRow[] }>('/api/shipments'), enabled: Boolean(currentOrganization), retry: false })
  return <><section className="page-heading products-heading"><div><div className="eyebrow"><span className="eyebrow-line" />DISTRIBUTION</div><h1>Shipments</h1><p>Track dispatched, in-transit and delivered batches.</p></div><Link className="button button-primary" to="/shipments/new"><Plus size={16} />Create shipment</Link></section>{shipments.isError && <div className="connection-alert" role="alert"><AlertTriangle size={16} />{shipments.error.message}</div>}<div className="surface products-table-wrap"><div className="table-head shipment-columns"><span>REFERENCE</span><span>DESTINATION</span><span>ITEMS</span><span>CREATED</span><span>STATUS</span><span /></div>{shipments.isPending ? <div className="catalog-empty">Loading shipments...</div> : shipments.data?.items.length ? shipments.data.items.map((shipment) => <div className="table-row shipment-columns" key={shipment.id}><Link className="table-link" to={`/shipments/${shipment.id}`}><strong>{shipment.trackingNumber}</strong><small>{shipment.items.map((item) => item.batchNumber).join(', ')}</small></Link><span className="table-muted">{shipment.destination}</span><span className="table-muted">{shipment.items.length}</span><span className="table-muted">{new Date(shipment.createdAt).toLocaleDateString()}</span><span className={`status-pill status-${shipment.status.toLowerCase()}`}>{shipment.status.replaceAll('_', ' ')}</span><Link className="row-action" to={`/shipments/${shipment.id}`} aria-label={`View ${shipment.trackingNumber}`}><ArrowRight size={16} /></Link></div>) : <div className="catalog-empty"><div className="catalog-empty-mark"><Truck size={22} /></div><h2>No shipments yet</h2><p>Shipment records will appear here after they are created. No sample shipments are preloaded.</p><Link className="button button-primary" to="/shipments/new"><Plus size={16} />Create shipment</Link></div>}</div></>
}

function ShipmentFormPage() {
  const navigate = useNavigate()
  const { currentOrganization } = useOrganizationContext()
  const batches = useQuery({ queryKey: ['batches', currentOrganization?.id, 'shipment-form'], queryFn: () => api<{ items: BatchRecord[] }>('/api/batches'), enabled: Boolean(currentOrganization) })
  const [destination, setDestination] = useState('')
  const [batchId, setBatchId] = useState('')
  const [quantity, setQuantity] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError(''); setSaving(true)
    try {
      const shipment = await api<ShipmentRow>('/api/shipments', { method: 'POST', body: JSON.stringify({ destination, items: [{ batchId, quantity: Number(quantity) }] }) })
      navigate(`/shipments/${shipment.id}`)
    } catch (submitError) { setError(submitError instanceof Error ? submitError.message : 'Shipment could not be created') }
    finally { setSaving(false) }
  }
  return <><section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" />NEW SHIPMENT</div><h1>Create shipment</h1><p>Prepare a shipment from quality-approved, available inventory.</p></div><Link className="button button-secondary" to="/shipments">Cancel</Link></section>{batches.isError && <div className="connection-alert"><AlertTriangle size={16} />{batches.error.message}</div>}<form className="surface product-form shipment-form" onSubmit={submit}><div className="modal-fields"><label className="field field-wide"><span>Destination</span><input required minLength={2} maxLength={500} value={destination} onChange={(event) => setDestination(event.target.value)} placeholder="Recipient facility or destination" /></label><label className="field field-wide"><span>Approved batch</span><select required value={batchId} onChange={(event) => setBatchId(event.target.value)}><option value="" disabled>Select an approved batch</option>{(batches.data?.items ?? []).filter((batch) => batch.qualityStatus === 'PASSED' && ['APPROVED', 'IN_WAREHOUSE'].includes(batch.status) && new Date(batch.expiryDate) > new Date() && batch.available > 0).map((batch) => <option key={batch.id} value={batch.id}>{batch.batchNumber} · {batch.product.name} · {batch.available} available</option>)}</select></label><label className="field"><span>Quantity</span><input required type="number" min="1" step="1" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label></div>{error && <div className="form-error" role="alert"><AlertTriangle size={15} />{error}</div>}<div className="modal-actions"><button className="button button-primary" disabled={saving || batches.isPending}>{saving ? 'Creating...' : 'Create shipment draft'}</button></div></form></>
}

function ShipmentDetailPage() {
  const { id = '' } = useParams()
  const { currentOrganization } = useOrganizationContext()
  const queryClient = useQueryClient()
  const shipment = useQuery({ queryKey: ['shipment', currentOrganization?.id, id], queryFn: () => api<ShipmentRow>(`/api/shipments/${encodeURIComponent(id)}`), enabled: Boolean(currentOrganization && id), retry: false })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const dispatch = async () => {
    if (!window.confirm('Dispatch this shipment and deduct its inventory?')) return
    setError(''); setSaving(true)
    try { await api(`/api/shipments/${encodeURIComponent(id)}/dispatch`, { method: 'POST' }); await queryClient.invalidateQueries({ queryKey: ['shipment', currentOrganization?.id, id] }); await queryClient.invalidateQueries({ queryKey: ['shipments'] }); await queryClient.invalidateQueries({ queryKey: ['inventory'] }); await queryClient.invalidateQueries({ queryKey: ['batches'] }) }
    catch (actionError) { setError(actionError instanceof Error ? actionError.message : 'Shipment could not be dispatched') }
    finally { setSaving(false) }
  }
  const advance = async (status: 'IN_TRANSIT' | 'OUT_FOR_DELIVERY' | 'DELIVERED') => {
    setError(''); setSaving(true)
    try { await api(`/api/shipments/${encodeURIComponent(id)}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }); await queryClient.invalidateQueries({ queryKey: ['shipment', currentOrganization?.id, id] }); await queryClient.invalidateQueries({ queryKey: ['shipments'] }); await queryClient.invalidateQueries({ queryKey: ['batch-timeline'] }); await queryClient.invalidateQueries({ queryKey: ['batches'] }) }
    catch (actionError) { setError(actionError instanceof Error ? actionError.message : 'Shipment status could not be updated') }
    finally { setSaving(false) }
  }
  if (shipment.isPending) return <div className="surface module-empty">Loading shipment...</div>
  if (shipment.isError) return <section className="surface product-error-state"><h2>{shipment.error.message}</h2><Link className="button button-secondary" to="/shipments">Back to shipments</Link></section>
  const item = shipment.data
  const next = item.status === 'DISPATCHED' ? 'IN_TRANSIT' : item.status === 'IN_TRANSIT' ? 'OUT_FOR_DELIVERY' : item.status === 'OUT_FOR_DELIVERY' ? 'DELIVERED' : null
  return <><section className="page-heading product-detail-heading"><div><div className="eyebrow"><span className="eyebrow-line" />SHIPMENT · {item.trackingNumber}</div><h1>{item.destination}</h1><p>{item.items.length} batch line{item.items.length === 1 ? '' : 's'} · Created {new Date(item.createdAt).toLocaleString()}</p></div><div className="product-detail-actions"><Link className="button button-secondary" to="/shipments">Back to shipments</Link>{item.status === 'DRAFT' || item.status === 'READY' ? <button className="button button-primary" disabled={saving} onClick={() => void dispatch()}>{saving ? 'Dispatching...' : 'Dispatch shipment'}</button> : next ? <button className="button button-primary" disabled={saving} onClick={() => void advance(next)}>{saving ? 'Updating...' : `Mark ${next.replaceAll('_', ' ').toLowerCase()}`}</button> : null}</div></section>{error && <div className="connection-alert" role="alert"><AlertTriangle size={16} />{error}</div>}<div className="product-detail-grid"><section className="surface product-detail-panel"><span className="section-kicker">SHIPMENT ITEMS</span><h2 className="detail-subheading">Batch quantities</h2><div className="shipment-lines">{item.items.map((line) => <div className="shipment-line" key={line.batchId}><span><strong>{line.batchNumber}</strong><small>{line.productName}</small></span><span>{line.quantity} units</span><Link className="row-action" to={`/batches/${line.batchId}`} aria-label={`View batch ${line.batchNumber}`}><ArrowRight size={16} /></Link></div>)}</div></section><section className="surface product-detail-panel"><span className="section-kicker">DELIVERY PROGRESS</span><h2 className="detail-subheading">Status history</h2><div className="shipment-history">{item.statusHistory.map((entry) => <div className="shipment-history-row" key={entry.id}><span className="timeline-marker" /><span><strong>{entry.status.replaceAll('_', ' ')}</strong><small>{entry.note ?? ''}</small><time>{new Date(entry.occurredAt).toLocaleString()}</time></span></div>)}</div></section></div></>
}

function TraceabilityTimeline({ timeline, loading, error }: { timeline: TimelineData | undefined; loading: boolean; error: Error | null }) {
  return <section className="surface timeline-panel"><div className="section-heading"><div><span className="section-kicker">IMMUTABLE EVENT HISTORY</span><h2>Traceability timeline</h2></div><span className={`chain-status ${timeline?.databaseChainVerified ? 'chain-ok' : ''}`}>{loading ? 'CHECKING' : timeline?.databaseChainVerified ? 'CHAIN VERIFIED' : error ? 'UNAVAILABLE' : 'REVIEW'}</span></div>{loading ? <div className="timeline-empty">Loading event history...</div> : error ? <div className="timeline-empty timeline-error">Traceability history could not be loaded. {error.message}</div> : timeline?.events.length ? <div className="timeline-list">{timeline.events.map((event) => <article className="timeline-event" key={event.eventId}><span className="timeline-marker" /><div className="timeline-event-main"><div className="timeline-event-heading"><strong>{event.eventType.replaceAll('_', ' ')}</strong><time>{new Date(event.timestamp).toLocaleString()}</time></div><div className="timeline-event-meta"><span>{event.organizationName}</span><span>{event.actorName ?? 'System'}</span>{event.locationName && <span>{event.locationName}</span>}{event.quantity !== null && <span>{event.quantity} units</span>}<BlockchainAnchorInfo status={event.blockchainStatus} transactionHash={event.blockchainTransactionHash} anchor={event.anchor} /></div><details><summary>Record hashes</summary><code>Current: {event.currentHash}</code><code>Previous: {event.previousHash ?? 'Genesis event'}</code>{event.blockchainTransactionHash && <code>Blockchain transaction: {event.blockchainTransactionHash}</code>}</details></div></article>)}</div> : <div className="timeline-empty">No traceability events recorded yet.</div>}</section>
}

function BlockchainAnchorInfo({ status, transactionHash, anchor }: { status: string; transactionHash: string | null; anchor?: AnchorInfo | null }) {
  const queryClient = useQueryClient()
  const { currentOrganization } = useOrganizationContext()
  const [retrying, setRetrying] = useState(false)
  const [error, setError] = useState('')
  const runtime = useQuery({ queryKey: ['blockchain-status', currentOrganization?.id], queryFn: () => api<{ enabled: boolean; available: boolean }>('/api/blockchain/status'), enabled: Boolean(currentOrganization), staleTime: 60_000, retry: false })
  const blockchainUnavailable = Boolean(runtime.data && (!runtime.data.enabled || !runtime.data.available))
  const organizationRole = currentOrganization?.roleName
  const canRetry = organizationRole === 'OWNER' || organizationRole === 'ADMIN'
  const retry = async () => {
    if (!anchor) return
    setRetrying(true)
    setError('')
    try {
      await api(`/api/blockchain/anchors/${encodeURIComponent(anchor.id)}/retry`, { method: 'POST', body: '{}' })
      await queryClient.invalidateQueries({ queryKey: ['product-timeline'] })
      await queryClient.invalidateQueries({ queryKey: ['batch-timeline'] })
      await queryClient.invalidateQueries({ queryKey: ['blockchain-status'] })
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Blockchain retry failed')
    } finally {
      setRetrying(false)
    }
  }
  const displayedStatus = status === 'ANCHORED' ? 'ANCHORED' : status === 'ANCHOR_FAILED' ? 'ANCHOR_FAILED' : blockchainUnavailable ? 'UNAVAILABLE' : status
  return <span className="blockchain-event-proof"><strong>Blockchain: {displayedStatus === 'ANCHORED' ? 'Anchored' : displayedStatus === 'ANCHOR_FAILED' ? 'Anchor failed' : displayedStatus === 'UNAVAILABLE' ? 'Unavailable' : 'Pending'}</strong>{status === 'ANCHORED' && anchor && <small>{anchor.networkName ?? `Chain ${anchor.chainId ?? 'unknown'}`} · block {anchor.blockNumber ?? '—'}{anchor.contractAddress ? ` · ${anchor.contractAddress}` : ''}</small>}{status === 'ANCHORED' && (anchor?.transactionHash ?? transactionHash) && <code>{anchor?.transactionHash ?? transactionHash}</code>}{status === 'ANCHOR_FAILED' && anchor?.failureCode && <small>{anchor.failureCode}</small>}{canRetry && anchor && status !== 'ANCHORED' && <button className="text-button" disabled={retrying || blockchainUnavailable} onClick={() => void retry()}><RotateCw size={12} />{retrying ? 'Retrying...' : 'Retry anchor'}</button>}{error && <small className="timeline-error">{error}</small>}</span>
}

function ProductQrAction({ product }: { product: Product }) {
  const [qrData, setQrData] = useState('')
  const [open, setOpen] = useState(false)
  const url = `${window.location.origin}/verify/${encodeURIComponent(product.traceId ?? '')}`
  useEffect(() => { if (product.traceId) void QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 2, width: 220 }).then(setQrData).catch(() => setQrData('')) }, [product.traceId, url])
  if (!product.traceId) return null
  return <><button className="button button-secondary" onClick={() => setOpen(true)}><QrCode size={15} />Public QR</button>{open && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}><section className="qr-modal" role="dialog" aria-modal="true" aria-labelledby="product-qr-title"><button className="icon-button qr-close" aria-label="Close QR" onClick={() => setOpen(false)}><X size={18} /></button><span className="section-kicker">PUBLIC PRODUCT IDENTITY</span><h2 id="product-qr-title">{product.brandName}</h2><code>{product.traceId}</code>{qrData && <img src={qrData} alt={`Public verification code for ${product.brandName}`} />}<small>Contains only the public verification URL.</small><Link className="button button-secondary" to={`/verify/${encodeURIComponent(product.traceId)}`} onClick={() => setOpen(false)}>Open verification</Link></section></div>}</>
}

function NotificationCenter({ organizationId }: { organizationId: string | undefined }) {
    const queryClient = useQueryClient()
    const [open, setOpen] = useState(false)
  const unread = useQuery({ queryKey: ['notifications-unread', organizationId], queryFn: () => api<{ unread: number }>('/api/notifications/unread-count'), enabled: Boolean(organizationId), refetchInterval: 60_000, retry: false })
  const notifications = useQuery({ queryKey: ['notifications', organizationId], queryFn: () => api<{ items: NotificationRecord[] }>('/api/notifications'), enabled: Boolean(organizationId && open), retry: false })
    const markRead = async (id?: string) => {
      await api(id ? `/api/notifications/${encodeURIComponent(id)}/read` : '/api/notifications/read-all', { method: 'PATCH' })
      await queryClient.invalidateQueries({ queryKey: ['notifications'] })
      await queryClient.invalidateQueries({ queryKey: ['notifications-unread'] })
    }
    return <div className="notification-wrap"><button className="icon-button notification-button" aria-label="Notifications" aria-expanded={open} onClick={() => setOpen(!open)}><Bell size={18} />{Boolean(unread.data?.unread) && <i />}{unread.data?.unread ? <span className="notification-count">{unread.data.unread}</span> : null}</button>{open && <section className="notification-popover surface"><div className="section-heading"><div><span className="section-kicker">WORKSPACE UPDATES</span><h2>Notifications</h2></div><button className="text-button" onClick={() => void markRead()} disabled={!unread.data?.unread}>Mark all read</button></div>{notifications.isError ? <p className="table-muted">{notifications.error.message}</p> : notifications.isPending ? <p className="table-muted">Loading notifications...</p> : notifications.data?.items.length ? notifications.data.items.map((item) => <button className={`notification-row ${item.readAt ? '' : 'unread'}`} key={item.id} onClick={() => !item.readAt && void markRead(item.id)}><strong>{item.title}</strong><span>{item.body}</span><time>{new Date(item.createdAt).toLocaleString()}</time></button>) : <div className="timeline-empty">No notifications yet.</div>}</section>}</div>
  }

  function ReturnsPage() {
    const { currentOrganization } = useOrganizationContext()
    const returns = useQuery({ queryKey: ['returns', currentOrganization?.id], queryFn: () => api<{ items: ReturnRecord[] }>('/api/returns'), enabled: Boolean(currentOrganization), retry: false })
    return <><section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" />REVERSE LOGISTICS</div><h1>Returns</h1><p>Track delivered goods through receipt, inspection, and approved disposition.</p></div><Link className="button button-primary" to="/returns/new"><Plus size={15} />Request return</Link></section>{returns.isError && <div className="connection-alert" role="alert">{returns.error.message}</div>}{returns.isPending ? <div className="surface module-empty">Loading returns...</div> : returns.data?.items.length ? <section className="surface operations-table"><div className="operations-table-head return-columns"><span>RETURN</span><span>SHIPMENT</span><span>ITEMS</span><span>REASON</span><span>STATUS</span><span>CREATED</span></div>{returns.data.items.map((item) => <Link className="operations-row return-columns" key={item.id} to={`/returns/${item.id}`}><strong>{item.returnNumber}</strong><span>{item.shipment?.trackingNumber ?? '—'}</span><span>{item.items.map((line) => `${line.batch.batchNumber} · ${line.quantity}`).join(', ')}</span><span>{item.reason}</span><span className="status-pill">{item.status.replaceAll('_', ' ')}</span><time>{new Date(item.createdAt).toLocaleDateString()}</time></Link>)}</section> : <div className="surface module-empty"><div className="catalog-empty-mark"><ArrowDownRight size={21} /></div><span className="section-kicker">RETURN REGISTER</span><h2>No returns recorded</h2><p>Return requests will appear here after a delivered shipment is selected.</p></div>}</>
  }

  function ReturnFormPage() {
    const { currentOrganization } = useOrganizationContext()
    const navigate = useNavigate()
    const shipments = useQuery({ queryKey: ['shipments', currentOrganization?.id], queryFn: () => api<{ items: Array<{ id: string; trackingNumber: string; status: string; items: Array<{ batchId: string; batchNumber: string; productName: string; quantity: number }> }> }>('/api/shipments'), enabled: Boolean(currentOrganization), retry: false })
    const delivered = (shipments.data?.items ?? []).filter((shipment) => shipment.status === 'DELIVERED')
    const [shipmentId, setShipmentId] = useState('')
    const [batchId, setBatchId] = useState('')
    const [quantity, setQuantity] = useState('')
    const [reason, setReason] = useState('')
    const [error, setError] = useState('')
    const [saving, setSaving] = useState(false)
    const shipment = delivered.find((item) => item.id === shipmentId)
    const submit = async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault(); setError(''); setSaving(true)
      try { const item = await api<ReturnRecord>('/api/returns', { method: 'POST', body: JSON.stringify({ shipmentId, reason, items: [{ batchId, quantity: Number(quantity) }] }) }); navigate(`/returns/${item.id}`) }
      catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Return request could not be created') }
      finally { setSaving(false) }
    }
    return <><section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" />REVERSE LOGISTICS</div><h1>Request a return</h1><p>Only quantities delivered on this shipment can be requested.</p></div><Link className="button button-secondary" to="/returns">Back to returns</Link></section>{shipments.isError && <div className="connection-alert">{shipments.error.message}</div>}<form className="surface product-form operations-form" onSubmit={submit}><label className="field field-wide"><span>Delivered shipment</span><select required value={shipmentId} onChange={(event) => { setShipmentId(event.target.value); setBatchId('') }}><option value="">Select a delivered shipment</option>{delivered.map((item) => <option key={item.id} value={item.id}>{item.trackingNumber}</option>)}</select></label><label className="field field-wide"><span>Product batch and delivered quantity</span><select required value={batchId} onChange={(event) => setBatchId(event.target.value)} disabled={!shipment}><option value="">Select a shipment item</option>{shipment?.items.map((item) => <option key={item.batchId} value={item.batchId}>{item.batchNumber} · {item.productName} · {item.quantity} delivered</option>)}</select></label><label className="field"><span>Return quantity</span><input type="number" min="1" max={shipment?.items.find((item) => item.batchId === batchId)?.quantity ?? undefined} step="1" required value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label><label className="field field-wide"><span>Return reason</span><textarea rows={3} minLength={2} maxLength={1000} required value={reason} onChange={(event) => setReason(event.target.value)} /></label>{error && <div className="form-error" role="alert">{error}</div>}<div className="modal-actions"><button className="button button-primary" disabled={saving || shipments.isPending || !delivered.length}>{saving ? 'Submitting...' : 'Submit return request'}</button></div></form></>
  }

  function ReturnDetailPage() {
    const { id = '' } = useParams()
    const { currentOrganization } = useOrganizationContext()
    const queryClient = useQueryClient()
    const [error, setError] = useState('')
    const [inspectionOutcome, setInspectionOutcome] = useState('PASS')
    const record = useQuery({ queryKey: ['return', currentOrganization?.id, id], queryFn: () => api<ReturnRecord>(`/api/returns/${encodeURIComponent(id)}`), enabled: Boolean(currentOrganization && id), retry: false })
    const refresh = async () => { await queryClient.invalidateQueries({ queryKey: ['return', currentOrganization?.id, id] }); await queryClient.invalidateQueries({ queryKey: ['returns', currentOrganization?.id] }) }
    const runAction = async (action: string, body?: unknown) => { setError(''); try { await api(`/api/returns/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: JSON.stringify(body ?? {}) }); await refresh() } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Return update failed') } }
    if (record.isPending) return <div className="surface module-empty">Loading return...</div>
    if (record.isError || !record.data) return <section className="surface product-error-state"><h2>Return unavailable</h2><p>{record.error?.message}</p><Link className="button button-secondary" to="/returns">Back to returns</Link></section>
    const item = record.data
    return <><section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" />RETURN · {item.returnNumber}</div><h1>{item.status.replaceAll('_', ' ')}</h1><p>{item.shipment?.trackingNumber ?? 'Shipment unavailable'} · {new Date(item.createdAt).toLocaleString()}</p></div><Link className="button button-secondary" to="/returns">Back to returns</Link></section>{error && <div className="connection-alert" role="alert">{error}</div>}<section className="surface product-detail-panel"><div className="section-heading"><div><span className="section-kicker">RETURN REQUEST</span><h2>{item.reason}</h2></div><span className="status-pill">{item.status}</span></div><div className="operations-list">{item.items.map((line) => <div className="operations-row return-item-row" key={line.id}><span><strong>{line.batch.product.name}</strong><small>{line.batch.batchNumber}</small></span><span>{line.quantity} units</span><span>{line.inspections[0]?.outcome ?? 'NOT INSPECTED'}</span></div>)}</div>{item.status === 'REQUESTED' && <div className="modal-actions"><button className="button button-primary" onClick={() => void runAction('receive')}>Record receipt</button></div>}{item.status === 'RECEIVED' && <div className="return-inspection-controls"><label className="field"><span>Inspection outcome for every item</span><select value={inspectionOutcome} onChange={(event) => setInspectionOutcome(event.target.value)}><option value="PASS">Pass</option><option value="DAMAGED">Damaged</option><option value="REJECTED">Reject</option><option value="RECALLED">Recalled</option></select></label><button className="button button-primary" onClick={() => void runAction('inspect', { inspections: item.items.map((line) => ({ returnItemId: line.id, outcome: inspectionOutcome })) })}>Save inspection outcome</button></div>}{item.status === 'INSPECTING' && <div className="modal-actions"><button className="button button-primary" onClick={() => void runAction('restock')}>Approve and restock</button></div>}{item.status === 'REJECTED' && <p className="table-muted">Rejected, damaged, or recalled returns do not increase inventory.</p>}</section></>
  }

  function DocumentsPage() {
    const location = useLocation()
    const { currentOrganization } = useOrganizationContext()
    const queryClient = useQueryClient()
    const certificateTab = new URLSearchParams(location.search).get('tab') === 'certificates'
    const [name, setName] = useState('')
    const [contentType, setContentType] = useState('application/pdf')
    const [sizeBytes, setSizeBytes] = useState('')
    const [checksum, setChecksum] = useState('')
    const [productId, setProductId] = useState(new URLSearchParams(location.search).get('productId') ?? '')
    const [batchId, setBatchId] = useState(new URLSearchParams(location.search).get('batchId') ?? '')
    const [certificateState, setCertificateState] = useState(false)
    const certificate = certificateTab || certificateState
    const setCertificate = (value: boolean) => setCertificateState(certificateTab ? true : value)
    const [certificateNumber, setCertificateNumber] = useState('')
    const [certificateType, setCertificateType] = useState('Certificate of Analysis')
    const [issuer, setIssuer] = useState('')
    const [isPublic, setIsPublic] = useState(false)
    const [error, setError] = useState('')
    const [saving, setSaving] = useState(false)
    const documents = useQuery({ queryKey: ['documents', currentOrganization?.id, location.search], queryFn: () => api<{ items: DocumentRecord[]; certificates: CertificateRecord[] }>(`/api/documents${location.search}`), enabled: Boolean(currentOrganization), retry: false })
    const submit = async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault(); setError(''); setSaving(true)
      const body = { name, contentType, sizeBytes: Number(sizeBytes), checksum, ...(productId ? { productId } : {}), ...(batchId ? { batchId } : {}), ...(certificate || certificateTab ? { certificate: { certificateNumber, type: certificateType, issuer, isPublic } } : {}) }
      try { await api('/api/documents', { method: 'POST', body: JSON.stringify(body) }); setName(''); setCertificateNumber(''); await queryClient.invalidateQueries({ queryKey: ['documents'] }) }
      catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Document metadata could not be registered') }
      finally { setSaving(false) }
    }
    return <><section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" />CONTROLLED RECORDS</div><h1>Documents & certificates</h1><p>Register authorized supply-chain document metadata and certificate references.</p></div></section><div className="operations-grid"><form className="surface product-detail-panel operations-form" onSubmit={submit}><span className="section-kicker">REGISTER METADATA</span><h2 className="detail-subheading">Document record</h2><p className="table-muted">File contents are not stored or uploaded by this workspace.</p><label className="field"><span>Document name</span><input required minLength={2} maxLength={180} value={name} onChange={(event) => setName(event.target.value)} /></label><label className="field"><span>MIME type</span><input required value={contentType} onChange={(event) => setContentType(event.target.value)} /></label><label className="field"><span>Size in bytes</span><input type="number" min="1" max="100000000" required value={sizeBytes} onChange={(event) => setSizeBytes(event.target.value)} /></label><label className="field"><span>SHA-256 checksum</span><input required minLength={64} maxLength={64} pattern="[a-fA-F0-9]{64}" value={checksum} onChange={(event) => setChecksum(event.target.value)} /></label><label className="field"><span>Product ID (optional)</span><input value={productId} onChange={(event) => setProductId(event.target.value)} /></label><label className="field"><span>Batch ID (optional)</span><input value={batchId} onChange={(event) => setBatchId(event.target.value)} /></label><label className="prescription-toggle"><input type="checkbox" checked={certificate} onChange={(event) => setCertificate(event.target.checked)} /><span><strong>Register a certificate</strong><small>Certificate metadata may be made public for verification.</small></span></label>{certificate && <><label className="field"><span>Certificate number</span><input required value={certificateNumber} onChange={(event) => setCertificateNumber(event.target.value)} /></label><label className="field"><span>Certificate type</span><input required value={certificateType} onChange={(event) => setCertificateType(event.target.value)} /></label><label className="field"><span>Issuer</span><input required value={issuer} onChange={(event) => setIssuer(event.target.value)} /></label><label className="prescription-toggle"><input type="checkbox" checked={isPublic} onChange={(event) => setIsPublic(event.target.checked)} /><span><strong>Public certificate metadata</strong><small>Only the entered certificate metadata will be exposed.</small></span></label></>}{error && <div className="form-error" role="alert">{error}</div>}<button className="button button-primary" disabled={saving}>{saving ? 'Registering...' : 'Register document'}</button></form><section className="surface product-detail-panel"><span className="section-kicker">ORGANIZATION RECORDS</span><h2 className="detail-subheading">Documents and certificates</h2>{documents.isError ? <div className="timeline-empty timeline-error">{documents.error.message}</div> : documents.isPending ? <div className="timeline-empty">Loading documents...</div> : <><div className="operations-list">{documents.data?.items.map((item) => <article className="document-row" key={item.id}><strong>{item.name}</strong><span>{item.contentType} · {item.sizeBytes.toLocaleString()} bytes</span><code>{item.checksum}</code><small>{item.product?.name ?? item.batch?.batchNumber ?? item.shipment?.trackingNumber ?? item.returnRecord?.returnNumber ?? 'Organization record'}</small></article>)}</div><div className="operations-list">{documents.data?.certificates.map((item) => <article className="document-row certificate-row" key={item.id}><strong>{item.certificateNumber} · {item.type}</strong><span>{item.issuer} · {item.status}</span><small>{item.product?.name ?? item.batch?.batchNumber ?? 'Unassociated'}</small><small>{item.isPublic ? 'Public verification metadata enabled' : 'Organization-only metadata'}</small></article>)}</div>{!documents.data?.items.length && !documents.data?.certificates.length && <div className="timeline-empty">No documents or certificates registered.</div>}</>}</section></div></>
  }

  function InvoicesPage() {
    const { currentOrganization } = useOrganizationContext()
    const invoices = useQuery({ queryKey: ['invoices', currentOrganization?.id], queryFn: () => api<{ items: InvoiceRecord[] }>('/api/invoices'), enabled: Boolean(currentOrganization), retry: false })
    return <><section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" />ACCOUNTS RECEIVABLE</div><h1>Invoices</h1><p>Operational invoice, payment, and refund records.</p></div><Link className="button button-primary" to="/invoices/new"><Plus size={15} />Create invoice</Link></section>{invoices.isError && <div className="connection-alert" role="alert">{invoices.error.message}</div>}{invoices.isPending ? <div className="surface module-empty">Loading invoices...</div> : invoices.data?.items.length ? <section className="surface operations-table"><div className="operations-table-head invoice-columns"><span>INVOICE</span><span>STATUS</span><span>TOTAL</span><span>ITEMS</span><span>CREATED</span></div>{invoices.data.items.map((item) => <Link className="operations-row invoice-columns" key={item.id} to={`/invoices/${item.id}`}><strong>{item.invoiceNumber}</strong><span className="status-pill">{item.status.replaceAll('_', ' ')}</span><span>{item.currency} {item.total}</span><span>{item._count?.items ?? '—'}</span><time>{new Date(item.createdAt).toLocaleDateString()}</time></Link>)}</section> : <div className="surface module-empty"><div className="catalog-empty-mark"><FileText size={21} /></div><span className="section-kicker">FINANCE REGISTER</span><h2>No invoices recorded</h2><p>Invoices will appear here after they are created in this organization.</p><Link className="button button-primary" to="/invoices/new"><Plus size={15} />Create invoice</Link></div>}</>
  }

  function InvoiceFormPage() {
    const navigate = useNavigate()
    const { currentOrganization } = useOrganizationContext()
    const [currency, setCurrency] = useState('USD')
    const [items, setItems] = useState([{ description: '', quantity: 1, unitPrice: '' }])
    const [error, setError] = useState('')
    const [saving, setSaving] = useState(false)
    const subtotal = items.reduce((total, item) => total + Number(item.quantity) * Number(item.unitPrice || 0), 0)
    const submit = async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault(); setError(''); setSaving(true)
      try { const invoice = await api<InvoiceRecord>('/api/invoices', { method: 'POST', body: JSON.stringify({ currency, items }) }); navigate(`/invoices/${invoice.id}`) }
      catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Invoice could not be created') }
      finally { setSaving(false) }
    }
    return <><section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" />ACCOUNTS RECEIVABLE</div><h1>Create invoice</h1><p>Totals are calculated on the server from the item lines.</p></div><Link className="button button-secondary" to="/invoices">Back to invoices</Link></section><form className="surface product-form operations-form" onSubmit={submit}><label className="field"><span>Currency</span><input maxLength={3} minLength={3} required value={currency} onChange={(event) => setCurrency(event.target.value.toUpperCase())} /></label><div className="operations-list">{items.map((item, index) => <div className="invoice-line-form" key={index}><label className="field"><span>Description</span><input required minLength={2} value={item.description} onChange={(event) => setItems(items.map((entry, line) => line === index ? { ...entry, description: event.target.value } : entry))} /></label><label className="field"><span>Quantity</span><input type="number" min="1" step="1" required value={item.quantity} onChange={(event) => setItems(items.map((entry, line) => line === index ? { ...entry, quantity: Number(event.target.value) } : entry))} /></label><label className="field"><span>Unit price</span><input type="number" min="0.0001" step="0.0001" required value={item.unitPrice} onChange={(event) => setItems(items.map((entry, line) => line === index ? { ...entry, unitPrice: event.target.value } : entry))} /></label><button className="row-action" type="button" aria-label="Remove invoice line" disabled={items.length === 1} onClick={() => setItems(items.filter((_, line) => line !== index))}><X size={16} /></button></div>)}</div><button type="button" className="button button-secondary" onClick={() => setItems([...items, { description: '', quantity: 1, unitPrice: '' }])}><Plus size={15} />Add invoice item</button><div className="invoice-total-preview"><span>Calculated subtotal</span><strong>{currency} {subtotal.toFixed(2)}</strong></div>{error && <div className="form-error" role="alert">{error}</div>}<div className="modal-actions"><button className="button button-primary" disabled={saving || !currentOrganization}>{saving ? 'Creating...' : 'Create draft invoice'}</button></div></form></>
  }

  function InvoiceDetailPage() {
    const { id = '' } = useParams()
    const { currentOrganization } = useOrganizationContext()
    const queryClient = useQueryClient()
    const [paymentAmount, setPaymentAmount] = useState('')
    const [method, setMethod] = useState('BANK_TRANSFER')
    const [reference, setReference] = useState('')
    const [refundPaymentId, setRefundPaymentId] = useState('')
    const [refundAmount, setRefundAmount] = useState('')
    const [refundReason, setRefundReason] = useState('')
    const [error, setError] = useState('')
    const invoice = useQuery({ queryKey: ['invoice', currentOrganization?.id, id], queryFn: () => api<InvoiceRecord>(`/api/invoices/${encodeURIComponent(id)}`), enabled: Boolean(currentOrganization && id), retry: false })
    const refresh = async () => { await queryClient.invalidateQueries({ queryKey: ['invoice', currentOrganization?.id, id] }); await queryClient.invalidateQueries({ queryKey: ['invoices', currentOrganization?.id] }) }
    const post = async (path: string, body: unknown) => { setError(''); try { await api(path, { method: 'POST', body: JSON.stringify(body) }); await refresh() } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Invoice update failed') } }
    const recordPayment = (event: React.FormEvent<HTMLFormElement>) => { event.preventDefault(); void post(`/api/invoices/${encodeURIComponent(id)}/payments`, { amount: paymentAmount, method, reference }) }
    const recordRefund = (event: React.FormEvent<HTMLFormElement>) => { event.preventDefault(); void post(`/api/payments/${encodeURIComponent(refundPaymentId)}/refunds`, { amount: refundAmount, reason: refundReason }) }
    if (invoice.isPending) return <div className="surface module-empty">Loading invoice...</div>
    if (invoice.isError || !invoice.data) return <section className="surface product-error-state"><h2>Invoice unavailable</h2><p>{invoice.error?.message}</p><Link className="button button-secondary" to="/invoices">Back to invoices</Link></section>
    const item = invoice.data
    return <><section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" />INVOICE · {item.invoiceNumber}</div><h1>{item.status.replaceAll('_', ' ')}</h1><p>{item.currency} {item.total} total · Created {new Date(item.createdAt).toLocaleDateString()}</p></div><Link className="button button-secondary" to="/invoices">Back to invoices</Link></section>{error && <div className="connection-alert" role="alert">{error}</div>}<div className="operations-grid"><section className="surface product-detail-panel"><span className="section-kicker">INVOICE ITEMS</span><h2 className="detail-subheading">{item.invoiceNumber}</h2><div className="operations-list">{item.items.map((line) => <div className="operations-row invoice-line-row" key={line.id}><span>{line.description}</span><span>{line.quantity} × {item.currency} {line.unitPrice}</span><strong>{item.currency} {(Number(line.unitPrice) * line.quantity).toFixed(2)}</strong></div>)}</div><div className="invoice-total-preview"><span>Subtotal / total</span><strong>{item.currency} {item.subtotal} / {item.total}</strong></div>{item.status === 'DRAFT' && <button className="button button-primary" onClick={() => void post(`/api/invoices/${encodeURIComponent(id)}/issue`, {})}>Issue invoice</button>}</section><section className="surface product-detail-panel"><span className="section-kicker">PAYMENT RECORDS</span><h2 className="detail-subheading">Payments and refunds</h2>{item.payments.length ? <div className="operations-list">{item.payments.map((payment) => <article className="document-row" key={payment.id}><strong>{item.currency} {payment.amount} · {payment.status}</strong><span>{payment.method ?? 'Payment'} {payment.providerRef ? `· Ref ${payment.providerRef}` : ''}</span>{payment.refunds.map((refund) => <small key={refund.id}>Refund {item.currency} {refund.amount} · {refund.reason}</small>)}{['PAID', 'PARTIALLY_REFUNDED'].includes(payment.status) && <button className="text-button" onClick={() => setRefundPaymentId(refundPaymentId === payment.id ? '' : payment.id)}>Record refund</button>}</article>)}</div> : <div className="timeline-empty">No payments recorded.</div>}{!['DRAFT', 'CANCELLED', 'PAID'].includes(item.status) && <form className="operations-inline-form" onSubmit={recordPayment}><h3>Record payment</h3><label className="field"><span>Amount</span><input type="number" min="0.01" step="0.01" required value={paymentAmount} onChange={(event) => setPaymentAmount(event.target.value)} /></label><label className="field"><span>Method</span><select value={method} onChange={(event) => setMethod(event.target.value)}><option>BANK_TRANSFER</option><option>CHEQUE</option><option>CASH</option><option>OTHER</option></select></label><label className="field"><span>Reference (optional)</span><input maxLength={120} value={reference} onChange={(event) => setReference(event.target.value)} /></label><button className="button button-primary">Record payment</button></form>}{refundPaymentId && <form className="operations-inline-form" onSubmit={recordRefund}><h3>Record refund</h3><label className="field"><span>Amount</span><input type="number" min="0.01" step="0.01" required value={refundAmount} onChange={(event) => setRefundAmount(event.target.value)} /></label><label className="field"><span>Reason</span><input required minLength={2} maxLength={500} value={refundReason} onChange={(event) => setRefundReason(event.target.value)} /></label><button className="button button-secondary">Submit refund</button></form>}</section></div></>
  }

function TraceabilityPage() {
      const { currentOrganization } = useOrganizationContext()
      const history = useQuery({ queryKey: ['workspace-traceability', currentOrganization?.id], queryFn: () => api<{ databaseChainVerified: boolean; events: WorkspaceTraceEvent[] }>('/api/traceability'), enabled: Boolean(currentOrganization), retry: false })
      return <><section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" />IMMUTABLE EVENT HISTORY</div><h1>Traceability</h1><p>Organization supply-chain records, hash-chain integrity, and blockchain proof state.</p></div><span className={`chain-status ${history.data?.databaseChainVerified ? 'chain-ok' : ''}`}>{history.isPending ? 'CHECKING' : history.isError ? 'UNAVAILABLE' : history.data?.databaseChainVerified ? 'HASH CHAIN VERIFIED' : 'REVIEW'}</span></section>{history.isError && <div className="connection-alert" role="alert">{history.error.message}</div>}{history.isPending ? <div className="surface module-empty">Loading traceability events...</div> : history.data?.events.length ? <section className="surface timeline-panel"><div className="section-heading"><div><span className="section-kicker">LATEST 100 RECORDS</span><h2>Supply-chain timeline</h2></div><span className={`chain-status ${history.data.databaseChainVerified ? 'chain-ok' : ''}`}>{history.data.databaseChainVerified ? 'HASH CHAIN VERIFIED' : 'REVIEW REQUIRED'}</span></div><div className="timeline-list">{history.data.events.map((event) => <article className="timeline-event" key={event.eventId}><span className="timeline-marker" /><div className="timeline-event-main"><div className="timeline-event-heading"><strong>{event.eventType.replaceAll('_', ' ')}</strong><time>{new Date(event.timestamp).toLocaleString()}</time></div><div className="timeline-event-meta">{event.productId && <Link to={`/products/${event.productId}`}>{event.productName ?? 'Product record'}</Link>}{event.batchId && <Link to={`/batches/${event.batchId}`}>{event.batchNumber ?? 'Batch record'}</Link>}<span>{event.actorName ?? 'System'}</span>{event.locationName && <span>{event.locationName}</span>}{event.quantity !== null && <span>{event.quantity} units</span>}</div><BlockchainAnchorInfo status={event.blockchainStatus} transactionHash={event.blockchainTransactionHash} anchor={event.anchor} /><details><summary>Record hashes</summary><code>Current: {event.currentHash}</code><code>Previous: {event.previousHash ?? 'Genesis event'}</code></details></div></article>)}</div></section> : !history.isError && <div className="surface module-empty"><div className="catalog-empty-mark"><Activity size={21} /></div><h2>No traceability events yet</h2><p>Lifecycle events will appear here when products move through batches, inventory, and shipments.</p></div>}</>
  }

  function BlockchainPage() {
    const { currentOrganization } = useOrganizationContext()
    const status = useQuery({ queryKey: ['blockchain-status', currentOrganization?.id], queryFn: () => api<{ enabled: boolean; available: boolean; writeAvailable: boolean; chainId: string | null; networkName: string | null; contractAddress: string | null; counts: Record<string, number>; recentAnchors: Array<AnchorInfo & { event: { id: string; eventType: string; product: { name: string }; batch: { batchNumber: string } | null } }> }>('/api/blockchain/status'), enabled: Boolean(currentOrganization), retry: false })
    const data = status.data
    return <><section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" />IMMUTABLE PROOF LAYER</div><h1>Blockchain anchors</h1><p>Hashes are anchored as independent proofs; PostgreSQL remains the operational record.</p></div></section>{status.isError && <div className="connection-alert" role="alert">{status.error.message}</div>}{status.isPending ? <div className="surface module-empty">Checking blockchain configuration...</div> : data && <><div className="report-metrics blockchain-metrics"><article className="metric-card"><span className="metric-label">Configuration</span><strong className="metric-number">{data.enabled ? data.available ? 'ONLINE' : 'OFFLINE' : 'DISABLED'}</strong></article><article className="metric-card"><span className="metric-label">Network</span><strong className="metric-number">{data.networkName ?? data.chainId ?? '—'}</strong></article><article className="metric-card"><span className="metric-label">Anchored</span><strong className="metric-number">{data.counts.ANCHORED ?? 0}</strong></article><article className="metric-card"><span className="metric-label">Pending / failed</span><strong className="metric-number">{data.counts.PENDING ?? 0} / {data.counts.ANCHOR_FAILED ?? 0}</strong></article></div><section className="surface product-detail-panel blockchain-panel"><span className="section-kicker">SAFE NETWORK CONFIGURATION</span><h2 className="detail-subheading">Registry</h2><dl className="product-details"><div><dt>Chain ID</dt><dd>{data.chainId ?? 'Unavailable'}</dd></div><div><dt>Contract address</dt><dd className="trace-id">{data.contractAddress ?? 'Not configured'}</dd></div><div><dt>Write signer</dt><dd>{data.writeAvailable ? 'Available' : 'Not configured'}</dd></div><div><dt>Network status</dt><dd>{data.available ? 'Reachable' : 'Unavailable'}</dd></div></dl></section><section className="surface product-detail-panel blockchain-panel"><span className="section-kicker">RECENT ANCHORS</span><h2 className="detail-subheading">Organization records</h2>{data.recentAnchors.length ? <div className="operations-list">{data.recentAnchors.map((anchor) => <article className="document-row blockchain-anchor-row" key={anchor.id}><strong>{anchor.event.eventType.replaceAll('_', ' ')} · {anchor.event.product.name}</strong><span>{anchor.event.batch?.batchNumber ?? 'Product-level event'} · {anchor.status}</span><code>{anchor.eventHash}</code><BlockchainAnchorInfo status={anchor.status} transactionHash={anchor.transactionHash} anchor={anchor} /></article>)}</div> : <div className="timeline-empty">No anchors recorded for this organization.</div>}</section><p className="blockchain-disclaimer">Only event hashes and transaction proof are submitted on-chain. Product and organization records remain in PostgreSQL.</p></>}</>
}

function InventoryReportPage() {
  const { currentOrganization } = useOrganizationContext()
  const report = useQuery({ queryKey: ['operations-report', currentOrganization?.id], queryFn: () => api<{ inventory: { onHand: number; reserved: number }; batchStatuses: Array<{ status: string; count: number }>; recalledBatches: number; expiredBatches: number }>('/api/reports/operations'), enabled: Boolean(currentOrganization), retry: false })
  const data = report.data
  return <><section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" />INVENTORY REPORT</div><h1>Inventory</h1><p>Organization inventory and batch exposure from live records.</p></div></section>{report.isError && <div className="connection-alert" role="alert">{report.error.message}</div>}{report.isPending ? <div className="surface module-empty">Loading inventory report...</div> : data && <><div className="report-metrics"><article className="metric-card"><span className="metric-label">On hand</span><strong className="metric-number">{data.inventory.onHand}</strong></article><article className="metric-card"><span className="metric-label">Reserved</span><strong className="metric-number">{data.inventory.reserved}</strong></article><article className="metric-card"><span className="metric-label">Available</span><strong className="metric-number">{Math.max(0, data.inventory.onHand - data.inventory.reserved)}</strong></article><article className="metric-card"><span className="metric-label">Recalled / expired batches</span><strong className="metric-number">{data.recalledBatches} / {data.expiredBatches}</strong></article></div><section className="surface product-detail-panel report-panels"><span className="section-kicker">BATCH DISTRIBUTION</span><h2 className="detail-subheading">Inventory lifecycle by batch status</h2>{data.batchStatuses.length ? data.batchStatuses.map((row) => <div className="report-status-row" key={row.status}><span>{row.status.replaceAll('_', ' ')}</span><strong>{row.count}</strong></div>) : <div className="timeline-empty">No batches recorded.</div>}</section></>}</>
}

function TraceabilityReportPage() {
  const { currentOrganization } = useOrganizationContext()
  const report = useQuery({ queryKey: ['operations-report', currentOrganization?.id], queryFn: () => api<{ activity: Array<{ day: string; events: number; anchors: number }>; recentActivity: Array<{ id: string; eventType: string; productName: string; actorName: string; createdAt: string }> }>('/api/reports/operations'), enabled: Boolean(currentOrganization), retry: false })
  const data = report.data
  return <><section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" />TRACEABILITY REPORT</div><h1>Traceability activity</h1><p>Hash-linked lifecycle events and independently anchored proofs.</p></div></section>{report.isError && <div className="connection-alert" role="alert">{report.error.message}</div>}{report.isPending ? <div className="surface module-empty">Loading traceability report...</div> : data && <div className="operations-grid report-panels"><section className="surface product-detail-panel"><span className="section-kicker">LAST 14 DAYS</span><h2 className="detail-subheading">Events and blockchain anchors</h2><div className="report-chart">{data.activity.length ? <Suspense fallback={<div className="chart-loading" />}><ActivityChart data={data.activity} /></Suspense> : <div className="timeline-empty">No traceability activity recorded.</div>}</div></section><section className="surface product-detail-panel"><span className="section-kicker">LATEST EVENTS</span><h2 className="detail-subheading">Organization activity</h2>{data.recentActivity.length ? data.recentActivity.map((event) => <div className="recent-event-row" key={event.id}><span className="recent-event-mark"><Activity size={14} /></span><span><strong>{event.eventType.replaceAll('_', ' ')}</strong><small>{event.productName} · {event.actorName}</small></span><time className="recent-event-time">{new Date(event.createdAt).toLocaleDateString()}</time></div>) : <div className="timeline-empty">No traceability events recorded.</div>}<Link className="panel-link" to="/traceability?tab=timeline">Open timeline <ArrowRight size={14} /></Link></section></div>}</>
}

function ReportsPage() {
    const { currentOrganization } = useOrganizationContext()
    const report = useQuery({ queryKey: ['operations-report', currentOrganization?.id], queryFn: () => api<{ products: number; batchCount: number; batchStatuses: Array<{ status: string; count: number }>; inventory: { onHand: number; reserved: number }; activeShipments: number; deliveredShipments: number; returnsByStatus: Array<{ status: string; count: number }>; recalledBatches: number; expiredBatches: number; invoices: { count: number; total: string | number; paid: string | number }; recentActivity: Array<{ id: string; eventType: string; productName: string; actorName: string; createdAt: string }>; activity: Array<{ day: string; events: number; anchors: number }> }>('/api/reports/operations'), enabled: Boolean(currentOrganization), retry: false })
    const data = report.data
    return <><section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" />OPERATIONAL INTELLIGENCE</div><h1>Reports</h1><p>Live totals and activity for the selected organization.</p></div></section>{report.isError && <div className="connection-alert" role="alert">{report.error.message}</div>}{report.isPending ? <div className="surface module-empty">Loading operational report...</div> : data && <><div className="report-metrics"><article className="metric-card"><span className="metric-label">Products</span><strong className="metric-number">{data.products}</strong></article><article className="metric-card"><span className="metric-label">Batches</span><strong className="metric-number">{data.batchCount}</strong></article><article className="metric-card"><span className="metric-label">Inventory on hand</span><strong className="metric-number">{data.inventory.onHand}</strong></article><article className="metric-card"><span className="metric-label">Active shipments</span><strong className="metric-number">{data.activeShipments}</strong></article><article className="metric-card"><span className="metric-label">Delivered shipments</span><strong className="metric-number">{data.deliveredShipments}</strong></article><article className="metric-card"><span className="metric-label">Returns</span><strong className="metric-number">{data.returnsByStatus.reduce((sum, row) => sum + row.count, 0)}</strong></article><article className="metric-card"><span className="metric-label">Recalled / expired batches</span><strong className="metric-number">{data.recalledBatches} / {data.expiredBatches}</strong></article><article className="metric-card"><span className="metric-label">Invoices / paid</span><strong className="metric-number">{data.invoices.count} / {data.invoices.paid}</strong></article></div><div className="operations-grid report-panels"><section className="surface product-detail-panel"><div className="section-heading"><div><span className="section-kicker">LAST 14 DAYS</span><h2>Traceability activity</h2></div></div><div className="report-chart">{data.activity.length ? <ActivityChart data={data.activity} /> : <div className="timeline-empty">No recent traceability activity.</div>}</div></section><section className="surface product-detail-panel"><span className="section-kicker">BATCH STATUS</span><h2 className="detail-subheading">Current lifecycle</h2>{data.batchStatuses.length ? data.batchStatuses.map((row) => <div className="report-status-row" key={row.status}><span>{row.status.replaceAll('_', ' ')}</span><strong>{row.count}</strong></div>) : <div className="timeline-empty">No batches recorded.</div>}</section><section className="surface product-detail-panel report-activity"><span className="section-kicker">RECENT RECORDS</span><h2 className="detail-subheading">Supply-chain activity</h2>{data.recentActivity.length ? data.recentActivity.map((event) => <div className="recent-event-row" key={event.id}><span className="recent-event-mark"><Activity size={14} /></span><span><strong>{event.eventType.replaceAll('_', ' ')}</strong><small>{event.productName} · {event.actorName}</small></span><time className="recent-event-time">{new Date(event.createdAt).toLocaleDateString()}</time></div>) : <div className="timeline-empty">No supply-chain activity yet.</div>}</section></div></>}</>
  }

  function AuditLogsPage() {
    const { currentOrganization } = useOrganizationContext()
    const logs = useQuery({ queryKey: ['audit-logs', currentOrganization?.id], queryFn: () => api<{ items: Array<{ id: string; action: string; resourceType: string; resourceId: string | null; metadata: Record<string, unknown>; createdAt: string; actor: { fullName: string; email: string } | null }> }>('/api/audit-logs'), enabled: Boolean(currentOrganization), retry: false })
    return <><section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" />CONTROL PLANE</div><h1>Audit logs</h1><p>Organization actions recorded with the authenticated actor.</p></div></section>{logs.isError && <div className="connection-alert" role="alert">{logs.error.message.toLowerCase().includes('permission') ? 'Audit logs are available to organization owners and admins.' : logs.error.message}</div>}{logs.isPending ? <div className="surface module-empty">Loading audit records...</div> : logs.data?.items.length ? <section className="surface operations-table"><div className="operations-table-head audit-columns"><span>TIME</span><span>ACTOR</span><span>ACTION</span><span>RESOURCE</span><span>SAFE METADATA</span></div>{logs.data.items.map((item) => <article className="operations-row audit-columns" key={item.id}><time>{new Date(item.createdAt).toLocaleString()}</time><span>{item.actor?.fullName ?? 'System'}</span><strong>{item.action}</strong><span>{item.resourceType} · {item.resourceId ?? '—'}</span><code>{JSON.stringify(item.metadata)}</code></article>)}</section> : !logs.isError && <div className="surface module-empty"><div className="catalog-empty-mark"><ClipboardList size={21} /></div><h2>No audit records</h2><p>Organization actions will be recorded here as workflows are used.</p></div>}</>
  }

function ModulePage({ title, description }: { title: string; description: string }) {
  return <><section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" />WORKSPACE</div><h1>{title}</h1><p>{description}</p></div></section><div className="surface module-empty"><div className="catalog-empty-mark"><ClipboardList size={22} /></div><span className="section-kicker">READY FOR YOUR WORKFLOW</span><h2>No records to show</h2><p>New {title.toLowerCase()} records will appear here when they are created in your workspace.</p></div></>
}

function OrganizationMembersPage() {
  const { currentOrganization } = useOrganizationContext()
  const organizationId = currentOrganization?.id
  const members = useQuery({ queryKey: ['organization-members', organizationId], queryFn: () => api<{ items: Array<{ id: string; fullName: string; email: string; roleName: string; joinedAt: string; isActive: boolean }> }>(`/api/organizations/${encodeURIComponent(organizationId!)}/members`), enabled: Boolean(organizationId), retry: false })
  return <><section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" />ACCESS CONTROL</div><h1>Organization members</h1><p>Members and assigned roles in {currentOrganization?.name ?? 'this organization'}.</p></div></section>{members.isError && <div className="connection-alert" role="alert">{members.error.message}</div>}{members.isPending ? <div className="surface module-empty">Loading members...</div> : members.data?.items.length ? <section className="surface operations-table member-table"><div className="operations-table-head member-columns"><span>MEMBER</span><span>EMAIL</span><span>ROLE</span><span>STATUS</span><span>JOINED</span></div>{members.data.items.map((member) => <article className="operations-row member-columns" key={member.id}><strong>{member.fullName}</strong><span>{member.email}</span><span className="status-pill">{member.roleName}</span><span>{member.isActive ? 'ACTIVE' : 'INACTIVE'}</span><time>{new Date(member.joinedAt).toLocaleDateString()}</time></article>)}</section> : <div className="surface module-empty"><h2>No organization members found</h2></div>}</>
}

function OrganizationSettingsPage() {
  const { currentOrganization } = useOrganizationContext()
  const organizationId = currentOrganization?.id
  const organization = useQuery({ queryKey: ['organization-settings', organizationId], queryFn: () => api<{ id: string; name: string; createdAt: string }>(`/api/organizations/${encodeURIComponent(organizationId!)}`), enabled: Boolean(organizationId), retry: false })
  const members = useQuery({ queryKey: ['organization-members', organizationId], queryFn: () => api<{ items: Array<{ id: string; fullName: string; email: string; roleName: string; joinedAt: string; isActive: boolean }> }>(`/api/organizations/${encodeURIComponent(organizationId!)}/members`), enabled: Boolean(organizationId), retry: false })
  return <><section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" />WORKSPACE ADMINISTRATION</div><h1>Organization settings</h1><p>Organization identity, membership, and access roles.</p></div></section>{organization.isError && <div className="connection-alert" role="alert">{organization.error.message}</div>}{organization.isPending ? <div className="surface module-empty">Loading organization...</div> : organization.data && <section className="surface product-detail-panel organization-settings-panel"><span className="section-kicker">CURRENT ORGANIZATION</span><h2 className="detail-subheading">{organization.data.name}</h2><dl className="product-details"><div><dt>Your role</dt><dd>{currentOrganization?.roleName ?? 'Member'}</dd></div><div><dt>Created</dt><dd>{new Date(organization.data.createdAt).toLocaleDateString()}</dd></div><div><dt>Organization ID</dt><dd className="trace-id">{organization.data.id}</dd></div></dl></section>}<section className="surface product-detail-panel organization-settings-panel"><div className="section-heading"><div><span className="section-kicker">ACCESS CONTROL</span><h2>Organization members</h2></div><span className="table-muted">{members.data?.items.length ?? '—'} members</span></div>{members.isError ? <div className="timeline-empty timeline-error">{members.error.message}</div> : members.isPending ? <div className="timeline-empty">Loading members...</div> : members.data?.items.length ? <div className="operations-table member-table"><div className="operations-table-head member-columns"><span>MEMBER</span><span>EMAIL</span><span>ROLE</span><span>STATUS</span><span>JOINED</span></div>{members.data.items.map((member) => <article className="operations-row member-columns" key={member.id}><strong>{member.fullName}</strong><span>{member.email}</span><span className="status-pill">{member.roleName}</span><span>{member.isActive ? 'ACTIVE' : 'INACTIVE'}</span><time>{new Date(member.joinedAt).toLocaleDateString()}</time></article>)}</div> : <div className="timeline-empty">No organization members found.</div>}</section></>
}

function PublicVerification() {
  const { traceId = '' } = useParams()
  const verification = useQuery({ queryKey: ['public-verification', traceId], queryFn: () => api<{ verified: boolean; status: string; databaseChainVerified: boolean; certificateVerified: boolean; blockchainVerification: PublicBlockchainVerification; product: { brandName: string; genericName: string; dosageForm: string; strength: string }; certificates: Array<{ certificateNumber: string; type: string; issuer: string; issuedAt: string | null; expiresAt: string | null; verifiedAt: string | null; status: string }>; eventCount: number; certificateCount: number; recalled: boolean; expired: boolean }>(`/api/public/verify/${encodeURIComponent(traceId)}`), enabled: Boolean(traceId.trim()), retry: false })

  return <main className="verify-page"><header className="verify-header"><Link className="brand verify-brand" to="/"><span className="brand-mark"><Activity size={19} /></span><span className="brand-copy"><strong>TRUSTTRACE</strong><small>PUBLIC VERIFICATION</small></span></Link><span className="verify-secure"><LockKeyhole size={14} />SECURE RECORD CHECK</span></header><div className="verify-content"><div className="verify-kicker"><span />DIGITAL PRODUCT IDENTITY</div><h1>Product Verification</h1><p className="verify-lede">Trust every step of the supply chain.</p><div className="verify-id"><QrCode size={17} /><span>TRACE ID</span><code>{traceId || 'Not provided'}</code></div>
    {!traceId.trim() && <div className="verify-result review"><span className="verify-result-icon"><ShieldQuestion size={22} /></span><div><strong>Trace ID required</strong><p>Enter or scan the identifier printed on the product label.</p></div></div>}
    {traceId && verification.isPending && <div className="verify-result pending"><span className="verify-result-icon"><Activity size={22} /></span><div><strong>Checking this identity</strong><p>Validating the public record and its history.</p></div></div>}
    {traceId && verification.isError && <div className="verify-result review"><span className="verify-result-icon"><ShieldQuestion size={22} /></span><div><strong>Verification requires review</strong><p>This Trace ID could not be confirmed. Check the identifier or contact the issuing organization.</p></div></div>}
    {verification.data && <><div className={`verify-result ${verification.data.recalled ? 'recalled' : verification.data.verified ? 'verified' : 'review'}`}><span className="verify-result-icon">{verification.data.recalled ? <AlertTriangle size={22} /> : verification.data.verified ? <ShieldCheck size={22} /> : <ShieldQuestion size={22} />}</span><div><strong>{verification.data.recalled ? 'Product recalled' : verification.data.verified ? 'Product identity verified' : 'Verification requires review'}</strong><p>{verification.data.recalled ? 'An active recall is associated with this identity.' : verification.data.expired ? 'An associated batch has passed its expiry date; verification requires review.' : 'This record check does not establish medical safety, regulatory approval, or authenticity.'}</p></div></div>{verification.data.product && <div className="verify-product"><span>PRODUCT RECORD</span><h2>{verification.data.product.brandName}</h2><p>{verification.data.product.genericName} · {verification.data.product.dosageForm} · {verification.data.product.strength}</p></div>}<div className="verify-checks"><div><BadgeCheck size={16} /><span>Product identity</span><strong>VERIFIED</strong></div><div><ShieldCheck size={16} /><span>Supply-chain history</span><strong>{verification.data.databaseChainVerified ? 'VERIFIED' : 'REVIEW'}</strong></div><div><ShieldCheck size={16} /><span>Digital records intact</span><strong>{verification.data.databaseChainVerified ? 'YES' : 'REVIEW'}</strong></div><div><FileCheck2 size={16} /><span>Certificates</span><strong>{verification.data.certificateVerified ? 'VERIFIED' : verification.data.certificateCount ? 'REVIEW' : 'NONE'}</strong></div><div><ShieldCheck size={16} /><span>Recall state</span><strong>{verification.data.recalled ? 'RECALLED' : 'NO KNOWN RECALL'}</strong></div><div><Clock3 size={16} /><span>Expiry review</span><strong>{verification.data.expired ? 'REVIEW' : 'CURRENT'}</strong></div></div></>}
    {verification.data && <PublicBlockchainProof verification={verification.data.blockchainVerification} />}
    {verification.data?.certificates.length ? <PublicCertificateList certificates={verification.data.certificates} /> : null}
    <div className="verify-disclaimer"><AlertTriangle size={15} /><span>Certificate presence and record integrity do not establish medical safety or regulatory approval.</span></div></div><footer className="verify-footer"><span>TRUSTTRACE</span><span>Trust every step of the supply chain.</span></footer></main>
}

function PublicBlockchainProof({ verification }: { verification: PublicBlockchainVerification }) {
  const statusText = verification.status === 'ANCHORED'
    ? 'Blockchain proof anchored'
    : verification.status === 'ANCHOR_FAILED'
      ? 'Blockchain anchor failed'
      : verification.status === 'PENDING'
        ? 'Blockchain anchoring pending'
        : verification.status === 'NOT_CONFIGURED'
          ? 'Blockchain verification unavailable'
          : 'Blockchain verification unavailable'
  return <section className={`verify-blockchain ${verification.status === 'ANCHORED' ? 'proof-anchored' : 'proof-unavailable'}`}><strong>{statusText}</strong><span>Anchored hashes: {verification.anchorCount} of {verification.totalEventCount}</span>{verification.proofs.filter((proof) => proof.status === 'ANCHORED').map((proof) => <article key={proof.eventId}><span>{proof.networkName ?? (proof.chainId ? `Chain ${proof.chainId}` : 'Configured chain')} · block {proof.blockNumber}</span><code>{proof.transactionHash}</code></article>)}<small>Blockchain anchoring proves that these record hashes were committed to a chain; it does not establish product safety or authenticity.</small></section>
}

function PublicCertificateList({ certificates }: { certificates: Array<{ certificateNumber: string; type: string; issuer: string; issuedAt: string | null; expiresAt: string | null; verifiedAt: string | null; status: string }> }) {
  return <section className="verify-certificates"><span className="section-kicker">PUBLIC CERTIFICATE METADATA</span>{certificates.map((certificate) => <article key={certificate.certificateNumber}><strong>{certificate.type} · {certificate.certificateNumber}</strong><span>Issuer: {certificate.issuer}</span><span>Status: {certificate.status} · {certificate.verifiedAt ? 'Record verified' : 'Not verified'}</span><span>Issued: {certificate.issuedAt ? new Date(certificate.issuedAt).toLocaleDateString() : 'Not provided'} · Expires: {certificate.expiresAt ? new Date(certificate.expiresAt).toLocaleDateString() : 'Not provided'}</span></article>)}</section>
}

function ScanPage() {
  const [traceId, setTraceId] = useState('')
  const [cameraState, setCameraState] = useState<'idle' | 'starting' | 'scanning'>('idle')
  const [cameraDevices, setCameraDevices] = useState<MediaDeviceInfo[]>([])
  const [activeCameraId, setActiveCameraId] = useState('')
  const [scanError, setScanError] = useState('')
  const videoRef = useRef<HTMLVideoElement>(null)
  const readerRef = useRef<BrowserMultiFormatReader | null>(null)
  const controlsRef = useRef<IScannerControls | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    let cancelled = false
    void import('@zxing/browser').then(({ BrowserMultiFormatReader }) => BrowserMultiFormatReader.listVideoInputDevices()).then((devices) => {
      if (!cancelled) setCameraDevices(devices)
    }).catch(() => undefined)
    return () => {
      cancelled = true
      controlsRef.current?.stop()
    }
  }, [])

  const stopCamera = () => {
    controlsRef.current?.stop()
    controlsRef.current = null
    const stream = videoRef.current?.srcObject
    if (stream instanceof MediaStream) stream.getTracks().forEach((track) => track.stop())
    setCameraState('idle')
  }

  const handleScan = (rawValue: string) => {
    const value = rawValue.trim()
    let candidate = value
    if (!/^TT-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) {
      try {
        const url = new URL(value)
        const match = url.origin === window.location.origin ? url.pathname.match(/^\/verify\/([^/]+)\/?$/) : null
        candidate = match ? decodeURIComponent(match[1]) : ''
      } catch {
        candidate = ''
      }
    }
    stopCamera()
    if (!/^TT-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(candidate)) {
      setScanError('This code is not a TrustTrace identity or same-site verification link.')
      return
    }
    navigate(`/verify/${encodeURIComponent(candidate)}`)
  }

  const startCamera = async (deviceId = activeCameraId) => {
    if (!videoRef.current) return
    setScanError('')
    setCameraState('starting')
    try {
      const { BrowserMultiFormatReader } = await import('@zxing/browser')
      readerRef.current ??= new BrowserMultiFormatReader()
      const callback = (result: { getText(): string } | undefined) => {
        if (result) handleScan(result.getText())
      }
      const controls = deviceId
        ? await readerRef.current.decodeFromVideoDevice(deviceId, videoRef.current, callback)
        : await readerRef.current.decodeFromConstraints({ video: { facingMode: { ideal: 'environment' } } }, videoRef.current, callback)
      controlsRef.current = controls
      setCameraState('scanning')
      const devices = await BrowserMultiFormatReader.listVideoInputDevices()
      setCameraDevices(devices)
      if (!deviceId && devices[devices.length - 1]) setActiveCameraId(devices[devices.length - 1].deviceId)
    } catch (error) {
      setCameraState('idle')
      const name = error instanceof DOMException ? error.name : ''
      setScanError(name === 'NotAllowedError' ? 'Camera permission was denied. Allow camera access in your browser settings and try again.' : name === 'NotFoundError' ? 'No camera was found on this device.' : 'The camera could not start. Check browser permissions and try again.')
    }
  }

  const switchCamera = async () => {
    if (cameraDevices.length < 2) return
    const currentIndex = cameraDevices.findIndex((device) => device.deviceId === activeCameraId)
    const next = cameraDevices[(currentIndex + 1) % cameraDevices.length]
    stopCamera()
    setActiveCameraId(next.deviceId)
    await startCamera(next.deviceId)
  }

  return <><section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" />IDENTITY LOOKUP</div><h1>Scan a product</h1><p>Scan a QR code or barcode, or enter a Trace ID manually.</p></div></section><div className="scan-layout"><div className="surface scanner-panel"><div className={`scanner-frame ${cameraState === 'scanning' ? 'camera-active' : ''}`}><video ref={videoRef} className="camera-video" autoPlay muted playsInline /><span className="scan-corner top-left" /><span className="scan-corner top-right" /><span className="scan-corner bottom-left" /><span className="scan-corner bottom-right" />{cameraState !== 'scanning' && <div className="camera-placeholder"><QrCode size={44} strokeWidth={1.2} /><span>{cameraState === 'starting' ? 'Connecting to camera...' : 'Camera scanner'}</span></div>}</div>{scanError && <div className="scan-error" role="alert"><AlertTriangle size={15} />{scanError}</div>}<div className="scanner-controls"><button className="button button-primary" type="button" onClick={() => cameraState === 'scanning' ? stopCamera() : void startCamera()}>{cameraState === 'scanning' ? <><X size={16} />Stop camera</> : <><QrCode size={16} />{cameraState === 'starting' ? 'Starting...' : 'Start camera'}</>}</button><button className="button button-secondary" type="button" onClick={() => void switchCamera()} disabled={cameraDevices.length < 2}><Activity size={15} />Switch camera</button></div><p className="scanner-hint">QR codes and common 1D barcodes are supported. Camera access requires permission.</p></div><div className="surface manual-scan"><span className="section-kicker">MANUAL LOOKUP</span><h2>Enter Trace ID</h2><p>Use the opaque ID printed on the product or package label.</p><form onSubmit={(event) => { event.preventDefault(); if (/^TT-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(traceId.trim())) navigate(`/verify/${encodeURIComponent(traceId.trim())}`); else setScanError('Enter a complete TrustTrace ID in the TT-UUID format.') }}><label className="field"><span>Trace ID</span><input value={traceId} onChange={(event) => setTraceId(event.target.value)} placeholder="TT-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" /></label><button className="button button-primary" type="submit">Verify identity <ArrowRight size={16} /></button></form></div></div></>
}

export default App
