import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, test } from "@jest/globals";
import {
  testPrisma as prisma,
  disconnectTestDatabase,
} from "../helpers/database.js";
import {
  createSession,
  findSessionByTokenHash,
  revokeSessionByTokenHash,
  revokeAllSessionsForUser,
  findSessionsByUserId,
  revokeSessionByIdForUser,
} from "../../src/repositories/session.repository.js";

describe("Session repository", () => {
  const createdUserIds: string[] = [];

  afterEach(async () => {
    await prisma.user.deleteMany({
      where: {
        id: { in: createdUserIds },
      },
    });

    createdUserIds.length = 0;
  });

  afterAll(async () => {
    await disconnectTestDatabase();
  });

  test("creates a session", async () => {
    const user = await prisma.user.create({
      data: {
        email: `${randomUUID()}@example.com`,
        passwordHash: "test-hash",
      },
    });

    createdUserIds.push(user.id);

    const tokenHash = randomUUID();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    const session = await createSession({
      userId: user.id,
      tokenHash,
      expiresAt,
    });

    expect(session.userId).toBe(user.id);
    expect(session.tokenHash).toBe(tokenHash);
    expect(session.expiresAt).toEqual(expiresAt);
    expect(session.revokedAt).toBeNull();
    expect(session.lastUsedAt).toBeNull();
  });

  test("finds a session by token hash", async () => {
    const user = await prisma.user.create({
      data: {
        email: `${randomUUID()}@example.com`,
        passwordHash: "test-hash",
      },
    });

    createdUserIds.push(user.id);

    const tokenHash = randomUUID();

    await createSession({
      userId: user.id,
      tokenHash,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const session = await findSessionByTokenHash(tokenHash);

    expect(session).not.toBeNull();
    expect(session?.userId).toBe(user.id);
    expect(session?.tokenHash).toBe(tokenHash);
  });

  test("returns null when a session is not found", async () => {
    const session = await findSessionByTokenHash(randomUUID());

    expect(session).toBeNull();
  });

  test("revokes a session by token hash", async () => {
    const user = await prisma.user.create({
      data: {
        email: `${randomUUID()}@example.com`,
        passwordHash: "test-hash",
      },
    });

    createdUserIds.push(user.id);

    const tokenHash = randomUUID();

    await createSession({
      userId: user.id,
      tokenHash,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const result = await revokeSessionByTokenHash(tokenHash);
    const session = await findSessionByTokenHash(tokenHash);

    expect(result.count).toBe(1);
    expect(session?.revokedAt).toBeInstanceOf(Date);
  });

  test("does not revoke an already-revoked session again", async () => {
    const user = await prisma.user.create({
      data: {
        email: `${randomUUID()}@example.com`,
        passwordHash: "test-hash",
      },
    });

    createdUserIds.push(user.id);

    const tokenHash = randomUUID();

    await createSession({
      userId: user.id,
      tokenHash,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    await revokeSessionByTokenHash(tokenHash);

    const sessionBefore = await findSessionByTokenHash(tokenHash);
    const result = await revokeSessionByTokenHash(tokenHash);
    const sessionAfter = await findSessionByTokenHash(tokenHash);

    expect(result.count).toBe(0);
    expect(sessionAfter?.revokedAt).toEqual(sessionBefore?.revokedAt);
  });

  test("revokes all active sessions for a user only", async () => {
    const user1 = await prisma.user.create({
      data: {
        email: `${randomUUID()}@example.com`,
        passwordHash: "test-hash",
      },
    });
    createdUserIds.push(user1.id);

    const user2 = await prisma.user.create({
      data: {
        email: `${randomUUID()}@example.com`,
        passwordHash: "test-hash",
      },
    });
    createdUserIds.push(user2.id);

    const user1Token1 = randomUUID();
    const user1Token2 = randomUUID();
    const user2Token = randomUUID();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    await createSession({
      userId: user1.id,
      tokenHash: user1Token1,
      expiresAt,
    });

    await createSession({
      userId: user1.id,
      tokenHash: user1Token2,
      expiresAt,
    });

    await createSession({
      userId: user2.id,
      tokenHash: user2Token,
      expiresAt,
    });

    const result = await revokeAllSessionsForUser(user1.id);

    const session1 = await findSessionByTokenHash(user1Token1);
    const session2 = await findSessionByTokenHash(user1Token2);
    const session3 = await findSessionByTokenHash(user2Token);

    expect(result.count).toBe(2);
    expect(session1?.revokedAt).toBeInstanceOf(Date);
    expect(session2?.revokedAt).toBeInstanceOf(Date);
    expect(session3?.revokedAt).toBeNull();
  });

  test("lists session metadata without exposing token hashes", async () => {
    const user = await prisma.user.create({
      data: {
        email: `${randomUUID()}@example.com`,
        passwordHash: "test-hash",
      },
    });

    createdUserIds.push(user.id);

    const tokenHash = randomUUID();

    await createSession({
      userId: user.id,
      tokenHash,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const sessions = await findSessionsByUserId(user.id);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: expect.any(String),
      createdAt: expect.any(Date),
      expiresAt: expect.any(Date),
      lastUsedAt: null,
      revokedAt: null,
    });
    expect(sessions[0]).not.toHaveProperty("tokenHash");
  });

  test("revokes a session only when both session ID and user ID match", async () => {
    const user1 = await prisma.user.create({
      data: {
        email: `${randomUUID()}@example.com`,
        passwordHash: "test-hash",
      },
    });
    createdUserIds.push(user1.id);

    const user2 = await prisma.user.create({
      data: {
        email: `${randomUUID()}@example.com`,
        passwordHash: "test-hash",
      },
    });
    createdUserIds.push(user2.id);

    const tokenHash = randomUUID();

    const session = await createSession({
      userId: user1.id,
      tokenHash,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const unauthorizedResult = await revokeSessionByIdForUser(
      session.id,
      user2.id,
    );

    expect(unauthorizedResult.count).toBe(0);

    const result = await revokeSessionByIdForUser(session.id, user1.id);

    expect(result.count).toBe(1);

    const storedSession = await findSessionByTokenHash(tokenHash);
    expect(storedSession?.revokedAt).toBeInstanceOf(Date);
  });
});
