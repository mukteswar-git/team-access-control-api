import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "@jest/globals";
import {
  testPrisma as prisma,
  disconnectTestDatabase,
} from "../helpers/database.js";
import {
  createUser,
  findUserById,
  updateUser,
  findUserByEmail,
} from "../../src/repositories/user.repository.js";

describe("User repository", () => {
  afterAll(async () => {
    await disconnectTestDatabase();
  });

  test("creates a user with a normalized email", async () => {
    const email = `  ${randomUUID().toUpperCase()}@EXAMPLE.COM  `;

    const user = await createUser({
      email,
      passwordHash: "test-hash",
    });

    try {
      expect(user.email).toBe(email.trim().toLowerCase());
      expect(user.passwordHash).toBe("test-hash");
    } finally {
      await prisma.user.delete({
        where: { id: user.id },
      });
    }
  });

  test("rejects a duplicate email", async () => {
    const email = `duplicate-${randomUUID()}@example.com`;

    const user = await createUser({
      email,
      passwordHash: "test-hash",
    });

    try {
      await expect(
        createUser({
          email: email.toUpperCase(),
          passwordHash: "another-test-hash",
        }),
      ).rejects.toMatchObject({
        code: "P2002",
      });
    } finally {
      await prisma.user.delete({
        where: { id: user.id },
      });
    }
  });

  test("finds a user by ID", async () => {
    const user = await prisma.user.create({
      data: {
        email: `repository-${randomUUID()}@example.com`,
        passwordHash: "test-hash",
      },
    });

    try {
      const result = await findUserById(user.id);

      expect(result?.id).toBe(user.id);
      expect(result?.email).toBe(user.email);
    } finally {
      await prisma.user.delete({
        where: { id: user.id },
      });
    }
  });

  test("returns null when the user ID does not exist", async () => {
    const result = await findUserById(randomUUID());

    expect(result).toBeNull();
  });

  test("updates a user's password hash", async () => {
    const user = await createUser({
      email: `update-${randomUUID()}@example.com`,
      passwordHash: "old-test-hash",
    });

    try {
      const updatedUser = await updateUser(user.id, {
        passwordHash: "new-test-hash",
      });

      expect(updatedUser.passwordHash).toBe("new-test-hash");
    } finally {
      await prisma.user.delete({
        where: { id: user.id },
      });
    }
  });

  test("updates a user's email verification timestamp", async () => {
    const user = await createUser({
      email: `verify-${randomUUID()}@example.com`,
      passwordHash: "test-hash",
    });

    const verifiedAt = new Date();

    try {
      const updatedUser = await updateUser(user.id, {
        emailVerifiedAt: verifiedAt,
      });

      expect(updatedUser.emailVerifiedAt?.getTime()).toBe(verifiedAt.getTime());
    } finally {
      await prisma.user.delete({
        where: { id: user.id },
      });
    }
  });

  test("normalizes email when looking up a user", async () => {
    const email = `repository-${randomUUID()}@example.com`;

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: "test-hash",
      },
    });

    try {
      const result = await findUserByEmail(`  ${email.toUpperCase()}  `);

      expect(result?.id).toBe(user.id);
    } finally {
      await prisma.user.delete({
        where: { id: user.id },
      });
    }
  });

  test("finds a user by email", async () => {
    const email = `repository-${randomUUID()}@example.com`;

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: "test-hash",
      },
    });

    try {
      const result = await findUserByEmail(email);

      expect(result).not.toBeNull();
      expect(result?.id).toBe(user.id);
      expect(result?.email).toBe(email);
      expect(result?.passwordHash).toBe("test-hash");
    } finally {
      await prisma.user.delete({
        where: { id: user.id },
      });
    }
  });

  test("returns null when the email does not exist", async () => {
    const result = await findUserByEmail(`missing-${randomUUID()}@example.com`);

    expect(result).toBeNull();
  });
});
