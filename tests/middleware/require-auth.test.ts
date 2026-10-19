import express from "express";
import request from "supertest";
import { afterAll, describe, expect, test } from "@jest/globals";
import { requireAuth } from "../../src/middleware/require-auth.js";
import { disconnectTestDatabase, testPrisma } from "../helpers/database.js";
import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";

const protectedApp = express();

protectedApp.get("/protected", requireAuth, (req, res) => {
  res.status(200).json({
    user: req.auth?.user,
    session: req.auth?.session,
  });
});

afterAll(async () => {
  await disconnectTestDatabase();
});

describe("requireAuth middleware", () => {
  test("rejects requests without an authorization header", async () => {
    const response = await request(protectedApp).get("/protected");

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
  });

  test("rejects an invalid session token", async () => {
    const response = await request(protectedApp)
      .get("/protected")
      .set("Authorization", "Bearer invalid-session-token");

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
  });

  test("accepts a valid session and attaches the authenticated user", async () => {
    const email = `middleware-${randomUUID()}@example.com`;
    const password = "Strong-test-password-123";

    const user = await testPrisma.user.create({
      data: {
        email,
        passwordHash: await argon2.hash(password, {
          type: argon2.argon2id,
        }),
        emailVerifiedAt: new Date(),
      },
    });

    try {
      const login = await request((await import("../../src/app.js")).default)
        .post("/auth/login")
        .send({ email, password });

      expect(login.status).toBe(200);

      const response = await request(protectedApp)
        .get("/protected")
        .set("Authorization", `Bearer ${login.body.sessionToken}`);

      expect(response.status).toBe(200);
      expect(response.body.user.id).toBe(user.id);
      expect(response.body.user.email).toBe(email);
      expect(response.body.session.id).toBeDefined();
      expect(response.body.session.expiresAt).toBeDefined();
    } finally {
      await testPrisma.session.deleteMany({
        where: { userId: user.id },
      });

      await testPrisma.user.delete({
        where: { id: user.id },
      });
    }
  });

  test("rejects a revoked session", async () => {
    const email = `revoked-${randomUUID()}@example.com`;
    const password = "Strong-test-password-123";

    const user = await testPrisma.user.create({
      data: {
        email,
        passwordHash: await argon2.hash(password, {
          type: argon2.argon2id,
        }),
        emailVerifiedAt: new Date(),
      },
    });

    try {
      const app = (await import("../../src/app.js")).default;

      const login = await request(app)
        .post("/auth/login")
        .send({ email, password });

      expect(login.status).toBe(200);

      const sessionToken = login.body.sessionToken;

      // The token should work before logout.
      const beforeLogout = await request(protectedApp)
        .get("/protected")
        .set("Authorization", `Bearer ${sessionToken}`);

      expect(beforeLogout.status).toBe(200);

      // Revoke the session through the actual logout endpoint.
      const logout = await request(app)
        .post("/auth/logout")
        .set("Authorization", `Bearer ${sessionToken}`);

      expect(logout.status).toBe(200);

      // The same token must no longer authorize protected requests.
      const afterLogout = await request(protectedApp)
        .get("/protected")
        .set("Authorization", `Bearer ${sessionToken}`);

      expect(afterLogout.status).toBe(401);
      expect(afterLogout.body.error.code).toBe("UNAUTHENTICATED");
    } finally {
      await testPrisma.session.deleteMany({
        where: { userId: user.id },
      });

      await testPrisma.user.delete({
        where: { id: user.id },
      });
    }
  });

  test("rejects an expired session", async () => {
    const email = `expired-${randomUUID()}@example.com`;
    const password = "Strong-test-password-123";

    const user = await testPrisma.user.create({
      data: {
        email,
        passwordHash: await argon2.hash(password, {
          type: argon2.argon2id,
        }),
        emailVerifiedAt: new Date(),
      },
    });

    try {
      const login = await request((await import("../../src/app.js")).default)
        .post("/auth/login")
        .send({ email, password });

      expect(login.status).toBe(200);

      const tokenHash = createHash("sha256")
        .update(login.body.sessionToken)
        .digest("hex");

      await testPrisma.session.updateMany({
        where: {
          userId: user.id,
          tokenHash,
        },
        data: {
          expiresAt: new Date(Date.now() - 60_000),
        },
      });

      const response = await request(protectedApp)
        .get("/protected")
        .set("Authorization", `Bearer ${login.body.sessionToken}`);

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("UNAUTHENTICATED");
    } finally {
      await testPrisma.session.deleteMany({
        where: { userId: user.id },
      });

      await testPrisma.user.delete({
        where: { id: user.id },
      });
    }
  });
});
