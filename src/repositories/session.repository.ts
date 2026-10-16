import { prisma } from "../lib/prisma.js";

type CreateSessionData = {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
};

export function createSession(data: CreateSessionData) {
  return prisma.session.create({
    data: {
      userId: data.userId,
      tokenHash: data.tokenHash,
      expiresAt: data.expiresAt,
    },
  });
}

export function findSessionByTokenHash(tokenHash: string) {
  return prisma.session.findUnique({
    where: { tokenHash },
  });
}

export function revokeSessionByTokenHash(tokenHash: string) {
  return prisma.session.updateMany({
    where: {
      tokenHash,
      revokedAt: null,
    },
    data: {
      revokedAt: new Date(),
    },
  });
}

export function revokeAllSessionsForUser(userId: string) {
  return prisma.session.updateMany({
    where: {
      userId,
      revokedAt: null,
    },
    data: {
      revokedAt: new Date(),
    },
  });
}
