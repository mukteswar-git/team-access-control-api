import { findMembershipByUserAndOrganization } from "../repositories/membership.repository.js";
import { prisma, type DatabaseClient } from "../lib/prisma.js";

export async function hasPermission(
  userId: string,
  organizationId: string,
  permissionCode: string,
  db: DatabaseClient = prisma,
): Promise<boolean> {
  const membership = await findMembershipByUserAndOrganization(
    userId,
    organizationId,
    db,
  );

  if (!membership) return false;

  return membership.role.rolePermissions.some(
    (rolePermission) => rolePermission.permission.code === permissionCode,
  );
}

export async function canManageMembership(
  actorUserId: string,
  organizationId: string,
  targetMembershipId: string,
  db: DatabaseClient = prisma,
): Promise<boolean> {
  const actor = await findMembershipByUserAndOrganization(
    actorUserId,
    organizationId,
    db,
  );

  if (!actor) return false;

  const target = await db.membership.findFirst({
    where: { id: targetMembershipId, organizationId },
    include: { role: true },
  });

  if (!target || actor.id === target.id) return false;

  const actorRole = actor.role.code;
  const targetRole = target.role.code;

  if (actorRole === "super_user") {
    return targetRole !== "super_user";
  }

  if (actorRole === "member") return false;

  if (actorRole === "admin") {
    if (targetRole === "super_user" || targetRole === "admin") {
      return false;
    }

    if (targetRole === "manager") {
      return target.adminMembershipId === actor.id;
    }

    if (targetRole === "member") {
      if (target.adminMembershipId !== null) return false;

      if (target.managerMembershipId === null) return true;

      return isManagerAssignedToAdmin(
        target.managerMembershipId,
        actor.id,
        organizationId,
        db,
      );
    }

    return false;
  }

  if (actorRole === "manager") {
    return targetRole === "member" && target.managerMembershipId === actor.id;
  }

  return false;
}

async function isManagerAssignedToAdmin(
  managerMembershipId: string,
  adminMembershipId: string,
  organizationId: string,
  db: DatabaseClient,
): Promise<boolean> {
  const manager = await db.membership.findFirst({
    where: {
      id: managerMembershipId,
      organizationId,
      role: { code: "manager" },
      adminMembershipId,
    },
    select: { id: true },
  });

  return manager !== null;
}

export async function canPerformMembershipAction(
  actorUserId: string,
  organizationId: string,
  targetMembershipId: string,
  permissionCode: string,
  db: DatabaseClient = prisma,
): Promise<boolean> {
  const permissionGranted = await hasPermission(
    actorUserId,
    organizationId,
    permissionCode,
    db,
  );

  if (!permissionGranted) return false;

  return canManageMembership(
    actorUserId,
    organizationId,
    targetMembershipId,
    db,
  );
}

export async function canChangeMembershipRole(
  actorUserId: string,
  organizationId: string,
  targetMembershipId: string,
  newRoleCode: string,
  db: DatabaseClient = prisma,
): Promise<boolean> {
  const validRoleCodes = ["super_user", "admin", "manager", "member"];

  if (!validRoleCodes.includes(newRoleCode)) return false;

  const actor = await findMembershipByUserAndOrganization(
    actorUserId,
    organizationId,
    db,
  );

  if (!actor) return false;

  const target = await db.membership.findFirst({
    where: { id: targetMembershipId, organizationId },
    include: { role: true },
  });

  if (!target || actor.id === target.id) return false;

  const actorRole = actor.role.code;
  const currentRole = target.role.code;

  if (currentRole === newRoleCode) return false;

  // Ownership changes require the dedicated transfer workflow.
  if (currentRole === "super_user" || newRoleCode === "super_user") {
    return false;
  }

  const canUpdate = await canPerformMembershipAction(
    actorUserId,
    organizationId,
    targetMembershipId,
    "membership.update",
    db,
  );

  if (!canUpdate) return false;

  if (actorRole === "super_user") return true;

  if (
    actorRole === "admin" &&
    currentRole === "member" &&
    newRoleCode === "manager"
  ) {
    return true;
  }

  if (
    actorRole === "admin" &&
    currentRole === "manager" &&
    newRoleCode === "member"
  ) {
    return true;
  }

  return false;
}
