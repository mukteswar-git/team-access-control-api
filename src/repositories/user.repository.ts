import { prisma } from "../lib/prisma.js";
import { normalizeEmail } from "../utils/normalize-email.js";

type UpdateUserData = {
  passwordHash?: string;
  emailVerifiedAt?: Date | null;
};

export function createUser(data: { email: string; passwordHash: string }) {
  return prisma.user.create({
    data: {
      email: normalizeEmail(data.email),
      passwordHash: data.passwordHash,
    },
  });
}

export function findUserById(id: string) {
  return prisma.user.findUnique({
    where: { id },
  });
}

export function updateUser(id: string, data: UpdateUserData) {
  return prisma.user.update({
    where: { id },
    data,
  });
}

export function findUserByEmail(email: string) {
  return prisma.user.findUnique({
    where: { email: normalizeEmail(email) },
  });
}
