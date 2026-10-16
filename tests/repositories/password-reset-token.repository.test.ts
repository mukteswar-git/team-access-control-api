import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "@jest/globals";
import {
  testPrisma as prisma,
  disconnectTestDatabase,
} from "../helpers/database.js";
import {
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
});
