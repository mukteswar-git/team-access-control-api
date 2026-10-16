import { prisma } from "../lib/prisma.js";

type CreatePasswordResetTokenData = {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
};

export function createPasswordResetToken(data: CreatePasswordResetTokenData) {
  return prisma.passwordResetToken.create({
    data: {
      userId: data.userId,
      tokenHash: data.tokenHash,
      expiresAt: data.expiresAt,
    },
  });
}

export function findPasswordResetTokenByHash(tokenHash: string) {
  return prisma.passwordResetToken.findUnique({
    where: { tokenHash },
  });
}
