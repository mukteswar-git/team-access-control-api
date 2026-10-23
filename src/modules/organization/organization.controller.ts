import type { Request, Response, NextFunction } from "express";
import {
  createOrganizationForUser,
  getOrganizationForUser,
  transferOrganizationOwnership,
} from "../../services/organization.service.js";
import {
  changeMembershipRole,
  getMembershipDetails,
  getOrganizationStructure,
  listOrganizationMemberships,
  removeMembership,
  updateMembershipReportingAssignment,
} from "../../services/membership.service.js";
import { revokeAllUserSessions } from "../auth/auth.service.js";
import { findMembershipByUserAndOrganization } from "../../repositories/membership.repository.js";
import { canPerformMembershipAction } from "../../services/authorization.service.js";
import { getOrganizationAuditLogs } from "../../services/audit-log.service.js";
import { organizationAuditLogQuerySchema } from "./organization.schema.js";
import { z } from "zod";

function getParam(value: string | string[] | undefined): string {
  if (typeof value !== "string") {
    throw new Error("Expected a single string route parameter");
  }

  return value;
}

export async function createOrganization(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    if (!req.auth) {
      res.status(401).json({
        error: {
          code: "UNAUTHENTICATED",
          message: "Authentication is required",
        },
      });
      return;
    }

    const organization = await createOrganizationForUser(
      req.auth.user.id,
      req.body,
    );

    res.status(201).json({ organization });
  } catch (error) {
    next(error);
  }
}

export async function getOrganization(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    if (!req.auth) {
      res.status(401).json({
        error: {
          code: "UNAUTHENTICATED",
          message: "Authentication is required",
        },
      });
      return;
    }

    const organization = await getOrganizationForUser(
      req.auth.user.id,
      getParam(req.params.organizationId),
    );

    res.status(200).json({ organization });
  } catch (error) {
    next(error);
  }
}

export async function transferOwnership(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    if (!req.auth) {
      res.status(401).json({
        error: {
          code: "UNAUTHENTICATED",
          message: "Authentication is required",
        },
      });
      return;
    }

    const result = await transferOrganizationOwnership(
      req.auth.user.id,
      getParam(req.params.organizationId),
      req.body.targetMembershipId,
    );

    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

export async function listMemberships(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    if (!req.auth) {
      res.status(401).json({
        error: {
          code: "UNAUTHENTICATED",
          message: "Authentication is required",
        },
      });
      return;
    }

    const memberships = await listOrganizationMemberships(
      req.auth.user.id,
      getParam(req.params.organizationId),
    );

    res.status(200).json({ memberships });
  } catch (error) {
    next(error);
  }
}

export async function getMembership(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    if (!req.auth) {
      res.status(401).json({
        error: {
          code: "UNAUTHENTICATED",
          message: "Authentication is required",
        },
      });
      return;
    }

    const membership = await getMembershipDetails(
      req.auth.user.id,
      getParam(req.params.organizationId),
      getParam(req.params.membershipId),
    );

    res.status(200).json({ membership });
  } catch (error) {
    next(error);
  }
}

export async function getOrganizationStructureController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    if (!req.auth) {
      res.status(401).json({
        error: {
          code: "UNAUTHENTICATED",
          message: "Authentication is required",
        },
      });
      return;
    }

    const structure = await getOrganizationStructure(
      req.auth.user.id,
      getParam(req.params.organizationId),
    );

    res.status(200).json({ structure });
  } catch (error) {
    next(error);
  }
}

export async function changeRole(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    if (!req.auth) {
      res.status(401).json({
        error: {
          code: "UNAUTHENTICATED",
          message: "Authentication is required",
        },
      });
      return;
    }

    const result = await changeMembershipRole(
      req.auth.user.id,
      getParam(req.params.organizationId),
      getParam(req.params.membershipId),
      req.body.roleCode,
    );

    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

export async function updateReportingAssignment(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    if (!req.auth) {
      res.status(401).json({
        error: {
          code: "UNAUTHENTICATED",
          message: "Authentication is required",
        },
      });
      return;
    }

    const result = await updateMembershipReportingAssignment(
      req.auth.user.id,
      getParam(req.params.organizationId),
      getParam(req.params.membershipId),
      req.body,
    );

    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

export async function removeMembershipController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    if (!req.auth) {
      res.status(401).json({
        error: {
          code: "UNAUTHENTICATED",
          message: "Authentication is required",
        },
      });
      return;
    }

    const result = await removeMembership(
      req.auth.user.id,
      getParam(req.params.organizationId),
      getParam(req.params.membershipId),
    );

    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

export async function revokeUserSessionsController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    if (!req.auth) {
      res.status(401).json({
        error: {
          code: "UNAUTHENTICATED",
          message: "Authentication is required",
        },
      });
      return;
    }

    const organizationId = getParam(req.params.organizationId);
    const userId = getParam(req.params.userId);

    const targetMembership = await findMembershipByUserAndOrganization(
      userId,
      organizationId,
    );

    if (!targetMembership) {
      res.status(404).json({
        error: {
          code: "MEMBERSHIP_NOT_FOUND",
          message: "The target user is not a member of this organization",
        },
      });
      return;
    }

    const permitted = await canPerformMembershipAction(
      req.auth.user.id,
      organizationId,
      targetMembership.id,
      "session.manage_any",
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

    const result = await revokeAllUserSessions(userId);

    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

export async function getOrganizationAuditLogsController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    if (!req.auth) {
      res.status(401).json({
        error: {
          code: "UNAUTHENTICATED",
          message: "Authentication is required",
        },
      });
      return;
    }

    const query = res.locals.validatedQuery as z.infer<
      typeof organizationAuditLogQuerySchema
    >;

    const result = await getOrganizationAuditLogs(
      req.auth.user.id,
      getParam(req.params.organizationId),
      query,
    );

    res.status(200).json({
      auditLogs: result.items.map((item) => ({
        id: item.id,
        organizationId: item.organizationId,
        actorUserId: item.actorUserId,
        actorMembershipId: item.actorMembershipId,
        action: item.action,
        result: item.result,
        targetType: item.targetType,
        targetId: item.targetId,
        createdAt: item.createdAt,
      })),
      pagination: {
        page: result.page,
        pageSize: result.pageSize,
        total: result.total,
        totalPages: result.totalPages,
      },
    });
  } catch (error) {
    next(error);
  }
}
