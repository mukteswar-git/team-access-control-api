import { prisma } from "../lib/prisma.js";
import type { DatabaseClient, TransactionClient } from "../lib/prisma.js";

type CreatePasswordResetTokenData = {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
};

export function createPasswordResetToken(
  data: CreatePasswordResetTokenData,
  db: DatabaseClient = prisma,
) {
  return db.passwordResetToken.create({
    data: {
      userId: data.userId,
      tokenHash: data.tokenHash,
      expiresAt: data.expiresAt,
    },
  });
}

export function findPasswordResetTokenByHash(
  tokenHash: string,
  db: DatabaseClient = prisma,
) {
  return db.passwordResetToken.findUnique({
    where: { tokenHash },
  });
}

export async function consumePasswordResetToken(
  tx: TransactionClient,
  tokenHash: string,
  now: Date,
) {
  return tx.passwordResetToken.updateMany({
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

export function deletePasswordResetToken(
  tokenHash: string,
  db: DatabaseClient = prisma,
) {
  return db.passwordResetToken.deleteMany({
    where: {
      tokenHash,
      usedAt: null,
    },
  });
}
