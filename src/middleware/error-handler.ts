import type { ErrorRequestHandler } from "express";
import { AuthError } from "../modules/auth/auth.errors.js";
import { OrganizationError } from "../services/organization.errors.js";
import { MembershipError } from "../services/membership.errors.js";
import { InvitationError } from "../services/invitation.errors.js";

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof OrganizationError) {
    const statusCodes: Record<OrganizationError["code"], number> = {
      INVALID_INPUT: 400,
      EMAIL_NOT_VERIFIED: 403,
      FORBIDDEN: 403,
      ORGANIZATION_NOT_FOUND: 404,
      SUPER_USER_ROLE_NOT_CONFIGURED: 500,
      OWNERSHIP_TRANSFER_TARGET_INVALID: 400,
    };

    res.status(statusCodes[err.code]).json({
      error: {
        code: err.code,
        message: err.message,
      },
    });

    return;
  }

  if (err instanceof AuthError) {
    const statusCodes: Record<AuthError["code"], number> = {
      EMAIL_ALREADY_EXISTS: 409,
      INVALID_CREDENTIALS: 401,
      EMAIL_NOT_VERIFIED: 403,
      INVALID_OR_EXPIRED_TOKEN: 400,
      INVALID_INPUT: 400,
    };

    res.status(statusCodes[err.code]).json({
      error: {
        code: err.code,
        message: err.message,
      },
    });

    return;
  }

  if (err instanceof MembershipError) {
    const statusCodes: Record<MembershipError["code"], number> = {
      INVALID_INPUT: 400,
      FORBIDDEN: 403,
      MEMBERSHIP_NOT_FOUND: 404,
    };

    res.status(statusCodes[err.code]).json({
      error: {
        code: err.code,
        message: err.message,
      },
    });

    return;
  }

  if (err instanceof InvitationError) {
    const statusCodes: Record<InvitationError["code"], number> = {
      INVALID_INPUT: 400,
      FORBIDDEN: 403,
      ORGANIZATION_NOT_FOUND: 404,
      INVITATION_NOT_FOUND: 404,
      INVALID_INVITATION_STATE: 409,
      ROLE_NOT_FOUND: 404,
      INVALID_ASSIGNMENT: 400,
      PENDING_INVITATION_EXISTS: 409,
      EMAIL_NOT_VERIFIED: 403,
      EMAIL_MISMATCH: 403,
      ALREADY_MEMBER: 409,
      EMAIL_DELIVERY_FAILED: 502,
    };

    res.status(statusCodes[err.code]).json({
      error: {
        code: err.code,
        message: err.message,
      },
    });

    return;
  }

  console.error(err);

  res.status(500).json({
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "An unexpected error occurred",
    },
  });
};

export default errorHandler;
