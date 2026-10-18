import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "@jest/globals";
import {
  testPrisma as prisma,
  disconnectTestDatabase,
} from "../helpers/database.js";
import {
  consumePasswordResetToken,
  createPasswordResetToken,
  findPasswordResetTokenByHash,
} from "../../src/repositories/password-reset-token.repository.js";

describe("Password reset token repository", () => {
  afterAll(async () => {
    await disconnectTestDatabase();
  });

  test("creates a password reset token", async () => {
    const user = await prisma.user.create({
      data: {
        email: `password-reset-${randomUUID()}@example.com`,
        passwordHash: "test-hash",
      },
    });

    const tokenHash = randomUUID();

    try {
      const token = await createPasswordResetToken({
        userId: user.id,
        tokenHash,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      });

      expect(token.userId).toBe(user.id);
      expect(token.tokenHash).toBe(tokenHash);
      expect(token.usedAt).toBeNull();

      const result = await findPasswordResetTokenByHash(tokenHash);

      expect(result?.id).toBe(token.id);
      expect(result?.userId).toBe(user.id);
    } finally {
      await prisma.user.delete({
        where: { id: user.id },
      });
    }
  });

  test("returns null when the token hash does not exist", async () => {
    const result = await findPasswordResetTokenByHash(randomUUID());

    expect(result).toBeNull();
  });

  test("consumes an unused, unexpired token only once", async () => {
    const user = await prisma.user.create({
      data: {
        email: `password-reset-${randomUUID()}@example.com`,
        passwordHash: "test-hash",
      },
    });

    const tokenHash = randomUUID();
    const now = new Date();

    try {
      await createPasswordResetToken({
        userId: user.id,
        tokenHash,
        expiresAt: new Date(now.getTime() + 60_000),
      });

      const first = await prisma.$transaction((tx) =>
        consumePasswordResetToken(tx, tokenHash, now),
      );

      const second = await prisma.$transaction((tx) =>
        consumePasswordResetToken(tx, tokenHash, now),
      );

      expect(first.count).toBe(1);
      expect(second.count).toBe(0);
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });
});
