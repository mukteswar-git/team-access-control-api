import type { Request, Response, NextFunction } from "express";
import {
  registerUser,
  loginUser,
  verifyEmail as verifyEmailService,
  requestPasswordReset,
  resetPassword,
  logoutSession,
} from "./auth.service.js";

export async function register(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const result = await registerUser(req.body);

    res.status(201).json({
      user: result.user,
    });
  } catch (error) {
    next(error);
  }
}

export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await loginUser(req.body);

    res.status(200).json({
      user: result.user,
      session: {
        expiresAt: result.session.expiresAt,
      },
      sessionToken: result.session.token,
    });
  } catch (error) {
    next(error);
  }
}

export async function verifyEmail(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const user = await verifyEmailService(req.body.token);
    res.status(200).json({ user });
  } catch (error) {
    next(error);
  }
}

export async function requestPasswordResetController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    await requestPasswordReset(req.body.email);

    res.status(200).json({
      message:
        "If an account exists for that email, password reset instructions will be sent.",
    });
  } catch (error) {
    next(error);
  }
}

export async function resetPasswordController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    await resetPassword(req.body.token, req.body.newPassword);

    res.status(200).json({
      message: "Password reset successful",
    });
  } catch (error) {
    next(error);
  }
}

export async function logout(req: Request, res: Response, next: NextFunction) {
  try {
    const session = req.auth?.session;

    if (!session) {
      res.status(401).json({
        error: {
          code: "UNAUTHENTICATED",
          message: "Authentication is required",
        },
      });
      return;
    }

    await logoutSession(session.id);

    res.status(200).json({
      message: "Logout successful",
    });
  } catch (error) {
    next(error);
  }
}
