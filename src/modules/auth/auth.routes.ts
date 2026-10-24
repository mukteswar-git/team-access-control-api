import { Router } from "express";
import validate from "../../middleware/validate.js";
import {
  loginRateLimiter,
  passwordResetRequestRateLimiter,
  registerRateLimiter,
  resendVerificationRateLimiter,
  resetPasswordRateLimiter,
} from "../../middleware/rate-limit.js";
import {
  registerSchema,
  loginSchema,
  verifyEmailSchema,
  requestPasswordResetSchema,
  resetPasswordSchema,
  sessionIdParamsSchema,
  resendVerificationSchema,
} from "./auth.schema.js";
import {
  register,
  login,
  getCurrentUser,
  verifyEmail,
  requestPasswordResetController,
  resetPasswordController,
  logout,
  listSessions,
  revokeSession,
  revokeAllSessions,
  resendVerification,
} from "./auth.controller.js";
import { requireAuth } from "../../middleware/require-auth.js";
import validateParams from "../../middleware/validate-params.js";

const router = Router();

router.post(
  "/register",
  registerRateLimiter,
  validate(registerSchema),
  register,
);
router.post("/login", loginRateLimiter, validate(loginSchema), login);
router.get("/me", requireAuth, getCurrentUser);
router.post("/verify-email", validate(verifyEmailSchema), verifyEmail);

router.post(
  "/resend-verification",
  validate(resendVerificationSchema),
  resendVerificationRateLimiter,
  resendVerification,
);

router.post(
  "/request-password-reset",
  passwordResetRequestRateLimiter,
  validate(requestPasswordResetSchema),
  requestPasswordResetController,
);

router.post(
  "/reset-password",
  resetPasswordRateLimiter,
  validate(resetPasswordSchema),
  resetPasswordController,
);

router.post("/logout", requireAuth, logout);
router.get("/sessions", requireAuth, listSessions);
router.delete("/sessions", requireAuth, revokeAllSessions);
router.delete(
  "/sessions/:sessionId",
  requireAuth,
  validateParams(sessionIdParamsSchema),
  revokeSession,
);

export default router;
