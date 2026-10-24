import { z } from "zod";

export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters long")
  .max(128, "Password must not exceed 128 characters");

export const registerSchema = z.object({
  email: z.string().trim().pipe(z.email()),
  password: passwordSchema,
});

export const loginSchema = z.object({
  email: z.string().trim().pipe(z.email()),
  password: z.string().min(1),
});

export const verifyEmailSchema = z.object({
  token: z.string().min(1),
});

export const resendVerificationSchema = z.object({
  email: z.string().trim().pipe(z.email()),
});

export const requestPasswordResetSchema = z.object({
  email: z.string().trim().pipe(z.email()),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1),
  newPassword: passwordSchema,
});

export const sessionIdParamsSchema = z.object({
  sessionId: z.string().uuid(),
});
