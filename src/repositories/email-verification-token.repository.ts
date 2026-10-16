import { prisma } from "../lib/prisma.js";

type CreateEmailVerificationTokenData = {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
};

export function createEmailVerificationToken(
  data: CreateEmailVerificationTokenData,
) {
  return prisma.emailVerificationToken.create({
    data: {
      userId: data.userId,
      tokenHash: data.tokenHash,
      expiresAt: data.expiresAt,
    },
  });
}

export function findEmailVerificationTokenByHash(tokenHash: string) {
  return prisma.emailVerificationToken.findUnique({
    where: { tokenHash },
  });
}
