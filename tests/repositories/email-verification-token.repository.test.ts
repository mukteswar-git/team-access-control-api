import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "@jest/globals";
import {
  testPrisma as prisma,
  disconnectTestDatabase,
} from "../helpers/database.js";
import {
  consumeEmailVerificationToken,
  createEmailVerificationToken,
  findEmailVerificationTokenByHash,
} from "../../src/repositories/email-verification-token.repository.js";

describe("Email verification token repository", () => {
  afterAll(async () => {
    await disconnectTestDatabase();
  });

  test("creates an email verification token", async () => {
    const user = await prisma.user.create({
      data: {
        email: `verification-${randomUUID()}@example.com`,
        passwordHash: "test-hash",
      },
    });

    const tokenHash = randomUUID();

    try {
      const token = await createEmailVerificationToken({
        userId: user.id,
        tokenHash,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });

      expect(token.userId).toBe(user.id);
      expect(token.tokenHash).toBe(tokenHash);
      expect(token.usedAt).toBeNull();

      const result = await findEmailVerificationTokenByHash(tokenHash);

      expect(result?.id).toBe(token.id);
      expect(result?.userId).toBe(user.id);
    } finally {
      await prisma.user.delete({
        where: { id: user.id },
      });
    }
  });

  test("returns null when the token hash does not exist", async () => {
    const result = await findEmailVerificationTokenByHash(randomUUID());

    expect(result).toBeNull();
  });

  test("consumes an unused, unexpired token only once", async () => {
    const user = await prisma.user.create({
      data: {
        email: `verification-${randomUUID()}@example.com`,
        passwordHash: "test-hash",
      },
    });

    const tokenHash = randomUUID();
    const now = new Date();

    try {
      await createEmailVerificationToken({
        userId: user.id,
        tokenHash,
        expiresAt: new Date(now.getTime() + 60_000),
      });

      const first = await prisma.$transaction((tx) =>
        consumeEmailVerificationToken(tx, tokenHash, now),
      );

      const second = await prisma.$transaction((tx) =>
        consumeEmailVerificationToken(tx, tokenHash, now),
      );

      expect(first.count).toBe(1);
      expect(second.count).toBe(0);
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });
});
