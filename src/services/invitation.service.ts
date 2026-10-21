import { z } from "zod";
import { InvitationError } from "./invitation.errors.js";
import { normalizeEmail } from "../utils/normalize-email.js";
import { canRevokeInvitation, hasPermission } from "./authorization.service.js";
import { findMembershipByUserAndOrganization } from "../repositories/membership.repository.js";
import { prisma, type DatabaseClient } from "../lib/prisma.js";
import { createHash, randomBytes } from "node:crypto";
import { INVITATION_TOKEN_TTL_MS } from "../constants/auth.js";
import {
  findInvitationById,
  findInvitationByTokenHash,
  findPendingInvitation,
} from "../repositories/invitation.repository.js";
import { createAuditLog } from "./audit-log.service.js";

export type InvitationStatus = "pending" | "expired" | "revoked" | "accepted";

export function getInvitationStatus(
  invitation: {
    expiresAt: Date;
    acceptedAt: Date | null;
    revokedAt: Date | null;
  },
  now: Date = new Date(),
): InvitationStatus {
  if (invitation.acceptedAt !== null) {
    return "accepted";
  }

  if (invitation.revokedAt !== null) {
    return "revoked";
  }

  if (invitation.expiresAt <= now) {
    return "expired";
  }

  return "pending";
}

const createInvitationSchema = z.object({
  email: z.string().trim().email(),
  roleCode: z.enum(["admin", "manager", "member"]),
  adminMembershipId: z.string().uuid().nullable().optional(),
  managerMembershipId: z.string().uuid().nullable().optional(),
});

export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;

function validateInvitationInput(data: CreateInvitationInput) {
  const parsed = createInvitationSchema.safeParse(data);

  if (!parsed.success) {
    throw new InvitationError("INVALID_INPUT", "Invalid invitation input.");
  }

  return {
    ...parsed.data,
    email: normalizeEmail(parsed.data.email),
  };
}

const INVITABLE_ROLES_BY_CREATOR: Record<string, string[]> = {
  super_user: ["admin", "manager", "member"],
  admin: ["manager", "member"],
  manager: ["member"],
  member: [],
};

export async function assertCanCreateInvitation(
  actorUserId: string,
  organizationId: string,
  roleCode: string,
  db: DatabaseClient = prisma,
): Promise<void> {
  if (!actorUserId.trim() || !organizationId.trim()) {
    throw new InvitationError(
      "INVALID_INPUT",
      "User ID and organization ID are required.",
    );
  }

  const actor = await findMembershipByUserAndOrganization(
    actorUserId,
    organizationId,
    db,
  );

  if (!actor) {
    throw new InvitationError(
      "FORBIDDEN",
      "You do not have access to this organization.",
    );
  }

  const allowedByPermission = await hasPermission(
    actorUserId,
    organizationId,
    "invitation.create",
    db,
  );

  if (!allowedByPermission) {
    throw new InvitationError(
      "FORBIDDEN",
      "You do not have permission to create invitations.",
    );
  }

  const allowedRoles = INVITABLE_ROLES_BY_CREATOR[actor.role.code] ?? [];

  if (!allowedRoles.includes(roleCode)) {
    throw new InvitationError(
      "FORBIDDEN",
      "Your role cannot invite a user with this role.",
    );
  }
}

async function validateInvitationAssignment(
  actorUserId: string,
  organizationId: string,
  roleCode: "admin" | "manager" | "member",
  adminMembershipId: string | null | undefined,
  managerMembershipId: string | null | undefined,
  db: DatabaseClient,
): Promise<void> {
  const actor = await findMembershipByUserAndOrganization(
    actorUserId,
    organizationId,
    db,
  );

  if (!actor) {
    throw new InvitationError(
      "FORBIDDEN",
      "You do not have access to this organization.",
    );
  }

  // Admin invitations cannot have reporting assignments.
  if (roleCode === "admin") {
    if (adminMembershipId != null || managerMembershipId != null) {
      throw new InvitationError(
        "INVALID_ASSIGNMENT",
        "Admin invitations cannot have reporting assignments.",
      );
    }

    return;
  }

  // Manager invitations may be assigned to an Admin.
  if (roleCode === "manager") {
    if (managerMembershipId !== null && managerMembershipId !== undefined) {
      throw new InvitationError(
        "INVALID_ASSIGNMENT",
        "A Manager invitation cannot have a Manager assignment.",
      );
    }

    if (actor.role.code === "admin" && adminMembershipId !== actor.id) {
      throw new InvitationError(
        "INVALID_ASSIGNMENT",
        "An Admin must assign an invited Manager to themselves.",
      );
    }

    if (adminMembershipId == null) {
      return;
    }

    const admin = await db.membership.findFirst({
      where: {
        id: adminMembershipId,
        organizationId,
        role: { code: "admin" },
      },
      select: { id: true },
    });

    if (!admin) {
      throw new InvitationError(
        "INVALID_ASSIGNMENT",
        "The assigned Admin must belong to the same organization.",
      );
    }

    if (actor.role.code === "admin" && admin.id !== actor.id) {
      throw new InvitationError(
        "INVALID_ASSIGNMENT",
        "Admins may assign Managers only to themselves.",
      );
    }

    return;
  }

  // Member invitations use a Manager assignment, not an Admin assignment.
  if (adminMembershipId != null) {
    throw new InvitationError(
      "INVALID_ASSIGNMENT",
      "Member invitations must use a Manager assignment.",
    );
  }

  // Managers must assign invited Members to themselves.
  if (actor.role.code === "manager" && managerMembershipId !== actor.id) {
    throw new InvitationError(
      "INVALID_ASSIGNMENT",
      "Managers must assign invited Members to themselves.",
    );
  }

  if (managerMembershipId == null) {
    return;
  }

  const manager = await db.membership.findFirst({
    where: {
      id: managerMembershipId,
      organizationId,
      role: { code: "manager" },
    },
    select: {
      id: true,
      adminMembershipId: true,
    },
  });

  if (!manager) {
    throw new InvitationError(
      "INVALID_ASSIGNMENT",
      "The assigned Manager must belong to the same organization.",
    );
  }

  if (actor.role.code === "manager" && manager.id !== actor.id) {
    throw new InvitationError(
      "INVALID_ASSIGNMENT",
      "Managers may assign Members only to themselves.",
    );
  }

  if (actor.role.code === "admin" && manager.adminMembershipId !== actor.id) {
    throw new InvitationError(
      "INVALID_ASSIGNMENT",
      "Admins may assign Members only to Managers within their scope.",
    );
  }
}

export async function createInvitation(
  actorUserId: string,
  organizationId: string,
  data: CreateInvitationInput,
  db: typeof prisma = prisma,
) {
  if (!z.string().uuid().safeParse(organizationId).success) {
    throw new InvitationError("INVALID_INPUT", "Invalid organization ID.");
  }

  // Validate the actor user ID.
  if (!z.string().uuid().safeParse(actorUserId).success) {
    throw new InvitationError("INVALID_INPUT", "Invalid actor user ID.");
  }

  const input = validateInvitationInput(data);

  return db.$transaction(async (tx) => {
    const organizations = await tx.$queryRaw<{ id: string }[]>`
      SELECT id
      FROM organizations
      WHERE id = ${organizationId}::uuid
      FOR UPDATE
    `;

    if (organizations.length === 0) {
      throw new InvitationError(
        "ORGANIZATION_NOT_FOUND",
        "Organization not found.",
      );
    }

    // Check permission and role hierarchy.
    await assertCanCreateInvitation(
      actorUserId,
      organizationId,
      input.roleCode,
      tx,
    );

    // Validate reporting assignments.
    await validateInvitationAssignment(
      actorUserId,
      organizationId,
      input.roleCode,
      input.adminMembershipId,
      input.managerMembershipId,
      tx,
    );

    // Resolve the invited role.
    const role = await tx.role.findUnique({
      where: { code: input.roleCode },
      select: { id: true },
    });

    if (!role) {
      throw new InvitationError(
        "ROLE_NOT_FOUND",
        "The requested role does not exist.",
      );
    }

    // Reject an existing, active, unexpired invitation for this email.
    const existingInvitation = await findPendingInvitation(
      organizationId,
      input.email,
      tx,
    );

    if (existingInvitation) {
      throw new InvitationError(
        "PENDING_INVITATION_EXISTS",
        "A pending invitation already exists for this email.",
      );
    }

    // Generate an opaque token; persist only its hash.
    const token = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(token).digest("hex");

    const expiresAt = new Date(Date.now() + INVITATION_TOKEN_TTL_MS);

    const actor = await findMembershipByUserAndOrganization(
      actorUserId,
      organizationId,
      tx,
    );

    if (!actor) {
      throw new InvitationError(
        "FORBIDDEN",
        "You do not have access to this organization.",
      );
    }

    const invitation = await tx.invitation.create({
      data: {
        organizationId,
        invitedEmail: input.email,
        roleId: role.id,
        adminMembershipId: input.adminMembershipId ?? null,
        managerMembershipId: input.managerMembershipId ?? null,
        tokenHash,
        expiresAt,
        createdByMembershipId: actor.id,
      },
    });

    // The audit event is part of the same transaction.
    await createAuditLog(tx, {
      organizationId,
      actorUserId,
      actorMembershipId: actor.id,
      action: "invitation.created",
      result: "success",
      targetType: "invitation",
      targetId: invitation.id,
      metadata: {
        email: input.email,
        roleCode: input.roleCode,
        expiresAt: expiresAt.toISOString(),
      },
    });

    // Return the raw token once; never persist or log it.
    const { tokenHash: _tokenHash, ...safeInvitation } = invitation;

    return {
      invitation: safeInvitation,
      token,
    };
  });
}

export async function revokeInvitation(
  actorUserId: string,
  organizationId: string,
  invitationId: string,
  db: DatabaseClient = prisma,
) {
  if (!actorUserId.trim() || !organizationId.trim() || !invitationId.trim()) {
    throw new InvitationError(
      "INVALID_INPUT",
      "User ID, organization ID, and invitation ID are required.",
    );
  }

  return db.$transaction(async (tx) => {
    const invitation = await findInvitationById(
      invitationId,
      organizationId,
      tx,
    );

    if (!invitation) {
      throw new InvitationError(
        "INVITATION_NOT_FOUND",
        "Invitation not found.",
      );
    }

    const allowed = await hasPermission(
      actorUserId,
      organizationId,
      "invitation.revoke",
      tx,
    );

    if (!allowed) {
      throw new InvitationError(
        "FORBIDDEN",
        "You are not authorized to revoke invitations in this organization.",
      );
    }

    const canRevoke = await canRevokeInvitation(
      actorUserId,
      organizationId,
      invitation,
      tx,
    );

    if (!canRevoke) {
      throw new InvitationError(
        "FORBIDDEN",
        "You are not authorized to revoke this invitation.",
      );
    }

    const status = getInvitationStatus(invitation);

    if (status !== "pending") {
      throw new InvitationError(
        "INVALID_INVITATION_STATE",
        `Cannot revoke an invitation with status "${status}".`,
      );
    }

    const actor = await findMembershipByUserAndOrganization(
      actorUserId,
      organizationId,
      tx,
    );

    if (!actor) {
      throw new InvitationError(
        "FORBIDDEN",
        "You do not have access to this organization.",
      );
    }

    const now = new Date();

    const result = await tx.invitation.updateMany({
      where: {
        id: invitation.id,
        organizationId,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: {
        revokedAt: now,
      },
    });

    if (result.count !== 1) {
      throw new InvitationError(
        "INVALID_INVITATION_STATE",
        "Invitation is no longer pending.",
      );
    }

    await createAuditLog(tx, {
      organizationId,
      actorUserId,
      actorMembershipId: actor.id,
      action: "invitation.revoked",
      result: "success",
      targetType: "invitation",
      targetId: invitation.id,
      metadata: {
        invitedEmail: invitation.invitedEmail,
      },
    });

    return {
      invitationId: invitation.id,
      status: "revoked" as const,
      revokedAt: now,
    };
  });
}

export async function acceptInvitation(
  userId: string,
  token: string,
  db: DatabaseClient = prisma,
) {
  if (!z.string().uuid().safeParse(userId).success || !token.trim()) {
    throw new InvitationError("INVALID_INPUT", "Invalid acceptance input.");
  }

  const tokenHash = createHash("sha256").update(token).digest("hex");

  const result = await db.$transaction(async (tx) => {
    const invitation = await findInvitationByTokenHash(tokenHash, tx);

    if (!invitation) {
      throw new InvitationError(
        "INVITATION_NOT_FOUND",
        "Invitation not found.",
      );
    }

    const now = new Date();
    const status = getInvitationStatus(invitation, now);

    if (status !== "pending") {
      throw new InvitationError(
        "INVALID_INVITATION_STATE",
        `Cannot accept an invitation with status "${status}".`,
      );
    }

    const user = await tx.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        emailVerifiedAt: true,
      },
    });

    if (!user || !user.emailVerifiedAt) {
      throw new InvitationError(
        "EMAIL_NOT_VERIFIED",
        "A verified account is required to accept an invitation.",
      );
    }

    if (
      normalizeEmail(user.email) !== normalizeEmail(invitation.invitedEmail)
    ) {
      throw new InvitationError(
        "EMAIL_MISMATCH",
        "Your verified email does not match the invited email.",
      );
    }

    const existingMembership = await findMembershipByUserAndOrganization(
      user.id,
      invitation.organizationId,
      tx,
    );

    if (existingMembership) {
      const result = await tx.invitation.updateMany({
        where: {
          id: invitation.id,
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        data: { revokedAt: now },
      });

      if (result.count !== 1) {
        throw new InvitationError(
          "INVALID_INVITATION_STATE",
          "Invitation is no longer pending.",
        );
      }

      await createAuditLog(tx, {
        organizationId: invitation.organizationId,
        actorUserId: user.id,
        actorMembershipId: existingMembership.id,
        action: "invitation.closed",
        result: "success",
        targetType: "invitation",
        targetId: invitation.id,
        metadata: { reason: "already_member" },
      });

      return null;
    }

    const role = await tx.role.findUnique({
      where: { id: invitation.roleId },
      select: { id: true, code: true },
    });

    if (!role || !["admin", "manager", "member"].includes(role.code)) {
      throw new InvitationError(
        "ROLE_NOT_FOUND",
        "The invitation role is no longer valid.",
      );
    }

    let adminMembershipId: string | null = null;
    let managerMembershipId: string | null = null;

    if (role.code === "admin") {
      if (
        invitation.adminMembershipId !== null ||
        invitation.managerMembershipId !== null
      ) {
        throw new InvitationError(
          "INVALID_ASSIGNMENT",
          "Admin invitations cannot have reporting assignments.",
        );
      }
    } else if (role.code === "manager") {
      if (invitation.managerMembershipId !== null) {
        throw new InvitationError(
          "INVALID_ASSIGNMENT",
          "Manager invitations cannot have a manager assignment.",
        );
      }

      if (invitation.adminMembershipId !== null) {
        const admin = await tx.membership.findFirst({
          where: {
            id: invitation.adminMembershipId,
            organizationId: invitation.organizationId,
            role: { code: "admin" },
          },
          select: { id: true },
        });

        if (!admin) {
          throw new InvitationError(
            "INVALID_ASSIGNMENT",
            "The assigned Admin is no longer valid.",
          );
        }

        adminMembershipId = admin.id;
      }
    } else {
      if (invitation.adminMembershipId !== null) {
        throw new InvitationError(
          "INVALID_ASSIGNMENT",
          "Member invitations cannot have an Admin assignment.",
        );
      }

      if (invitation.managerMembershipId !== null) {
        const manager = await tx.membership.findFirst({
          where: {
            id: invitation.managerMembershipId,
            organizationId: invitation.organizationId,
            role: { code: "manager" },
          },
          select: { id: true },
        });

        if (!manager) {
          throw new InvitationError(
            "INVALID_ASSIGNMENT",
            "The assigned Manager is no longer valid.",
          );
        }

        managerMembershipId = manager.id;
      }
    }

    const result = await tx.invitation.updateMany({
      where: {
        id: invitation.id,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: { acceptedAt: now },
    });

    if (result.count !== 1) {
      throw new InvitationError(
        "INVALID_INVITATION_STATE",
        "Invitation is no longer pending.",
      );
    }

    const membership = await tx.membership.create({
      data: {
        organizationId: invitation.organizationId,
        userId: user.id,
        roleId: role.id,
        adminMembershipId,
        managerMembershipId,
      },
      select: {
        id: true,
        organizationId: true,
        userId: true,
        roleId: true,
        adminMembershipId: true,
        managerMembershipId: true,
      },
    });

    await createAuditLog(tx, {
      organizationId: invitation.organizationId,
      actorUserId: user.id,
      actorMembershipId: membership.id,
      action: "invitation.accepted",
      result: "success",
      targetType: "invitation",
      targetId: invitation.id,
      metadata: {
        roleCode: role.code,
        membershipId: membership.id,
      },
    });

    return {
      invitationId: invitation.id,
      status: "accepted" as const,
      acceptedAt: now,
      membership,
    };
  });

  if (result === null) {
    throw new InvitationError(
      "ALREADY_MEMBER",
      "You are already a member of this organization.",
    );
  }

  return result;
}
