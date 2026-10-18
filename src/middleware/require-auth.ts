import type { Request, Response, NextFunction } from "express";
import { validateSession } from "../modules/auth/auth.service.js";

export type AuthenticatedUser = {
  id: string;
  email: string;
  emailVerifiedAt: Date | null;
};

declare global {
  namespace Express {
    interface Request {
      auth?: {
        user: AuthenticatedUser;
        session: {
          id: string;
          expiresAt: Date;
        };
      };
    }
  }
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const authorization = req.get("authorization");
    const match = authorization?.match(/^Bearer\s+(\S+)$/i);

    if (!match) {
      res.status(401).json({
        error: {
          code: "UNAUTHENTICATED",
          message: "Authentication is required",
        },
      });
      return;
    }

    const token = match[1];

    if (!token) {
      res.status(401).json({
        error: {
          code: "UNAUTHENTICATED",
          message: "Authentication is required",
        },
      });
      return;
    }

    const session = await validateSession(token);

    if (!session) {
      res.status(401).json({
        error: {
          code: "UNAUTHENTICATED",
          message: "Invalid or expired session",
        },
      });
      return;
    }

    req.auth = session;
    next();
  } catch (error) {
    next(error);
  }
}
