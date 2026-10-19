import type { Request, Response, NextFunction } from "express";
import { canPerformMembershipAction } from "../services/authorization.service.js";

export function requireMembershipAction(permissionCode: string) {
  if (!permissionCode.trim()) {
    throw new Error("A permission code is required");
  }

  return async function (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (!req.auth) {
      res.status(401).json({
        error: {
          code: "UNAUTHENTICATED",
          message: "Authentication is required",
        },
      });
      return;
    }

    const { organizationId, membershipId } = req.params;

    if (
      typeof organizationId !== "string" ||
      !organizationId.trim() ||
      typeof membershipId !== "string" ||
      !membershipId.trim()
    ) {
      res.status(400).json({
        error: {
          code: "INVALID_INPUT",
          message: "Required authorization context is missing",
        },
      });
      return;
    }

    try {
      const permitted = await canPerformMembershipAction(
        req.auth.user.id,
        organizationId,
        membershipId,
        permissionCode,
      );

      if (!permitted) {
        res.status(403).json({
          error: {
            code: "FORBIDDEN",
            message: "You are not authorized to perform this action",
          },
        });
        return;
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}
