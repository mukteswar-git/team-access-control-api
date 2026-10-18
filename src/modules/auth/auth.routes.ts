import { Router } from "express";
import validate from "../../middleware/validate.js";
import {
  loginRateLimiter,
  passwordResetRequestRateLimiter,
  resetPasswordRateLimiter,
} from "../../middleware/rate-limit.js";
import {
  registerSchema,
  loginSchema,
  verifyEmailSchema,
  requestPasswordResetSchema,
  resetPasswordSchema,
} from "./auth.schema.js";
import {
  register,
  login,
  verifyEmail,
  requestPasswordResetController,
  resetPasswordController,
  logout,
} from "./auth.controller.js";
import { requireAuth } from "../../middleware/require-auth.js";

const router = Router();

router.post("/register", validate(registerSchema), register);
router.post("/login", loginRateLimiter, validate(loginSchema), login);
router.post("/verify-email", validate(verifyEmailSchema), verifyEmail);

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

export default router;
