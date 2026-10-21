import argon2 from "argon2";
import { createHash, randomBytes } from "node:crypto";
import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import { EMAIL_VERIFICATION_TOKEN_TTL_MS } from "../../constants/auth.js";
import { AuthError } from "./auth.errors.js";
import { normalizeEmail } from "../../utils/normalize-email.js";
import {
  consumeEmailVerificationToken,
  createEmailVerificationToken,
  findEmailVerificationTokenByHash,
} from "../../repositories/email-verification-token.repository.js";
import {
  createUser,
  findUserByEmail,
  updateUser,
} from "../../repositories/user.repository.js";
import { SESSION_TTL_MS } from "../../constants/auth.js";
import {
  createSession,
  findSessionByTokenHash,
  findSessionsByUserId,
  revokeSessionByTokenHash,
  revokeAllSessionsForUser,
  revokeSessionByIdForUser,
} from "../../repositories/session.repository.js";
import { PASSWORD_RESET_TOKEN_TTL_MS } from "../../constants/auth.js";
import {
  consumePasswordResetToken,
  createPasswordResetToken,
  findPasswordResetTokenByHash,
} from "../../repositories/password-reset-token.repository.js";
import { sendEmail } from "../../lib/email.js";
import { env } from "../../config/env.js";

type RegisterUserData = {
  email: string;
  password: string;
};

type LoginUserData = {
  email: string;
  password: string;
};

export async function registerUser(data: RegisterUserData) {
  const email = normalizeEmail(data.email);

  if (!email || !data.password) {
    throw new AuthError("INVALID_INPUT", "Email and password are required");
  }

  const existingUser = await findUserByEmail(email);

  if (existingUser) {
    throw new AuthError("EMAIL_ALREADY_EXISTS", "Email already exists");
  }

  const passwordHash = await argon2.hash(data.password, {
    type: argon2.argon2id,
  });

  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const now = new Date();

  try {
    const user = await prisma.$transaction(async (tx) => {
      const createdUser = await createUser({ email, passwordHash }, tx);

      await createEmailVerificationToken(
        {
          userId: createdUser.id,
          tokenHash,
          expiresAt: new Date(now.getTime() + EMAIL_VERIFICATION_TOKEN_TTL_MS),
        },
        tx,
      );

      return createdUser;
    });

    const verificationUrl = `${env.FRONTEND_URL}/verify-email?token=${rawToken}`;

    await sendEmail({
      to: user.email,
      subject: "Verify your email — Team Access Control",
      html: `
        <h1>Verify your email</h1>
        <p>Thanks for registering with Team Access Control.</p>
        <p>Click the link below to verify your email address:</p>
        <p>
          <a href="${verificationUrl}">Verify email address</a>
        </p>
        <p>This link expires in 24 hours.</p>
      `,
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        emailVerifiedAt: user.emailVerifiedAt,
      },
    };
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const target = error.meta?.target;

      if (Array.isArray(target) && target.includes("email")) {
        throw new AuthError("EMAIL_ALREADY_EXISTS", "Email already exists");
      }
    }

    throw error;
  }
}

export async function verifyEmail(token: string) {
  if (!token) {
    throw new AuthError(
      "INVALID_OR_EXPIRED_TOKEN",
      "Invalid or expired verification token",
    );
  }

  const tokenHash = createHash("sha256").update(token).digest("hex");
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const verificationToken = await findEmailVerificationTokenByHash(
      tokenHash,
      tx,
    );

    if (
      !verificationToken ||
      verificationToken.usedAt !== null ||
      verificationToken.expiresAt <= now
    ) {
      throw new AuthError(
        "INVALID_OR_EXPIRED_TOKEN",
        "Invalid or expired verification token",
      );
    }

    const consumed = await consumeEmailVerificationToken(tx, tokenHash, now);

    if (consumed.count !== 1) {
      throw new AuthError(
        "INVALID_OR_EXPIRED_TOKEN",
        "Invalid or expired verification token",
      );
    }

    const user = await updateUser(
      verificationToken.userId,
      { emailVerifiedAt: now },
      tx,
    );

    return {
      id: user.id,
      email: user.email,
      emailVerifiedAt: user.emailVerifiedAt,
    };
  });
}

export async function loginUser(data: LoginUserData) {
  const email = normalizeEmail(data.email);

  if (!email || !data.password) {
    throw new AuthError("INVALID_INPUT", "Email and password are required");
  }

  const user = await findUserByEmail(email);

  if (!user) {
    throw new AuthError("INVALID_CREDENTIALS", "Invalid email or password");
  }

  const passwordMatches = await argon2.verify(user.passwordHash, data.password);

  if (!passwordMatches) {
    throw new AuthError("INVALID_CREDENTIALS", "Invalid email or password");
  }

  if (!user.emailVerifiedAt) {
    throw new AuthError("EMAIL_NOT_VERIFIED", "Email is not verified");
  }

  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const now = new Date();

  const session = await createSession({
    userId: user.id,
    tokenHash,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
  });

  return {
    user: {
      id: user.id,
      email: user.email,
      emailVerifiedAt: user.emailVerifiedAt,
    },
    session: {
      id: session.id,
      token: rawToken,
      expiresAt: session.expiresAt,
    },
  };
}

export async function logoutUser(token: string) {
  if (!token) {
    return;
  }

  const tokenHash = createHash("sha256").update(token).digest("hex");

  await revokeSessionByTokenHash(tokenHash);
}

export async function validateSession(token: string) {
  if (!token) {
    return null;
  }

  const tokenHash = createHash("sha256").update(token).digest("hex");
  const session = await findSessionByTokenHash(tokenHash);

  if (
    !session ||
    session.revokedAt !== null ||
    session.expiresAt <= new Date()
  ) {
    return null;
  }

  return {
    user: {
      id: session.user.id,
      email: session.user.email,
      emailVerifiedAt: session.user.emailVerifiedAt,
    },
    session: {
      id: session.id,
      expiresAt: session.expiresAt,
    },
  };
}

export async function requestPasswordReset(email: string) {
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail) {
    return;
  }

  const user = await findUserByEmail(normalizedEmail);

  // Do not reveal whether an account exists.
  if (!user) {
    return;
  }

  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const now = new Date();

  await createPasswordResetToken({
    userId: user.id,
    tokenHash,
    expiresAt: new Date(now.getTime() + PASSWORD_RESET_TOKEN_TTL_MS),
  });

  const resetUrl = `${env.FRONTEND_URL}/reset-password?token=${rawToken}`;

  await sendEmail({
    to: user.email,
    subject: "Reset your password — Team Access Control",
    html: `
      <h1>Reset your password</h1>
      <p>We received a request to reset your password.</p>
      <p>
        <a href="${resetUrl}">Reset password</a>
      </p>
      <p>This link expires in 30 minutes.</p>
      <p>If you did not request this, you can ignore this email.</p>
    `,
  });
}

export async function resetPassword(token: string, newPassword: string) {
  if (!token || !newPassword) {
    throw new AuthError("INVALID_INPUT", "Token and new password are required");
  }

  const tokenHash = createHash("sha256").update(token).digest("hex");
  const now = new Date();

  // Hash the new password before entering the database transaction.
  const passwordHash = await argon2.hash(newPassword, {
    type: argon2.argon2id,
  });

  return prisma.$transaction(async (tx) => {
    const resetToken = await findPasswordResetTokenByHash(tokenHash, tx);

    if (
      !resetToken ||
      resetToken.usedAt !== null ||
      resetToken.expiresAt <= now
    ) {
      throw new AuthError(
        "INVALID_OR_EXPIRED_TOKEN",
        "Invalid or expired password reset token",
      );
    }

    const consumed = await consumePasswordResetToken(tx, tokenHash, now);

    if (consumed.count !== 1) {
      throw new AuthError(
        "INVALID_OR_EXPIRED_TOKEN",
        "Invalid or expired password reset token",
      );
    }

    await updateUser(resetToken.userId, { passwordHash }, tx);

    await revokeAllSessionsForUser(resetToken.userId, tx);

    return { success: true };
  });
}

export async function listUserSessions(userId: string) {
  if (!userId) {
    throw new AuthError("INVALID_INPUT", "User ID is required");
  }

  return findSessionsByUserId(userId);
}

export async function revokeUserSession(userId: string, sessionId: string) {
  if (!userId || !sessionId) {
    throw new AuthError("INVALID_INPUT", "User ID and session ID are required");
  }

  const result = await revokeSessionByIdForUser(sessionId, userId);

  return { revoked: result.count === 1 };
}

export async function revokeAllUserSessions(userId: string) {
  if (!userId) {
    throw new AuthError("INVALID_INPUT", "User ID is required");
  }

  const result = await revokeAllSessionsForUser(userId);

  return { revokedCount: result.count };
}

export async function logoutSession(userId: string, sessionId: string) {
  return revokeUserSession(userId, sessionId);
}
