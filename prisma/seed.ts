import { prisma } from "../src/lib/prisma";

const roles = [
  {
    id: "00000000-0000-0000-0000-000000000001",
    code: "super_user",
    name: "Super User",
    description: "Organization-wide administrative authority and Owner",
  },
  {
    id: "00000000-0000-0000-0000-000000000002",
    code: "admin",
    name: "Admin",
    description:
      "Manages Managers assigned to the Admin and Members under those Managers, plus unassigned Members",
  },
  {
    id: "00000000-0000-0000-0000-000000000003",
    code: "manager",
    name: "Manager",
    description: "Manages Members directly assigned to the Manager",
  },
  {
    id: "00000000-0000-0000-0000-000000000004",
    code: "member",
    name: "Member",
    description:
      "Organization participant without membership-management authority",
  },
];

const permissions = [
  {
    id: "10000000-0000-0000-0000-000000000001",
    code: "organization.read",
    name: "Read Organization",
    description: "View basic organization information",
  },
  {
    id: "10000000-0000-0000-0000-000000000002",
    code: "membership.read",
    name: "Read Memberships",
    description:
      "View organization members, roles, and reporting relationships permitted by visibility rules",
  },
  {
    id: "10000000-0000-0000-0000-000000000003",
    code: "invitation.create",
    name: "Create Invitation",
    description:
      "Create an invitation for an allowed role and reporting assignment",
  },
  {
    id: "10000000-0000-0000-0000-000000000004",
    code: "invitation.revoke",
    name: "Revoke Invitation",
    description: "Revoke an invitation within permitted scope",
  },
  {
    id: "10000000-0000-0000-0000-000000000005",
    code: "membership.update",
    name: "Update Membership",
    description:
      "Change a membership role or valid reporting assignment within permitted scope",
  },
  {
    id: "10000000-0000-0000-0000-000000000006",
    code: "membership.remove",
    name: "Remove Membership",
    description: "Remove a membership within permitted scope",
  },
  {
    id: "10000000-0000-0000-0000-000000000007",
    code: "organization.manage",
    name: "Manage Organization",
    description:
      "Update organization settings and transfer ownership",
  },
  {
    id: "10000000-0000-0000-0000-000000000008",
    code: "audit_log.read",
    name: "Read Audit Logs",
    description: "View organization audit events when authorized",
  },
  {
    id: "10000000-0000-0000-0000-000000000009",
    code: "session.manage_self",
    name: "Manage Own Sessions",
    description: "View and revoke the actor's own sessions",
  },
  {
    id: "10000000-0000-0000-0000-000000000010",
    code: "session.manage_any",
    name: "Manage Any Session",
    description:
      "Revoke another user's sessions when that user is within the actor's permitted scope",
  },
];

const rolePermissionMap: Record<string, string[]> = {
  super_user: [
    "organization.read",
    "membership.read",
    "invitation.create",
    "invitation.revoke",
    "membership.update",
    "membership.remove",
    "organization.manage",
    "audit_log.read",
    "session.manage_self",
    "session.manage_any",
  ],

  admin: [
    "organization.read",
    "membership.read",
    "invitation.create",
    "invitation.revoke",
    "membership.update",
    "membership.remove",
    "audit_log.read",
    "session.manage_self",
    "session.manage_any",
  ],

  manager: [
    "organization.read",
    "membership.read",
    "invitation.create",
    "invitation.revoke",
    "membership.remove",
    "session.manage_self",
    "session.manage_any",
  ],

  member: [
    "organization.read",
    "membership.read",
    "session.manage_self",
  ],
};

async function main() {
  console.log("Seeding reference data...");

  for (const role of roles) {
    await prisma.role.upsert({
      where: { code: role.code },
      update: {
        name: role.name,
        description: role.description,
      },
      create: role,
    });
  }

  for (const permission of permissions) {
    await prisma.permission.upsert({
      where: { code: permission.code },
      update: {
        name: permission.name,
        description: permission.description,
      },
      create: permission,
    });
  }

  const seededRoles = await prisma.role.findMany();
  const seededPermissions = await prisma.permission.findMany();

  const roleMap = new Map(
    seededRoles.map((role) => [role.code, role.id]),
  );

  const permissionMap = new Map(
    seededPermissions.map((permission) => [
      permission.code,
      permission.id,
    ]),
  );

  for (const [roleCode, permissionCodes] of Object.entries(
    rolePermissionMap,
  )) {
    const roleId = roleMap.get(roleCode);

    if (!roleId) {
      throw new Error(`Role not found: ${roleCode}`);
    }

    for (const permissionCode of permissionCodes) {
      const permissionId = permissionMap.get(permissionCode);

      if (!permissionId) {
        throw new Error(
          `Permission not found: ${permissionCode}`,
        );
      }

      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId,
            permissionId,
          },
        },
        update: {},
        create: {
          roleId,
          permissionId,
        },
      });
    }
  }

  console.log("Seed completed successfully.");
}

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
