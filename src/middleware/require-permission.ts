import type { Request, Response, NextFunction } from "express";
import { hasPermission } from "../services/authorization.service.js";

export function requirePermission(permissionCode: string) {
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

    const organizationId = req.params.organizationId;

    if (typeof organizationId !== "string" || !organizationId.trim()) {
      res.status(400).json({
        error: {
          code: "INVALID_INPUT",
          message: "Organization ID is required",
        },
      });
      return;
    }

    if (!permissionCode.trim()) {
      res.status(500).json({
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Permission configuration is invalid",
        },
      });
      return;
    }

    try {
      const permitted = await hasPermission(
        req.auth.user.id,
        organizationId,
        permissionCode,
      );

      if (!permitted) {
        res.status(403).json({
          error: {
            code: "FORBIDDEN",
            message: "You do not have permission to perform this action",
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
