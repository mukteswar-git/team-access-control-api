import { randomUUID, createHash } from "node:crypto";
import argon2 from "argon2";
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
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

const {
  registerUser,
  verifyEmail,
  requestEmailVerification,
  loginUser,
  logoutUser,
  validateSession,
  requestPasswordReset,
  resetPassword,
  listUserSessions,
  revokeUserSession,
  revokeAllUserSessions,
} = await import("../../../src/modules/auth/auth.service.js");

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

async function createLoginFixture(options?: { emailVerified?: boolean }) {
  const password = "Strong-test-password-123";
  const user = await prisma.user.create({
    data: {
      email: `login-${randomUUID()}@example.com`,
      passwordHash: await argon2.hash(password, {
        type: argon2.argon2id,
      }),
      emailVerifiedAt: options?.emailVerified === false ? null : new Date(),
    },
  });

  return { user, password };
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

  return { user, password, rawToken, tokenHash };
}

describe("Auth service — registerUser", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDatabase();
  });

  test("creates a user with a normalized email and hashed password", async () => {
    const email = `  ${randomUUID().toUpperCase()}@EXAMPLE.COM  `;
    const password = "Strong-test-password-123";

    const result = await registerUser({ email, password });

    try {
      const user = await prisma.user.findUnique({
        where: { id: result.user.id },
      });

      expect(result.user.email).toBe(email.trim().toLowerCase());
      expect(mockSendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: email.trim().toLowerCase(),
          subject: "Verify your email — Team Access Control",
          html: expect.stringContaining("/verify-email?token="),
        }),
      );
      expect(result.user.emailVerifiedAt).toBeNull();
      expect(user).not.toBeNull();
      expect(user?.passwordHash).not.toBe(password);
      expect(await argon2.verify(user!.passwordHash, password)).toBe(true);
    } finally {
      await prisma.user.delete({ where: { id: result.user.id } });
    }
  });

  test("stores only the hash of the verification token", async () => {
    const email = `verification-${randomUUID()}@example.com`;

    const result = await registerUser({
      email,
      password: "Strong-test-password-123",
    });

    try {
      const emailCall = mockSendEmail.mock.calls.at(-1)?.[0];

      expect(emailCall).toBeDefined();

      const match = emailCall!.html.match(/[?&]token=([^&" ]+)/);

      expect(match).not.toBeNull();

      const rawToken = decodeURIComponent(match![1]!);
      const tokenHash = createHash("sha256").update(rawToken).digest("hex");

      const token = await prisma.emailVerificationToken.findUnique({
        where: { tokenHash },
      });

      expect(token).not.toBeNull();
      expect(token?.userId).toBe(result.user.id);
      expect(token?.usedAt).toBeNull();
      expect(token?.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(tokenHash).not.toBe(rawToken);
    } finally {
      await prisma.user.delete({ where: { id: result.user.id } });
    }
  });

  test("rejects a duplicate email", async () => {
    const email = `duplicate-${randomUUID()}@example.com`;

    const first = await registerUser({
      email,
      password: "Strong-test-password-123",
    });

    try {
      await expect(
        registerUser({
          email: email.toUpperCase(),
          password: "Another-test-password-123",
        }),
      ).rejects.toMatchObject({
        code: "EMAIL_ALREADY_EXISTS",
      });
    } finally {
      await prisma.user.delete({ where: { id: first.user.id } });
    }
  });

  test("rejects an empty email or password", async () => {
    await expect(
      registerUser({ email: "", password: "Strong-test-password-123" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    await expect(
      registerUser({
        email: `empty-${randomUUID()}@example.com`,
        password: "",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  test("verifies an email and consumes the token", async () => {
    const { user, rawToken } = await createVerificationFixture();

    try {
      const result = await verifyEmail(rawToken);

      expect(result.id).toBe(user.id);
      expect(result.emailVerifiedAt).toBeInstanceOf(Date);

      const token = await prisma.emailVerificationToken.findFirst({
        where: { userId: user.id },
      });

      expect(token?.usedAt).toBeInstanceOf(Date);
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("rejects an invalid verification token", async () => {
    await expect(verifyEmail("invalid-token")).rejects.toMatchObject({
      code: "INVALID_OR_EXPIRED_TOKEN",
    });
  });

  test("rejects an expired verification token", async () => {
    const { user, rawToken } = await createVerificationFixture(
      new Date(Date.now() - 1_000),
    );

    try {
      await expect(verifyEmail(rawToken)).rejects.toMatchObject({
        code: "INVALID_OR_EXPIRED_TOKEN",
      });
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("rejects reuse of a verification token", async () => {
    const { user, rawToken } = await createVerificationFixture();

    try {
      await verifyEmail(rawToken);

      await expect(verifyEmail(rawToken)).rejects.toMatchObject({
        code: "INVALID_OR_EXPIRED_TOKEN",
      });
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("does not allow concurrent reuse of a verification token", async () => {
    const { user, rawToken } = await createVerificationFixture();

    try {
      const results = await Promise.allSettled([
        verifyEmail(rawToken),
        verifyEmail(rawToken),
      ]);

      const successfulVerifications = results.filter(
        (result) => result.status === "fulfilled",
      );

      const failedVerifications = results.filter(
        (result) => result.status === "rejected",
      );

      expect(successfulVerifications).toHaveLength(1);
      expect(failedVerifications).toHaveLength(1);

      const token = await prisma.emailVerificationToken.findFirst({
        where: { userId: user.id },
      });

      const updatedUser = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });

      expect(token?.usedAt).toBeInstanceOf(Date);
      expect(updatedUser.emailVerifiedAt).toBeInstanceOf(Date);
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });
});

describe("Auth service — requestEmailVerification", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("sends a verification link and stores only the token hash", async () => {
    const user = await prisma.user.create({
      data: {
        email: `resend-${randomUUID()}@example.com`,
        passwordHash: "test-hash",
      },
    });

    try {
      await expect(
        requestEmailVerification(user.email),
      ).resolves.toBeUndefined();

      expect(mockSendEmail).toHaveBeenCalledTimes(1);

      const email = mockSendEmail.mock.calls[0]![0];
      expect(email.to).toBe(user.email);
      expect(email.subject).toContain("Verify your email");

      const match = email.html.match(/[?&]token=([a-f0-9]{64})/);
      expect(match).not.toBeNull();

      const rawToken = match![1]!;
      const tokenHash = createHash("sha256").update(rawToken).digest("hex");

      const token = await prisma.emailVerificationToken.findUnique({
        where: { tokenHash },
      });

      expect(token).not.toBeNull();
      expect(token?.userId).toBe(user.id);
      expect(token?.usedAt).toBeNull();
      expect(token?.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(tokenHash).not.toBe(rawToken);
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("does not reveal whether an account exists", async () => {
    const unknownEmail = `unknown-${randomUUID()}@example.com`;

    await expect(
      requestEmailVerification(unknownEmail),
    ).resolves.toBeUndefined();

    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  test("does not send another verification email to an already-verified user", async () => {
    const user = await prisma.user.create({
      data: {
        email: `verified-${randomUUID()}@example.com`,
        passwordHash: "test-hash",
        emailVerifiedAt: new Date(),
      },
    });

    try {
      await expect(
        requestEmailVerification(user.email),
      ).resolves.toBeUndefined();

      expect(mockSendEmail).not.toHaveBeenCalled();
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("invalidates previous unused tokens when requesting a new email", async () => {
    const { user } = await createLoginFixture({ emailVerified: false });

    const oldRawToken = randomUUID() + randomUUID();
    const oldTokenHash = createHash("sha256").update(oldRawToken).digest("hex");

    try {
      await prisma.emailVerificationToken.create({
        data: {
          userId: user.id,
          tokenHash: oldTokenHash,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });

      await requestEmailVerification(user.email);

      const oldToken = await prisma.emailVerificationToken.findUnique({
        where: { tokenHash: oldTokenHash },
      });

      expect(oldToken).toBeNull();
      expect(mockSendEmail).toHaveBeenCalledTimes(1);
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("removes the new unused token when email delivery fails", async () => {
    const user = await prisma.user.create({
      data: {
        email: `delivery-failure-${randomUUID()}@example.com`,
        passwordHash: "test-hash",
      },
    });

    mockSendEmail.mockRejectedValueOnce(new Error("Email delivery failed"));

    try {
      await expect(requestEmailVerification(user.email)).rejects.toThrow(
        "Email delivery failed",
      );

      const email = mockSendEmail.mock.calls[0]![0];
      const match = email.html.match(/[?&]token=([a-f0-9]{64})/);

      expect(match).not.toBeNull();

      const tokenHash = createHash("sha256").update(match![1]!).digest("hex");

      await expect(
        prisma.emailVerificationToken.findUnique({
          where: { tokenHash },
        }),
      ).resolves.toBeNull();
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });
});

describe("Auth service — loginUser", () => {
  test("logs in a verified user and stores only the session token hash", async () => {
    const { user, password } = await createLoginFixture();

    try {
      const result = await loginUser({
        email: user.email.toUpperCase(),
        password,
      });

      expect(result.user.id).toBe(user.id);
      expect(result.user.email).toBe(user.email);
      expect(result.session.token).toBeTruthy();
      expect(result.session.expiresAt.getTime()).toBeGreaterThan(Date.now());

      const tokenHash = createHash("sha256")
        .update(result.session.token)
        .digest("hex");

      const session = await prisma.session.findUnique({
        where: { tokenHash },
      });

      expect(session).not.toBeNull();
      expect(session?.userId).toBe(user.id);
      expect(session?.tokenHash).not.toBe(result.session.token);
      expect(session?.revokedAt).toBeNull();
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("rejects an incorrect password", async () => {
    const { user } = await createLoginFixture();

    try {
      await expect(
        loginUser({
          email: user.email,
          password: "Wrong-password",
        }),
      ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("rejects an unknown email with generic credentials error", async () => {
    await expect(
      loginUser({
        email: `unknown-${randomUUID()}@example.com`,
        password: "Strong-test-password-123",
      }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  });

  test("rejects a user whose email is not verified", async () => {
    const { user, password } = await createLoginFixture({
      emailVerified: false,
    });

    try {
      await expect(
        loginUser({ email: user.email, password }),
      ).rejects.toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });
});

describe("Auth service — logoutUser", () => {
  test("revokes an active session", async () => {
    const { user, password } = await createLoginFixture();

    try {
      const login = await loginUser({ email: user.email, password });

      await logoutUser(login.session.token);

      const tokenHash = createHash("sha256")
        .update(login.session.token)
        .digest("hex");

      const session = await prisma.session.findUnique({
        where: { tokenHash },
      });

      expect(session?.revokedAt).toBeInstanceOf(Date);
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("does not change the timestamp when revoking an already-revoked session", async () => {
    const { user, password } = await createLoginFixture();

    try {
      const login = await loginUser({ email: user.email, password });

      await logoutUser(login.session.token);

      const tokenHash = createHash("sha256")
        .update(login.session.token)
        .digest("hex");

      const firstSession = await prisma.session.findUniqueOrThrow({
        where: { tokenHash },
      });

      await logoutUser(login.session.token);

      const secondSession = await prisma.session.findUniqueOrThrow({
        where: { tokenHash },
      });

      expect(secondSession.revokedAt?.getTime()).toBe(
        firstSession.revokedAt?.getTime(),
      );
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("does not throw for an unknown token", async () => {
    await expect(logoutUser(randomUUID())).resolves.toBeUndefined();
  });

  test("does not throw for an empty token", async () => {
    await expect(logoutUser("")).resolves.toBeUndefined();
  });
});

describe("Auth service — validateSession", () => {
  test("returns user information for a valid session", async () => {
    const { user, password } = await createLoginFixture();

    try {
      const login = await loginUser({ email: user.email, password });
      const result = await validateSession(login.session.token);

      expect(result?.user.id).toBe(user.id);
      expect(result?.user.email).toBe(user.email);
      expect(result?.session.id).toBe(login.session.id);
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("returns null for an unknown token", async () => {
    await expect(validateSession(randomUUID())).resolves.toBeNull();
  });

  test("returns null for an empty token", async () => {
    await expect(validateSession("")).resolves.toBeNull();
  });

  test("returns null for a revoked session", async () => {
    const { user, password } = await createLoginFixture();

    try {
      const login = await loginUser({ email: user.email, password });
      await logoutUser(login.session.token);

      await expect(validateSession(login.session.token)).resolves.toBeNull();
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("returns null for an expired session", async () => {
    const { user, password } = await createLoginFixture();

    try {
      const login = await loginUser({ email: user.email, password });
      const tokenHash = createHash("sha256")
        .update(login.session.token)
        .digest("hex");

      await prisma.session.update({
        where: { tokenHash },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });

      await expect(validateSession(login.session.token)).resolves.toBeNull();
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });
});

describe("Auth service — requestPasswordReset", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("sends a reset link and stores only the token hash", async () => {
    const { user } = await createLoginFixture();

    try {
      const result = await requestPasswordReset(user.email);

      expect(result).toBeUndefined();
      expect(mockSendEmail).toHaveBeenCalledTimes(1);

      const email = mockSendEmail.mock.calls[0][0];
      expect(email.to).toBe(user.email);
      expect(email.subject).toContain("Reset your password");

      const match = email.html.match(/[?&]token=([a-f0-9]{64})/);
      expect(match).not.toBeNull();

      const rawToken = match![1];
      const tokenHash = createHash("sha256").update(rawToken).digest("hex");

      const token = await prisma.passwordResetToken.findUnique({
        where: { tokenHash },
      });

      expect(token).not.toBeNull();
      expect(token?.userId).toBe(user.id);
      expect(token?.usedAt).toBeNull();
      expect(token?.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(tokenHash).not.toBe(rawToken);
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("does not reveal whether an email exists", async () => {
    const unknownEmail = `unknown-${randomUUID()}@example.com`;

    await expect(requestPasswordReset(unknownEmail)).resolves.toBeUndefined();
  });
});

describe("Auth service — resetPassword", () => {
  test("resets the password and consumes the token", async () => {
    const { user, rawToken, password, tokenHash } =
      await createPasswordResetFixture();

    const newPassword = "New-test-password-456";

    try {
      await expect(resetPassword(rawToken, newPassword)).resolves.toEqual({
        success: true,
      });

      const updatedUser = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });

      expect(updatedUser.passwordHash).not.toBe(password);
      expect(await argon2.verify(updatedUser.passwordHash, newPassword)).toBe(
        true,
      );

      const token = await prisma.passwordResetToken.findUnique({
        where: { tokenHash },
      });

      expect(token?.usedAt).toBeInstanceOf(Date);

      await expect(
        resetPassword(rawToken, "Another-test-password-789"),
      ).rejects.toMatchObject({
        code: "INVALID_OR_EXPIRED_TOKEN",
      });

      const securityEvents = await prisma.securityEvent.findMany({
        where: {
          userId: user.id,
          eventType: "PASSWORD_RESET_COMPLETED",
        },
      });

      expect(securityEvents).toHaveLength(1);
      expect(securityEvents[0]?.metadata).toEqual({});
    } finally {
      await prisma.securityEvent.deleteMany({
        where: { userId: user.id },
      });

      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("invalidates other reset tokens after a successful password reset", async () => {
    const { user, rawToken } = await createPasswordResetFixture();

    const secondRawToken = randomUUID() + randomUUID();
    const secondTokenHash = createHash("sha256")
      .update(secondRawToken)
      .digest("hex");

    try {
      await prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: secondTokenHash,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });

      await resetPassword(rawToken, "FirstNewPassword123");

      await expect(
        resetPassword(secondRawToken, "SecondNewPassword456"),
      ).rejects.toMatchObject({
        code: "INVALID_OR_EXPIRED_TOKEN",
      });
    } finally {
      await prisma.securityEvent.deleteMany({
        where: { userId: user.id },
      });

      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("rejects an invalid reset token", async () => {
    await expect(
      resetPassword("invalid-token", "New-test-password-456"),
    ).rejects.toMatchObject({
      code: "INVALID_OR_EXPIRED_TOKEN",
    });
  });

  test("rejects an expired reset token", async () => {
    const { user, rawToken } = await createPasswordResetFixture(
      new Date(Date.now() - 1_000),
    );

    try {
      await expect(
        resetPassword(rawToken, "New-test-password-456"),
      ).rejects.toMatchObject({
        code: "INVALID_OR_EXPIRED_TOKEN",
      });
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("revokes active sessions after resetting the password", async () => {
    const { user, password, rawToken } = await createPasswordResetFixture();

    try {
      const firstLogin = await loginUser({
        email: user.email,
        password,
      });

      const secondLogin = await loginUser({
        email: user.email,
        password,
      });

      await resetPassword(rawToken, "New-test-password-456");

      await expect(
        validateSession(firstLogin.session.token),
      ).resolves.toBeNull();

      await expect(
        validateSession(secondLogin.session.token),
      ).resolves.toBeNull();
    } finally {
      await prisma.securityEvent.deleteMany({
        where: { userId: user.id },
      });

      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("allows the new password and rejects the old password", async () => {
    const { user, password, rawToken } = await createPasswordResetFixture();

    const newPassword = "New-test-password-456";

    try {
      await resetPassword(rawToken, newPassword);

      await expect(
        loginUser({ email: user.email, password }),
      ).rejects.toMatchObject({
        code: "INVALID_CREDENTIALS",
      });

      const login = await loginUser({
        email: user.email,
        password: newPassword,
      });

      expect(login.user.id).toBe(user.id);

      await logoutUser(login.session.token);
    } finally {
      await prisma.securityEvent.deleteMany({
        where: { userId: user.id },
      });

      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("rejects a password shorter than 8 characters", async () => {
    await expect(resetPassword("some-token", "Short1")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  test("rejects a password longer than 128 characters", async () => {
    await expect(
      resetPassword("some-token", "a".repeat(129)),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  test("removes the reset token when email delivery fails", async () => {
    const { user } = await createLoginFixture();

    mockSendEmail.mockRejectedValueOnce(new Error("Email delivery failed"));

    try {
      await expect(requestPasswordReset(user.email)).rejects.toThrow(
        "Email delivery failed",
      );

      const email = mockSendEmail.mock.calls[0][0];
      const match = email.html.match(/[?&]token=([a-f0-9]{64})/);

      expect(match).not.toBeNull();

      const tokenHash = createHash("sha256").update(match![1]).digest("hex");

      await expect(
        prisma.passwordResetToken.findUnique({
          where: { tokenHash },
        }),
      ).resolves.toBeNull();
    } finally {
      await prisma.user.delete({
        where: { id: user.id },
      });
    }
  });

  test("does not allow concurrent reuse of a reset token", async () => {
    const { user, rawToken } = await createPasswordResetFixture();

    try {
      const results = await Promise.allSettled([
        resetPassword(rawToken, "FirstNewPassword123"),
        resetPassword(rawToken, "SecondNewPassword456"),
      ]);

      const successfulResets = results.filter(
        (result) => result.status === "fulfilled",
      );

      const failedResets = results.filter(
        (result) => result.status === "rejected",
      );

      expect(successfulResets).toHaveLength(1);
      expect(failedResets).toHaveLength(1);

      const storedToken = await prisma.passwordResetToken.findFirst({
        where: { userId: user.id },
      });

      expect(storedToken?.usedAt).not.toBeNull();
    } finally {
      await prisma.securityEvent.deleteMany({
        where: { userId: user.id },
      });

      await prisma.user.delete({ where: { id: user.id } });
    }
  });
});

describe("Auth service — session management", () => {
  test("lists session metadata without exposing token hashes", async () => {
    const { user, password } = await createLoginFixture();
    const login = await loginUser({ email: user.email, password });

    try {
      const sessions = await listUserSessions(user.id);

      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        id: login.session.id,
        expiresAt: expect.any(Date),
        createdAt: expect.any(Date),
      });
      expect(sessions[0]).not.toHaveProperty("tokenHash");
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("revokes a session belonging to the specified user", async () => {
    const { user, password } = await createLoginFixture();
    const login = await loginUser({ email: user.email, password });

    try {
      await expect(
        revokeUserSession(user.id, login.session.id),
      ).resolves.toEqual({ revoked: true });

      await expect(validateSession(login.session.token)).resolves.toBeNull();
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("does not revoke another user's session", async () => {
    const first = await createLoginFixture();
    const second = await createLoginFixture();
    const login = await loginUser({
      email: first.user.email,
      password: first.password,
    });

    try {
      await expect(
        revokeUserSession(second.user.id, login.session.id),
      ).resolves.toEqual({ revoked: false });

      await expect(validateSession(login.session.token)).resolves.toMatchObject(
        {
          user: { id: first.user.id },
        },
      );
    } finally {
      await prisma.user.deleteMany({
        where: { id: { in: [first.user.id, second.user.id] } },
      });
    }
  });

  test("revokes all sessions belonging to a user", async () => {
    const { user, password } = await createLoginFixture();
    const first = await loginUser({ email: user.email, password });
    const second = await loginUser({ email: user.email, password });

    try {
      const result = await revokeAllUserSessions(user.id);

      expect(result.revokedCount).toBe(2);
      await expect(validateSession(first.session.token)).resolves.toBeNull();
      await expect(validateSession(second.session.token)).resolves.toBeNull();
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("returns false when revoking a nonexistent session", async () => {
    const { user } = await createLoginFixture();

    try {
      await expect(revokeUserSession(user.id, randomUUID())).resolves.toEqual({
        revoked: false,
      });
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });
});
