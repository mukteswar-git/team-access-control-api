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
