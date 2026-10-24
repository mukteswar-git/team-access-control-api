import {
  afterAll,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import request from "supertest";
import argon2 from "argon2";
import { createHash, randomUUID } from "node:crypto";
import {
  testPrisma as prisma,
  disconnectTestDatabase,
} from "../../helpers/database.js";

const mockSendEmail = jest
  .fn<
    (options: { to: string; subject: string; html: string }) => Promise<void>
  >()
  .mockResolvedValue(undefined);

jest.unstable_mockModule("../../../src/lib/email.js", () => ({
  sendEmail: mockSendEmail,
}));

jest.unstable_mockModule("../../../src/middleware/rate-limit.js", () => {
  const passThrough = (
    _req: import("express").Request,
    _res: import("express").Response,
    next: import("express").NextFunction,
  ) => next();

  return {
    loginRateLimiter: passThrough,
    resendVerificationRateLimiter: passThrough,
    passwordResetRequestRateLimiter: passThrough,
    resetPasswordRateLimiter: passThrough,
  };
});

beforeEach(() => {
  mockSendEmail.mockReset();
  mockSendEmail.mockResolvedValue(undefined);
});

const { default: app } = await import("../../../src/app.js");

async function createVerificationFixture(
  expiresAt = new Date(Date.now() + 60_000),
) {
  const user = await prisma.user.create({
    data: {
      email: `verify-${randomUUID()}@example.com`,
      passwordHash: "test-hash",
    },
  });

  const rawToken = randomUUID() + randomUUID();
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");

  await prisma.emailVerificationToken.create({
    data: {
      userId: user.id,
      tokenHash,
      expiresAt,
    },
  });

  return { user, rawToken };
}

async function createPasswordResetFixture(
  expiresAt = new Date(Date.now() + 60_000),
) {
  const password = "Old-test-password-123";

  const user = await prisma.user.create({
    data: {
      email: `reset-${randomUUID()}@example.com`,
      passwordHash: await argon2.hash(password, {
        type: argon2.argon2id,
      }),
      emailVerifiedAt: new Date(),
    },
  });

  const rawToken = randomUUID() + randomUUID();
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");

  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash,
      expiresAt,
    },
  });

  return { user, password, rawToken };
}

afterAll(async () => {
  await disconnectTestDatabase();
});

describe("POST /auth/register", () => {
  test("registers a user and sends a verification email", async () => {
    const email = `register-${randomUUID()}@example.com`;
    const password = "Test-password-123";

    try {
      const response = await request(app)
        .post("/auth/register")
        .send({ email: `  ${email}  `, password });

      expect(response.status).toBe(201);
      expect(response.body.user.email).toBe(email);
      expect(response.body.user.passwordHash).toBeUndefined();
      expect(response.body.verificationToken).toBeUndefined();

      expect(mockSendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: email,
        }),
      );

      const user = await prisma.user.findUnique({
        where: { email },
      });

      expect(user).not.toBeNull();
      expect(user!.passwordHash).not.toBe(password);
      expect(await argon2.verify(user!.passwordHash, password)).toBe(true);
    } finally {
      await prisma.user.deleteMany({ where: { email } });
    }
  });

  test("rejects an invalid email", async () => {
    const response = await request(app)
      .post("/auth/register")
      .send({ email: "not-an-email", password: "Test-password-123" });

    expect(response.status).toBe(400);
  });

  test("rejects a password shorter than eight characters", async () => {
    const response = await request(app)
      .post("/auth/register")
      .send({ email: "short-password@example.com", password: "short" });

    expect(response.status).toBe(400);
  });

  test("rejects registration with an existing email", async () => {
    const email = `duplicate-${randomUUID()}@example.com`;
    const password = "Test-password-123";

    try {
      // Register the user for the first time.
      const firstResponse = await request(app)
        .post("/auth/register")
        .send({ email, password });

      expect(firstResponse.status).toBe(201);

      const originalUser = await prisma.user.findUnique({
        where: { email },
      });

      expect(originalUser).not.toBeNull();

      // Attempt to register again with the same email.
      const duplicateResponse = await request(app)
        .post("/auth/register")
        .send({ email, password });

      expect(duplicateResponse.status).toBe(409);

      // Ensure the original user still exists.
      const users = await prisma.user.findMany({
        where: { email },
      });

      expect(users).toHaveLength(1);
      expect(users[0].id).toBe(originalUser!.id);
      if (!originalUser) {
        throw new Error("Expected the registered user to exist");
      }

      expect(users[0].id).toBe(originalUser.id);
    } finally {
      await prisma.user.deleteMany({ where: { email } });
    }
  });
});

describe("POST /auth/login", () => {
  test("logs in a verified user with valid credentials", async () => {
    const email = `login-${randomUUID()}@example.com`;
    const password = "Strong-test-password-123";

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: await argon2.hash(password, {
          type: argon2.argon2id,
        }),
        emailVerifiedAt: new Date(),
      },
    });

    try {
      const response = await request(app)
        .post("/auth/login")
        .send({ email, password });

      expect(response.status).toBe(200);
      expect(response.body.user.id).toBe(user.id);
      expect(response.body.user.email).toBe(email);
      expect(response.body.user.passwordHash).toBeUndefined();
      expect(response.body.session.expiresAt).toBeDefined();
      expect(response.body.sessionToken).toEqual(expect.any(String));

      const session = await prisma.session.findFirst({
        where: { userId: user.id },
      });

      expect(session).not.toBeNull();
    } finally {
      await prisma.session.deleteMany({
        where: { userId: user.id },
      });

      await prisma.user.delete({
        where: { id: user.id },
      });
    }
  });

  test("rejects invalid credentials", async () => {
    const response = await request(app).post("/auth/login").send({
      email: "missing-user@example.com",
      password: "Wrong-password-123",
    });

    expect(response.status).toBe(401);
  });

  test("rejects login for an unverified user", async () => {
    const email = `unverified-${randomUUID()}@example.com`;
    const password = "Strong-test-password-123";

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: await argon2.hash(password, {
          type: argon2.argon2id,
        }),
        emailVerifiedAt: null,
      },
    });

    try {
      const response = await request(app)
        .post("/auth/login")
        .send({ email, password });

      expect(response.status).toBe(403);
    } finally {
      await prisma.user.delete({
        where: { id: user.id },
      });
    }
  });
});

describe("POST /auth/verify-email", () => {
  test("verifies an email and consumes the token", async () => {
    const { user, rawToken } = await createVerificationFixture();

    try {
      const response = await request(app)
        .post("/auth/verify-email")
        .send({ token: rawToken });

      expect(response.status).toBe(200);
      expect(response.body.user.id).toBe(user.id);
      expect(response.body.user.emailVerifiedAt).toBeDefined();

      const token = await prisma.emailVerificationToken.findFirst({
        where: { userId: user.id },
      });

      expect(token?.usedAt).toBeInstanceOf(Date);
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("rejects an invalid token", async () => {
    const response = await request(app)
      .post("/auth/verify-email")
      .send({ token: "invalid-token" });

    expect(response.status).toBe(400);
  });

  test("rejects an expired token", async () => {
    const { user, rawToken } = await createVerificationFixture(
      new Date(Date.now() - 1_000),
    );

    try {
      const response = await request(app)
        .post("/auth/verify-email")
        .send({ token: rawToken });

      expect(response.status).toBe(400);
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("rejects reuse of a verification token", async () => {
    const { user, rawToken } = await createVerificationFixture();

    try {
      const firstResponse = await request(app)
        .post("/auth/verify-email")
        .send({ token: rawToken });

      expect(firstResponse.status).toBe(200);

      const secondResponse = await request(app)
        .post("/auth/verify-email")
        .send({ token: rawToken });

      expect(secondResponse.status).toBe(400);
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });
});

describe("POST /auth/resend-verification", () => {
  test("sends a verification email for an unverified account", async () => {
    const email = `resend-${randomUUID()}@example.com`;

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: "test-hash",
      },
    });

    try {
      const response = await request(app)
        .post("/auth/resend-verification")
        .send({ email });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        message:
          "If the account exists and needs verification, verification instructions will be sent.",
      });

      expect(mockSendEmail).toHaveBeenCalledTimes(1);
      expect(mockSendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: email,
          subject: expect.stringContaining("Verify your email"),
        }),
      );
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("returns the same response for an unknown email", async () => {
    const response = await request(app)
      .post("/auth/resend-verification")
      .send({ email: `unknown-${randomUUID()}@example.com` });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      message:
        "If the account exists and needs verification, verification instructions will be sent.",
    });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  test("does not send a verification email to an already-verified account", async () => {
    const email = `verified-${randomUUID()}@example.com`;

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: "test-hash",
        emailVerifiedAt: new Date(),
      },
    });

    try {
      const response = await request(app)
        .post("/auth/resend-verification")
        .send({ email });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        message:
          "If the account exists and needs verification, verification instructions will be sent.",
      });
      expect(mockSendEmail).not.toHaveBeenCalled();
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("rejects an invalid email", async () => {
    const response = await request(app)
      .post("/auth/resend-verification")
      .send({ email: "not-an-email" });

    expect(response.status).toBe(400);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  test("returns an error when email delivery fails", async () => {
    const email = `delivery-failure-${randomUUID()}@example.com`;

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: "test-hash",
      },
    });

    mockSendEmail.mockRejectedValueOnce(new Error("Email delivery failed"));

    try {
      const response = await request(app)
        .post("/auth/resend-verification")
        .send({ email });

      expect(response.status).toBe(500);
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });
});

describe("POST /auth/request-password-reset", () => {
  test("sends a reset email for an existing email", async () => {
    const email = `reset-request-${randomUUID()}@example.com`;

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: await argon2.hash("Old-test-password-123", {
          type: argon2.argon2id,
        }),
        emailVerifiedAt: new Date(),
      },
    });

    try {
      const response = await request(app)
        .post("/auth/request-password-reset")
        .send({ email });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        message:
          "If an account exists for that email, password reset instructions will be sent.",
      });
      expect(response.body.resetToken).toBeUndefined();

      expect(mockSendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: email,
        }),
      );

      const token = await prisma.passwordResetToken.findFirst({
        where: { userId: user.id },
      });

      expect(token).not.toBeNull();
      expect(token!.usedAt).toBeNull();
      expect(token!.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("does not reveal whether an email exists", async () => {
    const email = `unknown-${randomUUID()}@example.com`;

    const response = await request(app)
      .post("/auth/request-password-reset")
      .send({ email });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      message:
        "If an account exists for that email, password reset instructions will be sent.",
    });
  });

  test("rejects an invalid email", async () => {
    const response = await request(app)
      .post("/auth/request-password-reset")
      .send({ email: "not-an-email" });

    expect(response.status).toBe(400);
  });
});

describe("POST /auth/reset-password", () => {
  test("resets the password and invalidates existing sessions", async () => {
    const { user, password, rawToken } = await createPasswordResetFixture();

    try {
      const loginResponse = await request(app)
        .post("/auth/login")
        .send({ email: user.email, password });

      expect(loginResponse.status).toBe(200);

      const response = await request(app).post("/auth/reset-password").send({
        token: rawToken,
        newPassword: "New-test-password-456",
      });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe("Password reset successful");

      const oldPasswordResponse = await request(app)
        .post("/auth/login")
        .send({ email: user.email, password });

      expect(oldPasswordResponse.status).toBe(401);

      const newPasswordResponse = await request(app).post("/auth/login").send({
        email: user.email,
        password: "New-test-password-456",
      });

      expect(newPasswordResponse.status).toBe(200);

      const tokenHash = createHash("sha256").update(rawToken).digest("hex");

      const token = await prisma.passwordResetToken.findUnique({
        where: { tokenHash },
      });

      expect(token?.usedAt).toBeInstanceOf(Date);
    } finally {
      await prisma.securityEvent.deleteMany({
        where: { userId: user.id },
      });

      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("rejects an invalid reset token", async () => {
    const response = await request(app).post("/auth/reset-password").send({
      token: "invalid-token",
      newPassword: "New-test-password-456",
    });

    expect(response.status).toBe(400);
  });

  test("rejects an expired reset token", async () => {
    const { user, rawToken } = await createPasswordResetFixture(
      new Date(Date.now() - 1_000),
    );

    try {
      const response = await request(app).post("/auth/reset-password").send({
        token: rawToken,
        newPassword: "New-test-password-456",
      });

      expect(response.status).toBe(400);
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("rejects a password shorter than eight characters", async () => {
    const response = await request(app).post("/auth/reset-password").send({
      token: "some-token",
      newPassword: "short",
    });

    expect(response.status).toBe(400);
  });
});

describe("POST /auth/logout", () => {
  test("rejects a request without a token", async () => {
    const response = await request(app).post("/auth/logout");

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
  });

  test("rejects an invalid session token", async () => {
    const response = await request(app)
      .post("/auth/logout")
      .set("Authorization", "Bearer invalid-session-token");

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
  });

  test("logs out a user and revokes their session", async () => {
    const email = `logout-${randomUUID()}@example.com`;
    const password = "Strong-test-password-123";

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: await argon2.hash(password, {
          type: argon2.argon2id,
        }),
        emailVerifiedAt: new Date(),
      },
    });

    try {
      const loginResponse = await request(app)
        .post("/auth/login")
        .send({ email, password });

      expect(loginResponse.status).toBe(200);

      const token = loginResponse.body.sessionToken as string;

      const logoutResponse = await request(app)
        .post("/auth/logout")
        .set("Authorization", `Bearer ${token}`);

      expect(logoutResponse.status).toBe(200);
      expect(logoutResponse.body.message).toBe("Logout successful");

      const session = await prisma.session.findFirst({
        where: { userId: user.id },
      });

      expect(session?.revokedAt).toBeInstanceOf(Date);

      // The revoked token must no longer authenticate requests.
      const reuseResponse = await request(app)
        .post("/auth/logout")
        .set("Authorization", `Bearer ${token}`);

      expect(reuseResponse.status).toBe(401);
    } finally {
      await prisma.session.deleteMany({
        where: { userId: user.id },
      });

      await prisma.user.delete({
        where: { id: user.id },
      });
    }
  });
});

describe("GET /auth/sessions", () => {
  test("rejects a request without a token", async () => {
    const response = await request(app).get("/auth/sessions");

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
  });

  test("lists session metadata without exposing token hashes", async () => {
    const email = `sessions-${randomUUID()}@example.com`;
    const password = "Strong-test-password-123";

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: await argon2.hash(password, {
          type: argon2.argon2id,
        }),
        emailVerifiedAt: new Date(),
      },
    });

    try {
      const loginResponse = await request(app)
        .post("/auth/login")
        .send({ email, password });

      const token = loginResponse.body.sessionToken as string;

      const response = await request(app)
        .get("/auth/sessions")
        .set("Authorization", `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.sessions).toHaveLength(1);
      expect(response.body.sessions[0]).toMatchObject({
        id: expect.any(String),
        createdAt: expect.any(String),
        expiresAt: expect.any(String),
      });
      expect(response.body.sessions[0]).not.toHaveProperty("tokenHash");
    } finally {
      await prisma.session.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });
});

describe("DELETE /auth/sessions/:sessionId", () => {
  test("rejects an invalid session ID", async () => {
    const email = `invalid-session-${randomUUID()}@example.com`;
    const password = "Strong-test-password-123";

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: await argon2.hash(password, {
          type: argon2.argon2id,
        }),
        emailVerifiedAt: new Date(),
      },
    });

    try {
      const loginResponse = await request(app)
        .post("/auth/login")
        .send({ email, password });

      const token = loginResponse.body.sessionToken as string;

      const response = await request(app)
        .delete("/auth/sessions/invalid-id")
        .set("Authorization", `Bearer ${token}`);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    } finally {
      await prisma.session.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("rejects a request without a token", async () => {
    const response = await request(app).delete(
      `/auth/sessions/${randomUUID()}`,
    );

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
  });

  test("revokes the authenticated user's session", async () => {
    const email = `revoke-session-${randomUUID()}@example.com`;
    const password = "Strong-test-password-123";

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: await argon2.hash(password, {
          type: argon2.argon2id,
        }),
        emailVerifiedAt: new Date(),
      },
    });

    try {
      const loginResponse = await request(app)
        .post("/auth/login")
        .send({ email, password });

      const token = loginResponse.body.sessionToken as string;
      const session = await prisma.session.findFirstOrThrow({
        where: { userId: user.id },
      });

      const response = await request(app)
        .delete(`/auth/sessions/${session.id}`)
        .set("Authorization", `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.message).toBe("Session revoked successfully");

      const revokedSession = await prisma.session.findUniqueOrThrow({
        where: { id: session.id },
      });

      expect(revokedSession.revokedAt).toBeInstanceOf(Date);
    } finally {
      await prisma.session.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("does not revoke another user's session", async () => {
    const firstEmail = `owner-${randomUUID()}@example.com`;
    const secondEmail = `other-${randomUUID()}@example.com`;
    const password = "Strong-test-password-123";

    const firstUser = await prisma.user.create({
      data: {
        email: firstEmail,
        passwordHash: await argon2.hash(password, {
          type: argon2.argon2id,
        }),
        emailVerifiedAt: new Date(),
      },
    });

    const secondUser = await prisma.user.create({
      data: {
        email: secondEmail,
        passwordHash: await argon2.hash(password, {
          type: argon2.argon2id,
        }),
        emailVerifiedAt: new Date(),
      },
    });

    try {
      const sessionToken = randomUUID() + randomUUID();

      await prisma.session.create({
        data: {
          userId: firstUser.id,
          tokenHash: createHash("sha256").update(sessionToken).digest("hex"),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });

      const otherSession = await prisma.session.create({
        data: {
          userId: secondUser.id,
          tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });

      const response = await request(app)
        .delete(`/auth/sessions/${otherSession.id}`)
        .set("Authorization", `Bearer ${sessionToken}`);

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("SESSION_NOT_FOUND");

      const unchangedSession = await prisma.session.findUniqueOrThrow({
        where: { id: otherSession.id },
      });

      expect(unchangedSession.revokedAt).toBeNull();
    } finally {
      await prisma.session.deleteMany({
        where: { userId: { in: [firstUser.id, secondUser.id] } },
      });

      await prisma.user.deleteMany({
        where: { id: { in: [firstUser.id, secondUser.id] } },
      });
    }
  });
});

describe("DELETE /auth/sessions", () => {
  test("rejects a request without a token", async () => {
    const response = await request(app).delete("/auth/sessions");

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
  });

  test("revokes all sessions belonging to the authenticated user", async () => {
    const user = await prisma.user.create({
      data: {
        email: `revoke-all-${randomUUID()}@example.com`,
        passwordHash: await argon2.hash("Strong-test-password-123", {
          type: argon2.argon2id,
        }),
        emailVerifiedAt: new Date(),
      },
    });

    const firstToken = randomUUID();
    const secondToken = randomUUID();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    try {
      await prisma.session.createMany({
        data: [firstToken, secondToken].map((token) => ({
          userId: user.id,
          tokenHash: createHash("sha256").update(token).digest("hex"),
          expiresAt,
        })),
      });

      const response = await request(app)
        .delete("/auth/sessions")
        .set("Authorization", `Bearer ${firstToken}`);

      expect(response.status).toBe(200);
      expect(response.body.revokedCount).toBe(2);

      const sessions = await prisma.session.findMany({
        where: { userId: user.id },
      });

      expect(sessions).toHaveLength(2);
      expect(sessions.every((session) => session.revokedAt !== null)).toBe(
        true,
      );

      // Both tokens must stop authenticating after revocation.
      for (const token of [firstToken, secondToken]) {
        const reuseResponse = await request(app)
          .get("/auth/sessions")
          .set("Authorization", `Bearer ${token}`);

        expect(reuseResponse.status).toBe(401);
      }
    } finally {
      await prisma.session.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });
});
