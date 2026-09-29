# TrustTrace

### Decentralized Supply Chain Traceability Platform

> Trust every step of the supply chain.

TrustTrace gives physical products a verifiable digital identity and records their supply-chain journey in a tamper-evident event chain. The first enabled workspace domain is pharmaceuticals; the data model supports additional domains without making the core product, batch, identity, or event architecture pharmaceutical-specific.

## Start locally

Requirements: Node.js 22+, npm, and Docker Desktop.

1. Copy `.env.example` to `.env` and replace `JWT_ACCESS_SECRET` with a random secret of at least 32 characters.
2. Run `docker compose up --build` from this directory.
3. Open `http://localhost:5173` and register an organization. The API is available at `http://localhost:4000`.

The database schema is created with `prisma db push`. There is no seed script: a new database contains no products, batches, inventory, shipments, payments, invoices, returns, or recalls. Organization and RBAC setup is created only when a user registers.

For development without Docker, start PostgreSQL, set `DATABASE_URL` and `JWT_ACCESS_SECRET`, then run `npm install`, `npm run db:generate`, `npm run db:push`, and `npm run dev`.

## Project layout

- `src/`: React, TypeScript, Vite, React Router, TanStack Query, Tailwind CSS, Lucide, React Hook Form, Zod, and Recharts frontend.
- `api/`: Express API, authentication, organization scoping, RBAC, validation, product routes, dashboard queries, and traceability services.
- `prisma/schema.prisma`: PostgreSQL models for identity, organizations, products, inventory, quality, shipments, verification, finance, audit, and notifications.
- `contracts/TrustTraceRegistry.sol`: stores event hashes and anchor timestamps only.

## Traceability and verification

Every created product receives a `TT-{UUID}` identity and a canonical SHA-256 event record. Each event links to the previous event hash. Corrections should be represented by new corrective events rather than edits to historical event data. Public verification exposes only product identity, record-integrity results, certificate counts, and recall state; it never claims that traceability proves medical safety.

Database chain, blockchain anchor, and certificate checks are reported independently. Blockchain configuration is optional. Set `BLOCKCHAIN_RPC_URL`, `BLOCKCHAIN_PRIVATE_KEY`, and `TRUSTTRACE_REGISTRY_ADDRESS` only when an anchor service and deployed registry are available; unconfigured blockchain anchoring must not prevent database event creation.

## Blockchain anchoring

PostgreSQL remains the operational source of truth. Each traceability event keeps its canonical SHA-256 `currentHash` and `previousHash`; the `TrustTraceRegistry` stores only that `bytes32` hash, its block timestamp/number, and the submitting address. Product, organization, actor, shipment, payment, and document data stays off-chain. The API verifies public anchors against `isAnchored`/`getAnchor`; blockchain failure never rolls back a database event, and an organization owner/admin can retry failed anchors from the timeline.

For a local proof-of-concept, use two terminals:

```powershell
npm run contract:test
```

```powershell
npm run blockchain:node
```

Then compile and deploy from another terminal:

```powershell
npm run contract:compile
npm run blockchain:deploy
```

Copy the printed contract address into `.env` as `TRUSTTRACE_REGISTRY_ADDRESS`, and set `BLOCKCHAIN_RPC_URL=http://127.0.0.1:8545`. Restart the API after configuration. On local chain ID `31337`, Hardhat's unlocked development account is used when `BLOCKCHAIN_PRIVATE_KEY` is blank; no real cryptocurrency or wallet key is needed. For a non-local chain, configure a protected signer key outside source control. Never expose the RPC URL if it contains credentials.

Run the database-backed local-chain integration test with `npm run test:blockchain`. It starts an ephemeral Hardhat node and isolated PostgreSQL schema, deploys the registry, checks successful persisted anchoring and public verification, simulates RPC failure, and retries without touching live business records. The authenticated `/blockchain` page shows organization-scoped status and safe registry metadata.

## Pharmaceutical domain policy

Product creation is validated in both the browser and API. The API rejects non-pharmaceutical domains and blocked product categories. Generic domain and product fields remain extensible for future domains; do not loosen the current workspace policy without adding authorization, validation, and tests.

## Commands

- `npm run dev`: run Vite and the Express API.
- `npm run build`: build and typecheck the web and API projects.
- `npm test`: run focused product-policy and hash-chain tests.
- `npm run db:generate`: generate Prisma Client.
- `npm run db:push`: apply the Prisma schema to the configured database.
- `npm run contract:compile`: compile the registry contract with Hardhat.
- `npm run contract:test`: run local Solidity registry tests.
- `npm run blockchain:node`: start the local Hardhat JSON-RPC node.
- `npm run blockchain:deploy`: deploy the registry to the local Hardhat node.
- `npm run test:blockchain`: test database anchoring and public verification against an ephemeral local chain.

## Security notes

Passwords are bcrypt-hashed; access JWTs are short-lived; refresh tokens are opaque, hashed at rest, rotated, and delivered in an HttpOnly SameSite cookie. API routes use Helmet, CORS allowlisting, request limits, Zod validation, organization scoping, and permission checks. Configure production secrets, TLS, secure cookie settings, database backups, file-storage validation, and a production deployment pipeline before handling real regulated data.