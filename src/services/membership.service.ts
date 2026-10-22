import {
  hasOrganizationMembership,
  hasPermission,
  canChangeMembershipRole,
  canPerformMembershipAction,
} from "./authorization.service.js";
import {
  findMembershipById,
  findMembershipsByOrganizationId,
} from "../repositories/membership.repository.js";
import { MembershipError } from "./membership.errors.js";
import { prisma, type DatabaseClient } from "../lib/prisma.js";
import { createAuditLog } from "./audit-log.service.js";

async function assertMembershipReadAccess(
  actorUserId: string,
  organizationId: string,
  db: DatabaseClient,
): Promise<void> {
  if (!actorUserId.trim() || !organizationId.trim()) {
    throw new MembershipError(
      "INVALID_INPUT",
      "User ID and organization ID are required.",
    );
  }

  const isMember = await hasOrganizationMembership(
    actorUserId,
    organizationId,
    db,
  );

  if (!isMember) {
    throw new MembershipError(
      "FORBIDDEN",
      "You do not have access to this organization.",
    );
  }

  const hasReadPermission = await hasPermission(
    actorUserId,
    organizationId,
    "membership.read",
    db,
  );

  if (!hasReadPermission) {
    throw new MembershipError(
      "FORBIDDEN",
      "You do not have permission to read memberships.",
    );
  }
}

export async function getMembershipDetails(
  actorUserId: string,
  organizationId: string,
  targetMembershipId: string,
  db: DatabaseClient = prisma,
) {
  if (!targetMembershipId.trim()) {
    throw new MembershipError("INVALID_INPUT", "Membership ID is required.");
  }

  await assertMembershipReadAccess(actorUserId, organizationId, db);

  const membership = await findMembershipById(
    targetMembershipId,
    organizationId,
    db,
  );

  if (!membership) {
    throw new MembershipError("MEMBERSHIP_NOT_FOUND", "Membership not found.");
  }

  return membership;
}

export async function listOrganizationMemberships(
  actorUserId: string,
  organizationId: string,
  db: DatabaseClient = prisma,
) {
  await assertMembershipReadAccess(actorUserId, organizationId, db);

  return findMembershipsByOrganizationId(organizationId, db);
}

export async function getOrganizationStructure(
  actorUserId: string,
  organizationId: string,
  db: DatabaseClient = prisma,
) {
  await assertMembershipReadAccess(actorUserId, organizationId, db);

  const memberships = await findMembershipsByOrganizationId(organizationId, db);

  const admins = memberships.filter(
    (membership) => membership.role.code === "admin",
  );

  const managers = memberships
    .filter((membership) => membership.role.code === "manager")
    .map((manager) => ({
      ...manager,
      memberCount: memberships.filter(
        (membership) =>
          membership.role.code === "member" &&
          membership.managerMembershipId === manager.id,
      ).length,
    }));

  const members = memberships.filter(
    (membership) => membership.role.code === "member",
  );

  const superUsers = memberships.filter(
    (membership) => membership.role.code === "super_user",
  );

  return {
    organizationId,
    counts: {
      total: memberships.length,
      superUsers: superUsers.length,
      admins: admins.length,
      managers: managers.length,
      members: members.length,
    },
    superUsers,
    admins,
    managers,
    members,
  };
}

export async function changeMembershipRole(
  actorUserId: string,
  organizationId: string,
  targetMembershipId: string,
  newRoleCode: string,
  db = prisma,
) {
  return db.$transaction(async (tx) => {
    const target = await tx.membership.findFirst({
      where: {
        id: targetMembershipId,
        organizationId,
      },
      include: {
        role: true,
      },
    });

    if (!target) {
      throw new MembershipError(
        "MEMBERSHIP_NOT_FOUND",
        "Membership not found.",
      );
    }

    const newRole = await tx.role.findUnique({
      where: {
        code: newRoleCode,
      },
    });

    if (!newRole) {
      throw new MembershipError("INVALID_INPUT", "Invalid role.");
    }

    const allowed = await canChangeMembershipRole(
      actorUserId,
      organizationId,
      targetMembershipId,
      newRoleCode,
      tx,
    );

    if (!allowed) {
      throw new MembershipError(
        "FORBIDDEN",
        "Not authorized to change this membership's role.",
      );
    }

    const previousRoleCode = target.role.code;

    // Managers assigned to a demoted Admin become unassigned. Their Members
    // remain assigned to their respective Managers.
    if (previousRoleCode === "admin" && newRoleCode !== "admin") {
      await tx.membership.updateMany({
        where: {
          organizationId,
          adminMembershipId: target.id,
        },
        data: {
          adminMembershipId: null,
        },
      });
    }

    // Members assigned to a demoted Manager become unassigned.
    if (previousRoleCode === "manager" && newRoleCode !== "manager") {
      await tx.membership.updateMany({
        where: {
          organizationId,
          managerMembershipId: target.id,
        },
        data: {
          managerMembershipId: null,
        },
      });
    }

    // Clear assignments incompatible with the new role.
    if (newRoleCode === "admin") {
      await tx.membership.update({
        where: { id: target.id },
        data: {
          adminMembershipId: null,
          managerMembershipId: null,
        },
      });
    } else if (newRoleCode === "manager") {
      await tx.membership.update({
        where: { id: target.id },
        data: {
          managerMembershipId: null,
        },
      });
    } else if (newRoleCode === "member") {
      await tx.membership.update({
        where: { id: target.id },
        data: {
          adminMembershipId: null,
        },
      });
    }

    const updatedMembership = await tx.membership.update({
      where: { id: target.id },
      data: {
        roleId: newRole.id,
      },
      include: {
        role: true,
      },
    });

    const actorMembership = await tx.membership.findUnique({
      where: {
        userId_organizationId: {
          userId: actorUserId,
          organizationId,
        },
      },
      select: { id: true },
    });

    await createAuditLog(tx, {
      organizationId,
      actorUserId,
      actorMembershipId: actorMembership?.id ?? null,
      action: "membership.role_changed",
      result: "success",
      targetType: "membership",
      targetId: target.id,
      metadata: {
        previousRole: previousRoleCode,
        newRole: updatedMembership.role.code,
      },
    });

    return {
      membershipId: updatedMembership.id,
      previousRole: previousRoleCode,
      newRole: updatedMembership.role.code,
    };
  });
}

type ReportingAssignment =
  | {
      role: "manager";
      adminMembershipId: string | null;
    }
  | {
      role: "member";
      managerMembershipId: string | null;
    };

export async function updateMembershipReportingAssignment(
  actorUserId: string,
  organizationId: string,
  targetMembershipId: string,
  assignment: ReportingAssignment,
  db: DatabaseClient = prisma,
) {
  return db.$transaction(async (tx) => {
    if (
      !actorUserId.trim() ||
      !organizationId.trim() ||
      !targetMembershipId.trim()
    ) {
      throw new MembershipError(
        "INVALID_INPUT",
        "User ID, organization ID, and membership ID are required.",
      );
    }

    const target = await tx.membership.findFirst({
      where: {
        id: targetMembershipId,
        organizationId,
      },
      include: { role: true },
    });

    if (!target) {
      throw new MembershipError(
        "MEMBERSHIP_NOT_FOUND",
        "Membership not found.",
      );
    }

    const actor = await tx.membership.findUnique({
      where: {
        userId_organizationId: {
          userId: actorUserId,
          organizationId,
        },
      },
      include: { role: true },
    });

    if (!actor) {
      throw new MembershipError(
        "FORBIDDEN",
        "Not authorized to update this reporting assignment.",
      );
    }

    const allowed = await canPerformMembershipAction(
      actorUserId,
      organizationId,
      targetMembershipId,
      "membership.update",
      tx,
    );

    if (!allowed) {
      throw new MembershipError(
        "FORBIDDEN",
        "Not authorized to update this reporting assignment.",
      );
    }

    const isManagerAssignment = assignment.role === "manager";
    const expectedTargetRole = assignment.role;
    const referenceId: string | null = isManagerAssignment
      ? assignment.adminMembershipId
      : assignment.managerMembershipId;

    if (target.role.code !== expectedTargetRole) {
      throw new MembershipError(
        "INVALID_INPUT",
        `Reporting assignment is invalid for role "${target.role.code}".`,
      );
    }

    if (referenceId !== null) {
      const expectedReferenceRole = isManagerAssignment ? "admin" : "manager";

      const reference = await tx.membership.findFirst({
        where: {
          id: referenceId,
          organizationId,
          role: { code: expectedReferenceRole },
        },
        select: { id: true },
      });

      if (!reference) {
        throw new MembershipError(
          "INVALID_INPUT",
          `Reporting assignment must reference a ${expectedReferenceRole} in the same organization.`,
        );
      }
    }

    // The authorization helper validates the target's current scope.
    // Validate the destination separately so an actor cannot move a target
    // into a scope they are not allowed to administer.
    if (actor.role.code === "admin") {
      if (isManagerAssignment) {
        // Admins cannot change a Manager's administrative ownership,
        // including removing their own assignment.
        if (referenceId !== actor.id) {
          throw new MembershipError(
            "FORBIDDEN",
            "Admins cannot change a Manager's administrative ownership.",
          );
        }
      } else if (referenceId !== null) {
        // Members may be assigned only to Managers within this Admin's scope.
        const destinationManager = await tx.membership.findFirst({
          where: {
            id: referenceId,
            organizationId,
            role: { code: "manager" },
            adminMembershipId: actor.id,
          },
          select: { id: true },
        });

        if (!destinationManager) {
          throw new MembershipError(
            "FORBIDDEN",
            "Admins can assign Members only to Managers within their scope.",
          );
        }
      }
    }

    if (
      referenceId !== null &&
      actor.role.code === "manager" &&
      (isManagerAssignment || referenceId !== actor.id)
    ) {
      throw new MembershipError(
        "FORBIDDEN",
        "Managers can assign Members only to themselves or leave them unassigned.",
      );
    }

    const previousAssignment = isManagerAssignment
      ? { adminMembershipId: target.adminMembershipId }
      : { managerMembershipId: target.managerMembershipId };

    const updatedMembership = await tx.membership.update({
      where: { id: target.id },
      data: isManagerAssignment
        ? {
            adminMembershipId: assignment.adminMembershipId,
            managerMembershipId: null,
          }
        : {
            adminMembershipId: null,
            managerMembershipId: assignment.managerMembershipId,
          },
      include: { role: true },
    });

    await createAuditLog(tx, {
      organizationId,
      actorUserId,
      actorMembershipId: actor.id,
      action: "membership.reporting_assignment_changed",
      result: "success",
      targetType: "membership",
      targetId: target.id,
      metadata: {
        role: target.role.code,
        ...previousAssignment,
        ...(isManagerAssignment
          ? { newAdminMembershipId: updatedMembership.adminMembershipId }
          : {
              newManagerMembershipId: updatedMembership.managerMembershipId,
            }),
      },
    });

    return {
      membershipId: updatedMembership.id,
      role: updatedMembership.role.code,
      adminMembershipId: updatedMembership.adminMembershipId,
      managerMembershipId: updatedMembership.managerMembershipId,
    };
  });
}

export async function removeMembership(
  actorUserId: string,
  organizationId: string,
  targetMembershipId: string,
  db = prisma,
) {
  if (
    !actorUserId.trim() ||
    !organizationId.trim() ||
    !targetMembershipId.trim()
  ) {
    throw new MembershipError(
      "INVALID_INPUT",
      "User ID, organization ID, and membership ID are required.",
    );
  }

  return db.$transaction(async (tx) => {
    const target = await tx.membership.findFirst({
      where: {
        id: targetMembershipId,
        organizationId,
      },
      include: { role: true },
    });

    if (!target) {
      throw new MembershipError(
        "MEMBERSHIP_NOT_FOUND",
        "Membership not found.",
      );
    }

    if (target.role.code === "super_user") {
      throw new MembershipError(
        "FORBIDDEN",
        "A Super User membership cannot be removed.",
      );
    }

    const allowed = await canPerformMembershipAction(
      actorUserId,
      organizationId,
      targetMembershipId,
      "membership.remove",
      tx,
    );

    if (!allowed) {
      throw new MembershipError(
        "FORBIDDEN",
        "You are not authorized to remove this membership.",
      );
    }

    const actor = await tx.membership.findUnique({
      where: {
        userId_organizationId: {
          userId: actorUserId,
          organizationId,
        },
      },
      select: { id: true },
    });

    // Preserve subordinate memberships and clear their reporting assignments.
    if (target.role.code === "admin") {
      await tx.membership.updateMany({
        where: { organizationId, adminMembershipId: target.id },
        data: { adminMembershipId: null },
      });
    }

    if (target.role.code === "manager") {
      await tx.membership.updateMany({
        where: { organizationId, managerMembershipId: target.id },
        data: { managerMembershipId: null },
      });
    }

    // Remove restrictive invitation references before deleting the membership.
    const now = new Date();

    await tx.invitation.updateMany({
      where: {
        organizationId,
        OR: [
          { adminMembershipId: target.id },
          { managerMembershipId: target.id },
        ],
      },
      data: {
        revokedAt: now,
        adminMembershipId: null,
        managerMembershipId: null,
      },
    });

    await tx.membership.delete({
      where: { id: target.id },
    });

    await createAuditLog(tx, {
      organizationId,
      actorUserId,
      actorMembershipId: actor?.id ?? null,
      action: "membership.removed",
      result: "success",
      targetType: "membership",
      targetId: target.id,
      metadata: {
        removedRole: target.role.code,
      },
    });

    return {
      membershipId: target.id,
      removedRole: target.role.code,
    };
  });
}
