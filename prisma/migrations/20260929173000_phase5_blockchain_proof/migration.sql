ALTER TABLE "TraceabilityAnchor"
  ADD COLUMN "blockNumber" BIGINT,
  ADD COLUMN "contractAddress" TEXT,
  ADD COLUMN "chainId" TEXT,
  ADD COLUMN "networkName" TEXT,
  ADD COLUMN "failureCode" TEXT,
  ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastAttemptAt" TIMESTAMP(3);