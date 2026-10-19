import type { Request, Response, NextFunction } from "express";
import { hasOrganizationMembership } from "../services/authorization.service.js";

export async function requireOrganizationMembership(
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

  try {
    const hasMembership = await hasOrganizationMembership(
      req.auth.user.id,
      organizationId,
    );

    if (!hasMembership) {
      res.status(403).json({
        error: {
          code: "FORBIDDEN",
          message: "You do not have access to this organization",
        },
      });
      return;
    }

    next();
  } catch (error) {
    next(error);
  }
}
