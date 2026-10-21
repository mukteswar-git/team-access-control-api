import type { Request, Response, NextFunction } from "express";
import {
  registerUser,
  loginUser,
  verifyEmail as verifyEmailService,
  requestPasswordReset,
  resetPassword,
  logoutSession,
  listUserSessions,
  revokeUserSession,
  revokeAllUserSessions,
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
    const auth = req.auth;

    if (!auth) {
      res.status(401).json({
        error: {
          code: "UNAUTHENTICATED",
          message: "Authentication is required",
        },
      });
      return;
    }

    await logoutSession(auth.user.id, auth.session.id);

    res.status(200).json({
      message: "Logout successful",
    });
  } catch (error) {
    next(error);
  }
}

export async function listSessions(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const auth = req.auth;

    if (!auth) {
      res.status(401).json({
        error: {
          code: "UNAUTHENTICATED",
          message: "Authentication is required",
        },
      });
      return;
    }

    const sessions = await listUserSessions(auth.user.id);

    res.status(200).json({ sessions });
  } catch (error) {
    next(error);
  }
}

export async function revokeSession(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const auth = req.auth;

    if (!auth) {
      res.status(401).json({
        error: {
          code: "UNAUTHENTICATED",
          message: "Authentication is required",
        },
      });
      return;
    }

    const result = await revokeUserSession(
      auth.user.id,
      req.params.sessionId as string,
    );

    if (!result.revoked) {
      res.status(404).json({
        error: {
          code: "SESSION_NOT_FOUND",
          message: "Session not found or already revoked",
        },
      });
      return;
    }

    res.status(200).json({ message: "Session revoked successfully" });
  } catch (error) {
    next(error);
  }
}

export async function revokeAllSessions(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const auth = req.auth;

    if (!auth) {
      res.status(401).json({
        error: {
          code: "UNAUTHENTICATED",
          message: "Authentication is required",
        },
      });
      return;
    }

    const result = await revokeAllUserSessions(auth.user.id);

    res.status(200).json({
      message: "All sessions revoked successfully",
      revokedCount: result.revokedCount,
    });
  } catch (error) {
    next(error);
  }
}
