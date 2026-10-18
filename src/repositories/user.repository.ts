import { prisma } from "../lib/prisma.js";
import type { DatabaseClient } from "../lib/prisma.js";
import { normalizeEmail } from "../utils/normalize-email.js";

type UpdateUserData = {
  passwordHash?: string;
  emailVerifiedAt?: Date | null;
};

export function createUser(
  data: { email: string; passwordHash: string },
  db: DatabaseClient = prisma,
) {
  return db.user.create({
    data: {
      email: normalizeEmail(data.email),
      passwordHash: data.passwordHash,
    },
  });
}

export function findUserById(id: string, db: DatabaseClient = prisma) {
  return db.user.findUnique({
    where: { id },
  });
}

export function updateUser(
  id: string,
  data: UpdateUserData,
  db: DatabaseClient = prisma,
) {
  return db.user.update({
    where: { id },
    data,
  });
}

export function findUserByEmail(email: string, db: DatabaseClient = prisma) {
  return db.user.findUnique({
    where: { email: normalizeEmail(email) },
  });
}
