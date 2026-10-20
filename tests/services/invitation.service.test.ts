import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "@jest/globals";
import {
  testPrisma as prisma,
  disconnectTestDatabase,
} from "../helpers/database.js";
import { createInvitation as createInvitationService } from "../../src/services/invitation.service.js";
import { InvitationError } from "../../src/services/invitation.errors.js";
import { INVITATION_TOKEN_TTL_MS } from "../../src/constants/auth.js";

const createInvitation = (
  actorUserId: string,
  organizationId: string,
  data: Parameters<typeof createInvitationService>[2],
) => createInvitationService(actorUserId, organizationId, data, prisma);

describe("Invitation service", () => {
  afterAll(async () => {
    await disconnectTestDatabase();
  });

  async function createTestUser() {
    return prisma.user.create({
      data: {
        email: `invitation-${randomUUID()}@example.com`,
        passwordHash: "test-hash",
      },
    });
  }

  async function createTestOrganization() {
    return prisma.organization.create({
      data: {
        name: `Organization ${randomUUID()}`,
      },
    });
  }

  async function getRoleId(code: string) {
    const role = await prisma.role.findUnique({
      where: { code },
    });

    if (!role) {
      throw new Error(`Role "${code}" not found. Seed the test database.`);
    }

    return role.id;
  }

  async function createMembership(
    userId: string,
    organizationId: string,
    roleCode: string,
    assignments: {
      adminMembershipId?: string | null;
      managerMembershipId?: string | null;
    } = {},
  ) {
    return prisma.membership.create({
      data: {
        userId,
        organizationId,
        roleId: await getRoleId(roleCode),
        ...assignments,
      },
    });
  }

  test("allows a Manager to invite a Member assigned to themselves", async () => {
    const manager = await createTestUser();
    const organization = await createTestOrganization();

    let managerMembershipId: string | undefined;

    try {
      const managerMembership = await createMembership(
        manager.id,
        organization.id,
        "manager",
      );

      managerMembershipId = managerMembership.id;

      const result = await createInvitation(
        manager.id,
        organization.id,
        {
          email: "  New.Member@Example.com  ",
          roleCode: "member",
          managerMembershipId: managerMembership.id,
        },
      );

      expect(result.invitation.invitedEmail).toBe("new.member@example.com");
      expect(result.invitation.managerMembershipId).toBe(managerMembership.id);
      expect(result.invitation).not.toHaveProperty("tokenHash");
      expect(result.token).toMatch(/^[a-f0-9]{64}$/);

      const storedInvitation = await prisma.invitation.findUniqueOrThrow({
        where: { id: result.invitation.id },
      });

      expect(storedInvitation.tokenHash).toBe(
        createHash("sha256").update(result.token).digest("hex"),
      );

      expect(storedInvitation.tokenHash).not.toBe(result.token);

      const expectedExpiry =
        storedInvitation.createdAt.getTime() + INVITATION_TOKEN_TTL_MS;

      expect(
        Math.abs(storedInvitation.expiresAt.getTime() - expectedExpiry),
      ).toBeLessThanOrEqual(1000);

      const auditLog = await prisma.auditLog.findFirst({
        where: {
          organizationId: organization.id,
          action: "invitation.created",
          targetType: "invitation",
          targetId: result.invitation.id,
        },
      });

      expect(auditLog).not.toBeNull();
      expect(auditLog?.actorUserId).toBe(manager.id);
      expect(auditLog?.actorMembershipId).toBe(managerMembership.id);
      expect(auditLog?.result).toBe("success");
      expect(JSON.stringify(auditLog?.metadata)).not.toContain(result.token);
    } finally {
      // Remove invitations before memberships and users.
      await prisma.invitation.deleteMany({
        where: { organizationId: organization.id },
      });

      // Audit logs are append-only, so temporarily disable the trigger.
      await prisma.$executeRaw`
        ALTER TABLE "audit_logs" DISABLE TRIGGER "audit_logs_append_only"
      `;

      try {
        await prisma.auditLog.deleteMany({
          where: { organizationId: organization.id },
        });
      } finally {
        await prisma.$executeRaw`
        ALTER TABLE "audit_logs" ENABLE TRIGGER "audit_logs_append_only"
      `;
      }

      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });

      await prisma.user.deleteMany({
        where: { id: manager.id },
      });

      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("rejects a Member attempting to create an invitation", async () => {
    const member = await createTestUser();
    const organization = await createTestOrganization();

    try {
      await createMembership(member.id, organization.id, "member");

      await expect(
        createInvitation(
          member.id,
          organization.id,
          {
            email: "new.member@example.com",
            roleCode: "member",
          },
        ),
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    } finally {
      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });
      await prisma.user.deleteMany({
        where: { id: member.id },
      });
      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("rejects a Manager attempting to invite an Admin", async () => {
    const manager = await createTestUser();
    const organization = await createTestOrganization();

    try {
      await createMembership(manager.id, organization.id, "manager");

      await expect(
        createInvitation(manager.id, organization.id, {
          email: "new.admin@example.com",
          roleCode: "admin",
        }),
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    } finally {
      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });
      await prisma.user.deleteMany({
        where: { id: manager.id },
      });
      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("rejects a duplicate pending invitation for the same email", async () => {
    const manager = await createTestUser();
    const organization = await createTestOrganization();

    try {
      const managerMembership = await createMembership(
        manager.id,
        organization.id,
        "manager",
      );

      const invitationInput = {
        email: "duplicate@example.com",
        roleCode: "member" as const,
        managerMembershipId: managerMembership.id,
      };

      await createInvitation(
        manager.id,
        organization.id,
        invitationInput,
      );

      await expect(
        createInvitation(manager.id, organization.id, {
          ...invitationInput,
          email: "  DUPLICATE@example.com ",
        }),
      ).rejects.toMatchObject({
        code: "PENDING_INVITATION_EXISTS",
      });

      const invitations = await prisma.invitation.findMany({
        where: {
          organizationId: organization.id,
          invitedEmail: "duplicate@example.com",
        },
      });

      expect(invitations).toHaveLength(1);
    } finally {
      await prisma.invitation.deleteMany({
        where: { organizationId: organization.id },
      });

      await prisma.$executeRaw`
        ALTER TABLE "audit_logs" DISABLE TRIGGER "audit_logs_append_only"
      `;

      try {
        await prisma.auditLog.deleteMany({
          where: { organizationId: organization.id },
        });
      } finally {
        await prisma.$executeRaw`
          ALTER TABLE "audit_logs" ENABLE TRIGGER "audit_logs_append_only"
        `;
      }

      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });

      await prisma.user.deleteMany({
        where: { id: manager.id },
      });

      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("allows a new invitation when the previous invitation has expired", async () => {
    const manager = await createTestUser();
    const organization = await createTestOrganization();

    try {
      const managerMembership = await createMembership(
        manager.id,
        organization.id,
        "manager",
      );

      const email = "expired-invitation@example.com";

      // Create the original invitation.
      const original = await createInvitation(manager.id, organization.id, {
        email,
        roleCode: "member",
        managerMembershipId: managerMembership.id,
      });

      // Expire the original invitation directly in the test database.
      await prisma.invitation.update({
        where: { id: original.invitation.id },
        data: {
          expiresAt: new Date(Date.now() - 60_000),
        },
      });

      // A new invitation for the same email should now succeed.
      const replacement = await createInvitation(manager.id, organization.id, {
        email,
        roleCode: "member",
        managerMembershipId: managerMembership.id,
      });

      expect(replacement.invitation.id).not.toBe(original.invitation.id);
      expect(replacement.invitation.invitedEmail).toBe(email);
      expect(replacement.invitation.expiresAt.getTime()).toBeGreaterThan(
        Date.now(),
      );
    } finally {
      await prisma.invitation.deleteMany({
        where: { organizationId: organization.id },
      });

      await prisma.$executeRaw`
        ALTER TABLE "audit_logs" DISABLE TRIGGER "audit_logs_append_only"
      `;

      try {
        await prisma.auditLog.deleteMany({
          where: { organizationId: organization.id },
        });
      } finally {
        await prisma.$executeRaw`
          ALTER TABLE "audit_logs" ENABLE TRIGGER "audit_logs_append_only"
        `;
      }

      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });

      await prisma.user.deleteMany({
        where: { id: manager.id },
      });

      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("allows a new invitation when the previous invitation was revoked", async () => {
    const manager = await createTestUser();
    const organization = await createTestOrganization();

    try {
      const managerMembership = await createMembership(
        manager.id,
        organization.id,
        "manager",
      );

      const email = "revoked-invitation@example.com";

      const original = await createInvitation(manager.id, organization.id, {
        email,
        roleCode: "member",
        managerMembershipId: managerMembership.id,
      });

      await prisma.invitation.update({
        where: { id: original.invitation.id },
        data: { revokedAt: new Date() },
      });

      const replacement = await createInvitation(manager.id, organization.id, {
        email,
        roleCode: "member",
        managerMembershipId: managerMembership.id,
      });

      expect(replacement.invitation.id).not.toBe(original.invitation.id);
      expect(replacement.invitation.invitedEmail).toBe(email);
      expect(replacement.invitation.revokedAt).toBeNull();
    } finally {
      await prisma.invitation.deleteMany({
        where: { organizationId: organization.id },
      });

      await prisma.$executeRaw`
        ALTER TABLE "audit_logs" DISABLE TRIGGER "audit_logs_append_only"
      `;

      try {
        await prisma.auditLog.deleteMany({
          where: { organizationId: organization.id },
        });
      } finally {
        await prisma.$executeRaw`
          ALTER TABLE "audit_logs" ENABLE TRIGGER "audit_logs_append_only"
        `;
      }

      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });

      await prisma.user.deleteMany({
        where: { id: manager.id },
      });

      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("prevents duplicate invitations when requests run concurrently", async () => {
    const organization = await createTestOrganization();

    const rawOrganizations = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id
      FROM organizations
      WHERE id = ${organization.id}::uuid
    `;

    const user = await createTestUser();
    const manager = await createMembership(user.id, organization.id, "manager");

    const input = {
      email: `concurrent-${randomUUID()}@example.com`,
      roleCode: "member" as const,
      managerMembershipId: manager.id,
    };

    try {
      const results = await Promise.allSettled([
        createInvitation(user.id, organization.id, input),
        createInvitation(user.id, organization.id, input),
      ]);

      const successful = results.filter(
        (result) => result.status === "fulfilled",
      );
      const failed = results.filter((result) => result.status === "rejected");

      expect(successful).toHaveLength(1);
      expect(failed).toHaveLength(1);

      if (failed[0].status === "rejected") {
        expect(failed[0].reason).toBeInstanceOf(InvitationError);
        expect(failed[0].reason.code).toBe("PENDING_INVITATION_EXISTS");
      }

      const invitations = await prisma.invitation.findMany({
        where: {
          organizationId: organization.id,
          invitedEmail: input.email,
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
      });

      expect(invitations).toHaveLength(1);
    } finally {
      await prisma.invitation.deleteMany({
        where: { organizationId: organization.id },
      });

      await prisma.$executeRaw`
      ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append_only
    `;
      try {
        await prisma.auditLog.deleteMany({
          where: { organizationId: organization.id },
        });
      } finally {
        await prisma.$executeRaw`
        ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_append_only
      `;
      }

      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });
      await prisma.user.deleteMany({
        where: { id: user.id },
      });
      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("rejects an Admin assigning a Member to a Manager outside their scope", async () => {
    const admin = await createTestUser();
    const otherAdmin = await createTestUser();
    const manager = await createTestUser();
    const organization = await createTestOrganization();

    try {
      const adminMembership = await createMembership(
        admin.id,
        organization.id,
        "admin",
      );

      const otherAdminMembership = await createMembership(
        otherAdmin.id,
        organization.id,
        "admin",
      );

      const managerMembership = await createMembership(
        manager.id,
        organization.id,
        "manager",
        { adminMembershipId: otherAdminMembership.id },
      );

      await expect(
        createInvitation(admin.id, organization.id, {
          email: "new.member@example.com",
          roleCode: "member",
          managerMembershipId: managerMembership.id,
        }),
      ).rejects.toMatchObject({
        code: "INVALID_ASSIGNMENT",
      });

      const invitations = await prisma.invitation.findMany({
        where: { organizationId: organization.id },
      });

      expect(invitations).toHaveLength(0);
    } finally {
      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });

      await prisma.user.deleteMany({
        where: {
          id: { in: [admin.id, otherAdmin.id, manager.id] },
        },
      });

      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("rejects an invalid organization ID", async () => {
    await expect(
      createInvitation("not-a-uuid", "invalid-org-id", {
        email: "new.member@example.com",
        roleCode: "member",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  test("rejects an invalid email address", async () => {
    const manager = await createTestUser();
    const organization = await createTestOrganization();

    try {
      await createMembership(manager.id, organization.id, "manager");

      await expect(
        createInvitation(manager.id, organization.id, {
          email: "not-an-email",
          roleCode: "member",
        }),
      ).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });

      const invitations = await prisma.invitation.findMany({
        where: { organizationId: organization.id },
      });

      expect(invitations).toHaveLength(0);
    } finally {
      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });
      await prisma.user.delete({ where: { id: manager.id } });
      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("rolls back invitation creation if audit logging fails", async () => {
    const manager = await createTestUser();
    const organization = await createTestOrganization();
    const triggerName = `test_invitation_audit_failure_${randomUUID().replaceAll("-", "")}`;
    const functionName = `${triggerName}_fn`;

    try {
      await createMembership(manager.id, organization.id, "manager");

      await prisma.$executeRawUnsafe(`
        CREATE FUNCTION ${functionName}() RETURNS trigger AS $$
        BEGIN
          IF NEW.action = 'invitation.created' THEN
            RAISE EXCEPTION 'forced invitation audit failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `);

      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER ${triggerName}
        BEFORE INSERT ON audit_logs
        FOR EACH ROW
        EXECUTE FUNCTION ${functionName}()
      `);

      await expect(
        createInvitation(manager.id, organization.id, {
          email: "rollback@example.com",
          roleCode: "member",
          managerMembershipId: (
            await prisma.membership.findFirstOrThrow({
              where: {
                userId: manager.id,
                organizationId: organization.id,
              },
            })
          ).id,
        }),
      ).rejects.toThrow("forced invitation audit failure");

      expect(
        await prisma.invitation.count({
          where: {
            organizationId: organization.id,
            invitedEmail: "rollback@example.com",
          },
        }),
      ).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS ${triggerName} ON audit_logs`,
      );
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${functionName}()`);

      await prisma.invitation.deleteMany({
        where: { organizationId: organization.id },
      });

      await prisma.$executeRaw`
        ALTER TABLE "audit_logs" DISABLE TRIGGER "audit_logs_append_only"
      `;
      try {
        await prisma.auditLog.deleteMany({
          where: { organizationId: organization.id },
        });
      } finally {
        await prisma.$executeRaw`
          ALTER TABLE "audit_logs" ENABLE TRIGGER "audit_logs_append_only"
        `;
      }

      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });
      await prisma.user.delete({ where: { id: manager.id } });
      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("allows a Super User to invite an Admin", async () => {
    const superUser = await createTestUser();
    const organization = await createTestOrganization();

    try {
      await createMembership(superUser.id, organization.id, "super_user");

      const result = await createInvitation(superUser.id, organization.id, {
        email: "new.admin@example.com",
        roleCode: "admin",
      });

      expect(result.invitation.invitedEmail).toBe("new.admin@example.com");
      expect(result.invitation.roleId).toBe(await getRoleId("admin"));
      expect(result.invitation.adminMembershipId).toBeNull();
      expect(result.invitation.managerMembershipId).toBeNull();
      expect(result.invitation).not.toHaveProperty("tokenHash");
      expect(result.token).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await prisma.invitation.deleteMany({
        where: { organizationId: organization.id },
      });

      await prisma.$executeRaw`
        ALTER TABLE "audit_logs" DISABLE TRIGGER "audit_logs_append_only"
      `;
      try {
        await prisma.auditLog.deleteMany({
          where: { organizationId: organization.id },
        });
      } finally {
        await prisma.$executeRaw`
          ALTER TABLE "audit_logs" ENABLE TRIGGER "audit_logs_append_only"
        `;
      }

      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });
      await prisma.user.delete({
        where: { id: superUser.id },
      });
      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("rejects an Admin assigning a Manager to another Admin", async () => {
    const admin = await createTestUser();
    const otherAdmin = await createTestUser();
    const organization = await createTestOrganization();

    try {
      const adminMembership = await createMembership(
        admin.id,
        organization.id,
        "admin",
      );

      const otherAdminMembership = await createMembership(
        otherAdmin.id,
        organization.id,
        "admin",
      );

      await expect(
        createInvitation(admin.id, organization.id, {
          email: "new.manager@example.com",
          roleCode: "manager",
          adminMembershipId: otherAdminMembership.id,
        }),
      ).rejects.toMatchObject({
        code: "INVALID_ASSIGNMENT",
      });

      expect(
        await prisma.invitation.count({
          where: {
            organizationId: organization.id,
            invitedEmail: "new.manager@example.com",
          },
        }),
      ).toBe(0);
    } finally {
      await prisma.invitation.deleteMany({
        where: { organizationId: organization.id },
      });

      await prisma.$executeRaw`
        ALTER TABLE "audit_logs" DISABLE TRIGGER "audit_logs_append_only"
      `;
      try {
        await prisma.auditLog.deleteMany({
          where: { organizationId: organization.id },
        });
      } finally {
        await prisma.$executeRaw`
          ALTER TABLE "audit_logs" ENABLE TRIGGER "audit_logs_append_only"
        `;
      }

      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });

      await prisma.user.deleteMany({
        where: {
          id: { in: [admin.id, otherAdmin.id] },
        },
      });

      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("rejects assigning a Member to a Manager from another organization", async () => {
    const admin = await createTestUser();
    const manager = await createTestUser();
    const organization = await createTestOrganization();
    const otherOrganization = await createTestOrganization();

    try {
      await createMembership(admin.id, organization.id, "admin");

      const otherManagerMembership = await createMembership(
        manager.id,
        otherOrganization.id,
        "manager",
      );

      await expect(
        createInvitation(admin.id, organization.id, {
          email: "cross-org-member@example.com",
          roleCode: "member",
          managerMembershipId: otherManagerMembership.id,
        }),
      ).rejects.toMatchObject({
        code: "INVALID_ASSIGNMENT",
      });

      expect(
        await prisma.invitation.count({
          where: {
            organizationId: organization.id,
            invitedEmail: "cross-org-member@example.com",
          },
        }),
      ).toBe(0);
    } finally {
      await prisma.invitation.deleteMany({
        where: {
          organizationId: {
            in: [organization.id, otherOrganization.id],
          },
        },
      });

      await prisma.$executeRaw`
        ALTER TABLE "audit_logs" DISABLE TRIGGER "audit_logs_append_only"
      `;
      try {
        await prisma.auditLog.deleteMany({
          where: {
            organizationId: {
              in: [organization.id, otherOrganization.id],
            },
          },
        });
      } finally {
        await prisma.$executeRaw`
          ALTER TABLE "audit_logs" ENABLE TRIGGER "audit_logs_append_only"
        `;
      }

      await prisma.membership.deleteMany({
        where: {
          organizationId: {
            in: [organization.id, otherOrganization.id],
          },
        },
      });

      await prisma.user.deleteMany({
        where: { id: { in: [admin.id, manager.id] } },
      });

      await prisma.organization.deleteMany({
        where: {
          id: { in: [organization.id, otherOrganization.id] },
        },
      });
    }
  });

  test("allows a Super User to assign an invited Manager to an Admin", async () => {
    const superUser = await createTestUser();
    const admin = await createTestUser();
    const organization = await createTestOrganization();

    try {
      await createMembership(superUser.id, organization.id, "super_user");

      const adminMembership = await createMembership(
        admin.id,
        organization.id,
        "admin",
      );

      const result = await createInvitation(superUser.id, organization.id, {
        email: "assigned-manager@example.com",
        roleCode: "manager",
        adminMembershipId: adminMembership.id,
      });

      expect(result.invitation.adminMembershipId).toBe(adminMembership.id);
      expect(result.invitation.managerMembershipId).toBeNull();
    } finally {
      await prisma.invitation.deleteMany({
        where: { organizationId: organization.id },
      });

      await prisma.$executeRaw`
      ALTER TABLE "audit_logs" DISABLE TRIGGER "audit_logs_append_only"
    `;

      try {
        await prisma.auditLog.deleteMany({
          where: { organizationId: organization.id },
        });
      } finally {
        await prisma.$executeRaw`
        ALTER TABLE "audit_logs" ENABLE TRIGGER "audit_logs_append_only"
      `;
      }

      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });

      await prisma.user.deleteMany({
        where: { id: { in: [superUser.id, admin.id] } },
      });

      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("allows an Admin to assign an invited Manager to themselves", async () => {
    const admin = await createTestUser();
    const organization = await createTestOrganization();

    try {
      const adminMembership = await createMembership(
        admin.id,
        organization.id,
        "admin",
      );

      const result = await createInvitation(admin.id, organization.id, {
        email: "admin-assigned-manager@example.com",
        roleCode: "manager",
        adminMembershipId: adminMembership.id,
      });

      expect(result.invitation.adminMembershipId).toBe(adminMembership.id);
      expect(result.invitation.managerMembershipId).toBeNull();
    } finally {
      await prisma.invitation.deleteMany({
        where: { organizationId: organization.id },
      });

      await prisma.$executeRaw`
        ALTER TABLE "audit_logs" DISABLE TRIGGER "audit_logs_append_only"
      `;

      try {
        await prisma.auditLog.deleteMany({
          where: { organizationId: organization.id },
        });
      } finally {
        await prisma.$executeRaw`
          ALTER TABLE "audit_logs" ENABLE TRIGGER "audit_logs_append_only"
        `;
      }

      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });

      await prisma.user.deleteMany({
        where: { id: admin.id },
      });

      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("rejects an Admin inviting a Manager without an Admin assignment", async () => {
    const admin = await createTestUser();
    const organization = await createTestOrganization();

    try {
      await createMembership(admin.id, organization.id, "admin");

      await expect(
        createInvitation(admin.id, organization.id, {
          email: "unassigned-manager@example.com",
          roleCode: "manager",
          adminMembershipId: null,
        }),
      ).rejects.toMatchObject({
        code: "INVALID_ASSIGNMENT",
      });

      expect(
        await prisma.invitation.count({
          where: {
            organizationId: organization.id,
            invitedEmail: "unassigned-manager@example.com",
          },
        }),
      ).toBe(0);
    } finally {
      await prisma.invitation.deleteMany({
        where: { organizationId: organization.id },
      });

      await prisma.$executeRaw`
        ALTER TABLE "audit_logs" DISABLE TRIGGER "audit_logs_append_only"
      `;

      try {
        await prisma.auditLog.deleteMany({
          where: { organizationId: organization.id },
        });
      } finally {
        await prisma.$executeRaw`
          ALTER TABLE "audit_logs" ENABLE TRIGGER "audit_logs_append_only"
        `;
      }

      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });

      await prisma.user.deleteMany({
        where: { id: admin.id },
      });

      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("allows a Super User to invite a Manager without an Admin assignment", async () => {
    const superUser = await createTestUser();
    const organization = await createTestOrganization();

    try {
      await createMembership(superUser.id, organization.id, "super_user");

      const result = await createInvitation(superUser.id, organization.id, {
        email: "unassigned-super-manager@example.com",
        roleCode: "manager",
        adminMembershipId: null,
      });

      expect(result.invitation.adminMembershipId).toBeNull();
      expect(result.invitation.managerMembershipId).toBeNull();
    } finally {
      await prisma.invitation.deleteMany({
        where: { organizationId: organization.id },
      });

      await prisma.$executeRaw`
        ALTER TABLE "audit_logs" DISABLE TRIGGER "audit_logs_append_only"
      `;

      try {
        await prisma.auditLog.deleteMany({
          where: { organizationId: organization.id },
        });
      } finally {
        await prisma.$executeRaw`
          ALTER TABLE "audit_logs" ENABLE TRIGGER "audit_logs_append_only"
        `;
      }

      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });

      await prisma.user.deleteMany({
        where: { id: superUser.id },
      });

      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("allows an Admin to invite a Member without a Manager assignment", async () => {
    const admin = await createTestUser();
    const organization = await createTestOrganization();

    try {
      await createMembership(admin.id, organization.id, "admin");

      const result = await createInvitation(admin.id, organization.id, {
        email: "unassigned-admin-member@example.com",
        roleCode: "member",
        managerMembershipId: null,
      });

      expect(result.invitation.adminMembershipId).toBeNull();
      expect(result.invitation.managerMembershipId).toBeNull();
    } finally {
      await prisma.invitation.deleteMany({
        where: { organizationId: organization.id },
      });

      await prisma.$executeRaw`
        ALTER TABLE "audit_logs" DISABLE TRIGGER "audit_logs_append_only"
      `;

      try {
        await prisma.auditLog.deleteMany({
          where: { organizationId: organization.id },
        });
      } finally {
        await prisma.$executeRaw`
          ALTER TABLE "audit_logs" ENABLE TRIGGER "audit_logs_append_only"
        `;
      }

      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });

      await prisma.user.deleteMany({
        where: { id: admin.id },
      });

      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });
});
