import { prisma } from './prisma.js'

export async function ensureAppendOnlyEventHistory() {
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION trusttrace_protect_supply_chain_event() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Supply-chain events cannot be deleted' USING ERRCODE = '55000';
      END IF;
      IF ROW(OLD."id", OLD."eventType", OLD."productId", OLD."batchId", OLD."packageId", OLD."actorId", OLD."organizationId", OLD."locationId", OLD."timestamp", OLD."quantity", OLD."metadata", OLD."previousHash", OLD."currentHash", OLD."createdAt")
         IS DISTINCT FROM
         ROW(NEW."id", NEW."eventType", NEW."productId", NEW."batchId", NEW."packageId", NEW."actorId", NEW."organizationId", NEW."locationId", NEW."timestamp", NEW."quantity", NEW."metadata", NEW."previousHash", NEW."currentHash", NEW."createdAt") THEN
        RAISE EXCEPTION 'Supply-chain event history is immutable' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `)
  await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS supply_chain_event_immutable ON "SupplyChainEvent"')
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER supply_chain_event_immutable
    BEFORE UPDATE OR DELETE ON "SupplyChainEvent"
    FOR EACH ROW EXECUTE FUNCTION trusttrace_protect_supply_chain_event()
  `)
}
