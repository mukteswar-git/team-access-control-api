import { prisma } from "../lib/prisma.js";
import type { DatabaseClient } from "../lib/prisma.js";

type CreateSessionData = {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
};

export function createSession(
  data: CreateSessionData,
  db: DatabaseClient = prisma,
) {
  return db.session.create({
    data: {
      userId: data.userId,
      tokenHash: data.tokenHash,
      expiresAt: data.expiresAt,
    },
  });
}

export function findSessionByTokenHash(
  tokenHash: string,
  db: DatabaseClient = prisma,
) {
  return db.session.findUnique({
    where: { tokenHash },
    include: { user: true },
  });
}

export function revokeSessionByTokenHash(
  tokenHash: string,
  db: DatabaseClient = prisma,
) {
  return db.session.updateMany({
    where: {
      tokenHash,
      revokedAt: null,
    },
    data: {
      revokedAt: new Date(),
    },
  });
}

export function revokeAllSessionsForUser(
  userId: string,
  db: DatabaseClient = prisma,
) {
  return db.session.updateMany({
    where: {
      userId,
      revokedAt: null,
    },
    data: {
      revokedAt: new Date(),
    },
  });
}

export function revokeSessionById(
  sessionId: string,
  db: DatabaseClient = prisma,
) {
  return db.session.updateMany({
    where: {
      id: sessionId,
      revokedAt: null,
    },
    data: {
      revokedAt: new Date(),
    },
  });
}

export function findSessionsByUserId(
  userId: string,
  db: DatabaseClient = prisma,
) {
  return db.session.findMany({
    where: { userId },
    select: {
      id: true,
      createdAt: true,
      expiresAt: true,
      lastUsedAt: true,
      revokedAt: true,
    },
    orderBy: { createdAt: "desc" },
  });
}

export function revokeSessionByIdForUser(
  sessionId: string,
  userId: string,
  db: DatabaseClient = prisma,
) {
  return db.session.updateMany({
    where: {
      id: sessionId,
      userId,
      revokedAt: null,
    },
    data: {
      revokedAt: new Date(),
    },
  });
}
