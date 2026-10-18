import { prisma } from "../lib/prisma.js";
import type { DatabaseClient, TransactionClient } from "../lib/prisma.js";

type CreateEmailVerificationTokenData = {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
};

export function createEmailVerificationToken(
  data: CreateEmailVerificationTokenData,
  db: DatabaseClient = prisma,
) {
  return db.emailVerificationToken.create({
    data: {
      userId: data.userId,
      tokenHash: data.tokenHash,
      expiresAt: data.expiresAt,
    },
  });
}

export function findEmailVerificationTokenByHash(
  tokenHash: string,
  db: DatabaseClient = prisma,
) {
  return db.emailVerificationToken.findUnique({
    where: { tokenHash },
  });
}

export async function consumeEmailVerificationToken(
  tx: TransactionClient,
  tokenHash: string,
  now: Date,
) {
  return tx.emailVerificationToken.updateMany({
    where: {
      tokenHash,
      usedAt: null,
      expiresAt: { gt: now },
    },
    data: {
      usedAt: now,
    },
  });
}
