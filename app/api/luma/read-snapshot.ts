import { Prisma, type PrismaClient } from "@prisma/client";
import { humanClient } from "./human-mode";

/** MVCC snapshots can read during a projection/sync; only writers need its exclusive lock. */
export function readIndexedSnapshot<T>(db: PrismaClient, read: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const source = (db as PrismaClient & { $source?: PrismaClient }).$source ?? db;
  return source.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    return read(humanClient(tx));
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 5000, timeout: 15000 });
}
