import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "@jest/globals";
import {
  testPrisma as prisma,
  disconnectTestDatabase,
} from "../helpers/database.js";
import {
  acceptInvitation,
  createInvitation as createInvitationService,
  getInvitationStatus,
  revokeInvitation as revokeInvitationService,
} from "../../src/services/invitation.service.js";
import { InvitationError } from "../../src/services/invitation.errors.js";
import { INVITATION_TOKEN_TTL_MS } from "../../src/constants/auth.js";

const createInvitation = (
  actorUserId: string,
  organizationId: string,
  data: Parameters<typeof createInvitationService>[2],
) => createInvitationService(actorUserId, organizationId, data, prisma);

const revokeInvitation = (
  actorUserId: string,
  organizationId: string,
  invitationId: string,
) => revokeInvitationService(actorUserId, organizationId, invitationId, prisma);

describe("getInvitationStatus", () => {
  const now = new Date("2026-10-20T10:00:00.000Z");

  test("returns pending for an unexpired invitation", () => {
    expect(
      getInvitationStatus(
        {
          expiresAt: new Date("2026-10-21T10:00:00.000Z"),
          acceptedAt: null,
          revokedAt: null,
        },
        now,
      ),
    ).toBe("pending");
  });

  test("returns expired when the expiry time has passed", () => {
    expect(
      getInvitationStatus(
        {
          expiresAt: new Date("2026-10-19T10:00:00.000Z"),
          acceptedAt: null,
          revokedAt: null,
        },
        now,
      ),
    ).toBe("expired");
  });

  test("returns revoked when revokedAt is set", () => {
    expect(
      getInvitationStatus(
        {
          expiresAt: new Date("2026-10-21T10:00:00.000Z"),
          acceptedAt: null,
          revokedAt: new Date("2026-10-19T10:00:00.000Z"),
        },
        now,
      ),
    ).toBe("revoked");
  });

  test("returns accepted when acceptedAt is set", () => {
    expect(
      getInvitationStatus(
        {
          expiresAt: new Date("2026-10-19T10:00:00.000Z"),
          acceptedAt: new Date("2026-10-18T10:00:00.000Z"),
          revokedAt: null,
        },
        now,
      ),
    ).toBe("accepted");
  });
});

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

  const cleanupInvitationTestData = async (
    organizationIds: string[],
    userIds: string[],
  ) => {
    await prisma.invitation.deleteMany({
      where: { organizationId: { in: organizationIds } },
    });

    await prisma.$executeRaw`
      ALTER TABLE "audit_logs" DISABLE TRIGGER "audit_logs_append_only"
    `;

    try {
      await prisma.auditLog.deleteMany({
        where: { organizationId: { in: organizationIds } },
      });
    } finally {
      await prisma.$executeRaw`
        ALTER TABLE "audit_logs" ENABLE TRIGGER "audit_logs_append_only"
      `;
    }

    await prisma.membership.deleteMany({
      where: { organizationId: { in: organizationIds } },
    });

    await prisma.user.deleteMany({
      where: { id: { in: userIds } },
    });

    await prisma.organization.deleteMany({
      where: { id: { in: organizationIds } },
    });
  };

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

      const result = await createInvitation(manager.id, organization.id, {
        email: "  New.Member@Example.com  ",
        roleCode: "member",
        managerMembershipId: managerMembership.id,
      });

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
        createInvitation(member.id, organization.id, {
          email: "new.member@example.com",
          roleCode: "member",
        }),
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

      await createInvitation(manager.id, organization.id, invitationInput);

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

  test("allows only one concurrent revocation of the same invitation", async () => {
    const manager = await createTestUser();
    const organization = await createTestOrganization();

    try {
      const managerMembership = await createMembership(
        manager.id,
        organization.id,
        "manager",
      );

      const { invitation } = await createInvitation(
        manager.id,
        organization.id,
        {
          email: `concurrent-revoke-${randomUUID()}@example.com`,
          roleCode: "member",
          managerMembershipId: managerMembership.id,
        },
      );

      const results = await Promise.allSettled([
        revokeInvitation(manager.id, organization.id, invitation.id),
        revokeInvitation(manager.id, organization.id, invitation.id),
      ]);

      const successes = results.filter(
        (result) => result.status === "fulfilled",
      );

      const failures = results.filter((result) => result.status === "rejected");

      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);

      if (failures[0].status === "rejected") {
        expect(failures[0].reason).toMatchObject({
          code: "INVALID_INVITATION_STATE",
        });
      }

      const storedInvitation = await prisma.invitation.findUniqueOrThrow({
        where: { id: invitation.id },
      });

      expect(storedInvitation.revokedAt).toBeInstanceOf(Date);

      const auditLogs = await prisma.auditLog.findMany({
        where: {
          organizationId: organization.id,
          action: "invitation.revoked",
          targetType: "invitation",
          targetId: invitation.id,
          result: "success",
        },
      });

      expect(auditLogs).toHaveLength(1);
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

  test("rolls back invitation revocation if audit logging fails", async () => {
    const manager = await createTestUser();
    const organization = await createTestOrganization();
    const triggerName = `test_revocation_audit_failure_${randomUUID().replaceAll("-", "")}`;
    const functionName = `${triggerName}_fn`;

    try {
      const managerMembership = await createMembership(
        manager.id,
        organization.id,
        "manager",
      );

      const { invitation } = await createInvitation(
        manager.id,
        organization.id,
        {
          email: `rollback-revoke-${randomUUID()}@example.com`,
          roleCode: "member",
          managerMembershipId: managerMembership.id,
        },
      );

      await prisma.$executeRawUnsafe(`
        CREATE FUNCTION ${functionName}() RETURNS trigger AS $$
        BEGIN
          IF NEW.action = 'invitation.revoked' THEN
            RAISE EXCEPTION 'forced revocation audit failure';
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
        revokeInvitation(manager.id, organization.id, invitation.id),
      ).rejects.toThrow("forced revocation audit failure");

      const storedInvitation = await prisma.invitation.findUniqueOrThrow({
        where: { id: invitation.id },
      });

      expect(storedInvitation.revokedAt).toBeNull();
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS ${triggerName} ON audit_logs`,
      );
      await prisma.$executeRawUnsafe(
        `DROP FUNCTION IF EXISTS ${functionName}()`,
      );

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
      await prisma.$executeRawUnsafe(
        `DROP FUNCTION IF EXISTS ${functionName}()`,
      );

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

  test("allows an authorized Manager to revoke a pending invitation", async () => {
    const manager = await createTestUser();
    const organization = await createTestOrganization();

    try {
      const managerMembership = await createMembership(
        manager.id,
        organization.id,
        "manager",
      );

      const { invitation } = await createInvitation(
        manager.id,
        organization.id,
        {
          email: `revoke-${randomUUID()}@example.com`,
          roleCode: "member",
          managerMembershipId: managerMembership.id,
        },
      );

      const result = await revokeInvitation(
        manager.id,
        organization.id,
        invitation.id,
      );

      expect(result.invitationId).toBe(invitation.id);
      expect(result.status).toBe("revoked");
      expect(result.revokedAt).toBeInstanceOf(Date);

      const storedInvitation = await prisma.invitation.findUniqueOrThrow({
        where: { id: invitation.id },
      });

      expect(storedInvitation.revokedAt).toEqual(result.revokedAt);

      const auditLog = await prisma.auditLog.findFirst({
        where: {
          organizationId: organization.id,
          action: "invitation.revoked",
          targetType: "invitation",
          targetId: invitation.id,
        },
      });

      expect(auditLog).not.toBeNull();
      expect(auditLog?.actorUserId).toBe(manager.id);
      expect(auditLog?.actorMembershipId).toBe(managerMembership.id);
      expect(auditLog?.result).toBe("success");
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

  test("rejects revoking an invitation that has already been revoked", async () => {
    const manager = await createTestUser();
    const organization = await createTestOrganization();

    try {
      const managerMembership = await createMembership(
        manager.id,
        organization.id,
        "manager",
      );

      const { invitation } = await createInvitation(
        manager.id,
        organization.id,
        {
          email: `already-revoked-${randomUUID()}@example.com`,
          roleCode: "member",
          managerMembershipId: managerMembership.id,
        },
      );

      // Revoke the invitation directly to establish its initial state.
      const revokedAt = new Date();

      await prisma.invitation.update({
        where: { id: invitation.id },
        data: { revokedAt },
      });

      await expect(
        revokeInvitation(manager.id, organization.id, invitation.id),
      ).rejects.toMatchObject({
        code: "INVALID_INVITATION_STATE",
      });

      const storedInvitation = await prisma.invitation.findUniqueOrThrow({
        where: { id: invitation.id },
      });

      expect(storedInvitation.revokedAt).toEqual(revokedAt);

      const auditLogs = await prisma.auditLog.findMany({
        where: {
          organizationId: organization.id,
          action: "invitation.revoked",
          targetType: "invitation",
          targetId: invitation.id,
        },
      });

      // The failed attempt must not create a success audit log.
      expect(auditLogs).toHaveLength(0);
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

  test("rejects revoking an invitation that has already been accepted", async () => {
    const manager = await createTestUser();
    const organization = await createTestOrganization();

    try {
      const managerMembership = await createMembership(
        manager.id,
        organization.id,
        "manager",
      );

      const { invitation } = await createInvitation(
        manager.id,
        organization.id,
        {
          email: `accepted-${randomUUID()}@example.com`,
          roleCode: "member",
          managerMembershipId: managerMembership.id,
        },
      );

      const acceptedAt = new Date();

      await prisma.invitation.update({
        where: { id: invitation.id },
        data: { acceptedAt },
      });

      await expect(
        revokeInvitation(manager.id, organization.id, invitation.id),
      ).rejects.toMatchObject({
        code: "INVALID_INVITATION_STATE",
      });

      const storedInvitation = await prisma.invitation.findUniqueOrThrow({
        where: { id: invitation.id },
      });

      expect(storedInvitation.acceptedAt).toEqual(acceptedAt);
      expect(storedInvitation.revokedAt).toBeNull();

      const auditLogs = await prisma.auditLog.findMany({
        where: {
          organizationId: organization.id,
          action: "invitation.revoked",
          targetType: "invitation",
          targetId: invitation.id,
        },
      });

      expect(auditLogs).toHaveLength(0);
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

  test("rejects revoking an expired invitation", async () => {
    const manager = await createTestUser();
    const organization = await createTestOrganization();

    try {
      const managerMembership = await createMembership(
        manager.id,
        organization.id,
        "manager",
      );

      const { invitation } = await createInvitation(
        manager.id,
        organization.id,
        {
          email: `expired-${randomUUID()}@example.com`,
          roleCode: "member",
          managerMembershipId: managerMembership.id,
        },
      );

      const expiredAt = new Date(Date.now() - 60_000);

      await prisma.invitation.update({
        where: { id: invitation.id },
        data: { expiresAt: expiredAt },
      });

      await expect(
        revokeInvitation(manager.id, organization.id, invitation.id),
      ).rejects.toMatchObject({
        code: "INVALID_INVITATION_STATE",
      });

      const storedInvitation = await prisma.invitation.findUniqueOrThrow({
        where: { id: invitation.id },
      });

      expect(storedInvitation.expiresAt).toEqual(expiredAt);
      expect(storedInvitation.revokedAt).toBeNull();

      const auditLogs = await prisma.auditLog.findMany({
        where: {
          organizationId: organization.id,
          action: "invitation.revoked",
          targetType: "invitation",
          targetId: invitation.id,
        },
      });

      expect(auditLogs).toHaveLength(0);
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

  test("rejects a Member attempting to revoke an invitation", async () => {
    const manager = await createTestUser();
    const member = await createTestUser();
    const organization = await createTestOrganization();

    try {
      const managerMembership = await createMembership(
        manager.id,
        organization.id,
        "manager",
      );

      await createMembership(member.id, organization.id, "member");

      const { invitation } = await createInvitation(
        manager.id,
        organization.id,
        {
          email: `member-revoke-${randomUUID()}@example.com`,
          roleCode: "member",
          managerMembershipId: managerMembership.id,
        },
      );

      await expect(
        revokeInvitation(member.id, organization.id, invitation.id),
      ).rejects.toThrow();

      const storedInvitation = await prisma.invitation.findUniqueOrThrow({
        where: { id: invitation.id },
      });

      expect(storedInvitation.revokedAt).toBeNull();
    } finally {
      await cleanupInvitationTestData(
        [organization.id],
        [manager.id, member.id],
      );
    }
  });

  test("rejects an Admin revoking an invitation outside their scope", async () => {
    const adminA = await createTestUser();
    const adminB = await createTestUser();
    const manager = await createTestUser();
    const organization = await createTestOrganization();

    try {
      const adminAMembership = await createMembership(
        adminA.id,
        organization.id,
        "admin",
      );

      const adminBMembership = await createMembership(
        adminB.id,
        organization.id,
        "admin",
      );

      const managerMembership = await createMembership(
        manager.id,
        organization.id,
        "manager",
        { adminMembershipId: adminBMembership.id },
      );

      const { invitation } = await createInvitation(
        manager.id,
        organization.id,
        {
          email: `out-of-scope-${randomUUID()}@example.com`,
          roleCode: "member",
          managerMembershipId: managerMembership.id,
        },
      );

      await expect(
        revokeInvitation(adminA.id, organization.id, invitation.id),
      ).rejects.toThrow();

      const storedInvitation = await prisma.invitation.findUniqueOrThrow({
        where: { id: invitation.id },
      });

      expect(storedInvitation.revokedAt).toBeNull();

      // Keep the variable meaningful: Admin A must not own Admin B's scope.
      expect(adminAMembership.id).not.toBe(adminBMembership.id);
    } finally {
      await cleanupInvitationTestData(
        [organization.id],
        [adminA.id, adminB.id, manager.id],
      );
    }
  });

  test("rejects a Manager revoking an invitation created by another Manager", async () => {
    const managerA = await createTestUser();
    const managerB = await createTestUser();
    const organization = await createTestOrganization();

    try {
      const managerAMembership = await createMembership(
        managerA.id,
        organization.id,
        "manager",
      );

      await createMembership(managerB.id, organization.id, "manager");

      const { invitation } = await createInvitation(
        managerA.id,
        organization.id,
        {
          email: `other-manager-${randomUUID()}@example.com`,
          roleCode: "member",
          managerMembershipId: managerAMembership.id,
        },
      );

      await expect(
        revokeInvitation(managerB.id, organization.id, invitation.id),
      ).rejects.toThrow();

      const storedInvitation = await prisma.invitation.findUniqueOrThrow({
        where: { id: invitation.id },
      });

      expect(storedInvitation.revokedAt).toBeNull();
    } finally {
      await cleanupInvitationTestData(
        [organization.id],
        [managerA.id, managerB.id],
      );
    }
  });

  test("treats an invitation from another organization as not found", async () => {
    const managerA = await createTestUser();
    const managerB = await createTestUser();
    const organizationA = await createTestOrganization();
    const organizationB = await createTestOrganization();

    try {
      await createMembership(managerA.id, organizationA.id, "manager");

      const managerBMembership = await createMembership(
        managerB.id,
        organizationB.id,
        "manager",
      );

      const { invitation } = await createInvitation(
        managerB.id,
        organizationB.id,
        {
          email: `cross-org-${randomUUID()}@example.com`,
          roleCode: "member",
          managerMembershipId: managerBMembership.id,
        },
      );

      await expect(
        revokeInvitation(managerA.id, organizationA.id, invitation.id),
      ).rejects.toThrow("Invitation not found");

      const storedInvitation = await prisma.invitation.findUniqueOrThrow({
        where: { id: invitation.id },
      });

      expect(storedInvitation.revokedAt).toBeNull();
    } finally {
      await cleanupInvitationTestData(
        [organizationA.id, organizationB.id],
        [managerA.id, managerB.id],
      );
    }
  });

  test("rejects an invitation that has already been accepted", async () => {
    const manager = await createTestUser();
    const invitee = await createTestUser();
    const organization = await createTestOrganization();

    try {
      const managerMembership = await createMembership(
        manager.id,
        organization.id,
        "manager",
      );

      const invitedEmail = `accepted-${randomUUID()}@example.com`;

      await prisma.user.update({
        where: { id: invitee.id },
        data: {
          email: invitedEmail,
          emailVerifiedAt: new Date(),
        },
      });

      const { invitation, token } = await createInvitation(
        manager.id,
        organization.id,
        {
          email: invitedEmail,
          roleCode: "member",
          managerMembershipId: managerMembership.id,
        },
      );

      // Simulate an invitation that has already been accepted.
      const acceptedAt = new Date();

      await prisma.invitation.update({
        where: { id: invitation.id },
        data: { acceptedAt },
      });

      await expect(
        acceptInvitation(invitee.id, token, prisma),
      ).rejects.toMatchObject({
        code: "INVALID_INVITATION_STATE",
      });

      const storedInvitation = await prisma.invitation.findUniqueOrThrow({
        where: { id: invitation.id },
      });

      expect(storedInvitation.acceptedAt).toEqual(acceptedAt);

      // The rejected attempt must not create a membership.
      const membership = await prisma.membership.findUnique({
        where: {
          userId_organizationId: {
            userId: invitee.id,
            organizationId: organization.id,
          },
        },
      });

      expect(membership).toBeNull();

      // The rejected attempt must not create an acceptance audit event.
      const auditLogs = await prisma.auditLog.findMany({
        where: {
          organizationId: organization.id,
          action: "invitation.accepted",
          targetType: "invitation",
          targetId: invitation.id,
        },
      });

      expect(auditLogs).toHaveLength(0);
    } finally {
      await cleanupInvitationTestData(
        [organization.id],
        [manager.id, invitee.id],
      );
    }
  });

  test("rejects an invitee whose email is not verified", async () => {
    const manager = await createTestUser();
    const invitee = await createTestUser();
    const organization = await createTestOrganization();

    try {
      const managerMembership = await createMembership(
        manager.id,
        organization.id,
        "manager",
      );

      const invitedEmail = `unverified-${randomUUID()}@example.com`;

      await prisma.user.update({
        where: { id: invitee.id },
        data: {
          email: invitedEmail,
          emailVerifiedAt: null,
        },
      });

      const { invitation, token } = await createInvitation(
        manager.id,
        organization.id,
        {
          email: invitedEmail,
          roleCode: "member",
          managerMembershipId: managerMembership.id,
        },
      );

      await expect(
        acceptInvitation(invitee.id, token, prisma),
      ).rejects.toMatchObject({
        code: "EMAIL_NOT_VERIFIED",
      });

      const storedInvitation = await prisma.invitation.findUniqueOrThrow({
        where: { id: invitation.id },
      });

      expect(storedInvitation.acceptedAt).toBeNull();

      const membership = await prisma.membership.findFirst({
        where: {
          organizationId: organization.id,
          userId: invitee.id,
        },
      });

      expect(membership).toBeNull();
    } finally {
      await cleanupInvitationTestData(
        [organization.id],
        [manager.id, invitee.id],
      );
    }
  });

  test("rejects a verified user whose email does not match the invitation", async () => {
    const manager = await createTestUser();
    const invitee = await createTestUser();
    await prisma.user.update({
      where: { id: invitee.id },
      data: { emailVerifiedAt: new Date() },
    });
    const organization = await createTestOrganization();

    try {
      const managerMembership = await createMembership(
        manager.id,
        organization.id,
        "manager",
      );

      const { invitation, token } = await createInvitation(
        manager.id,
        organization.id,
        {
          email: `invited-${randomUUID()}@example.com`,
          roleCode: "member",
          managerMembershipId: managerMembership.id,
        },
      );

      await expect(
        acceptInvitation(invitee.id, token, prisma),
      ).rejects.toMatchObject({
        code: "EMAIL_MISMATCH",
      });

      const storedInvitation = await prisma.invitation.findUniqueOrThrow({
        where: { id: invitation.id },
      });

      expect(storedInvitation.acceptedAt).toBeNull();

      const membership = await prisma.membership.findFirst({
        where: {
          organizationId: organization.id,
          userId: invitee.id,
        },
      });

      expect(membership).toBeNull();
    } finally {
      await cleanupInvitationTestData(
        [organization.id],
        [manager.id, invitee.id],
      );
    }
  });

  test("rejects an invalid invitation token without changing state", async () => {
    const manager = await createTestUser();
    const invitee = await createTestUser();
    const organization = await createTestOrganization();

    try {
      const managerMembership = await createMembership(
        manager.id,
        organization.id,
        "manager",
      );

      const invitedEmail = `invalid-token-${randomUUID()}@example.com`;

      await prisma.user.update({
        where: { id: invitee.id },
        data: {
          email: invitedEmail,
          emailVerifiedAt: new Date(),
        },
      });

      const { invitation } = await createInvitation(
        manager.id,
        organization.id,
        {
          email: invitedEmail,
          roleCode: "member",
          managerMembershipId: managerMembership.id,
        },
      );

      await expect(
        acceptInvitation(invitee.id, randomUUID(), prisma),
      ).rejects.toMatchObject({
        code: "INVITATION_NOT_FOUND",
      });

      const storedInvitation = await prisma.invitation.findUniqueOrThrow({
        where: { id: invitation.id },
      });

      expect(storedInvitation.acceptedAt).toBeNull();

      const memberships = await prisma.membership.findMany({
        where: {
          organizationId: organization.id,
          userId: invitee.id,
        },
      });

      expect(memberships).toHaveLength(0);

      const acceptanceAuditLogs = await prisma.auditLog.findMany({
        where: {
          organizationId: organization.id,
          action: "invitation.accepted",
          targetId: invitation.id,
        },
      });

      expect(acceptanceAuditLogs).toHaveLength(0);
    } finally {
      await cleanupInvitationTestData(
        [organization.id],
        [manager.id, invitee.id],
      );
    }
  });

  test("rejects an expired invitation", async () => {
    const manager = await createTestUser();
    const invitee = await createTestUser();
    const organization = await createTestOrganization();

    try {
      const managerMembership = await createMembership(
        manager.id,
        organization.id,
        "manager",
      );

      const invitedEmail = `expired-accept-${randomUUID()}@example.com`;

      await prisma.user.update({
        where: { id: invitee.id },
        data: {
          email: invitedEmail,
          emailVerifiedAt: new Date(),
        },
      });

      const { invitation, token } = await createInvitation(
        manager.id,
        organization.id,
        {
          email: invitedEmail,
          roleCode: "member",
          managerMembershipId: managerMembership.id,
        },
      );

      await prisma.invitation.update({
        where: { id: invitation.id },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      await expect(
        acceptInvitation(invitee.id, token, prisma),
      ).rejects.toMatchObject({
        code: "INVALID_INVITATION_STATE",
      });

      const storedInvitation = await prisma.invitation.findUniqueOrThrow({
        where: { id: invitation.id },
      });

      expect(storedInvitation.acceptedAt).toBeNull();

      const membership = await prisma.membership.findFirst({
        where: {
          organizationId: organization.id,
          userId: invitee.id,
        },
      });

      expect(membership).toBeNull();
    } finally {
      await cleanupInvitationTestData(
        [organization.id],
        [manager.id, invitee.id],
      );
    }
  });

  test("rejects a revoked invitation", async () => {
    const manager = await createTestUser();
    const invitee = await createTestUser();
    const organization = await createTestOrganization();

    try {
      const managerMembership = await createMembership(
        manager.id,
        organization.id,
        "manager",
      );

      const invitedEmail = `revoked-accept-${randomUUID()}@example.com`;

      await prisma.user.update({
        where: { id: invitee.id },
        data: {
          email: invitedEmail,
          emailVerifiedAt: new Date(),
        },
      });

      const { invitation, token } = await createInvitation(
        manager.id,
        organization.id,
        {
          email: invitedEmail,
          roleCode: "member",
          managerMembershipId: managerMembership.id,
        },
      );

      await prisma.invitation.update({
        where: { id: invitation.id },
        data: { revokedAt: new Date() },
      });

      await expect(
        acceptInvitation(invitee.id, token, prisma),
      ).rejects.toMatchObject({
        code: "INVALID_INVITATION_STATE",
      });

      const storedInvitation = await prisma.invitation.findUniqueOrThrow({
        where: { id: invitation.id },
      });

      expect(storedInvitation.acceptedAt).toBeNull();

      const membership = await prisma.membership.findFirst({
        where: {
          organizationId: organization.id,
          userId: invitee.id,
        },
      });

      expect(membership).toBeNull();
    } finally {
      await cleanupInvitationTestData(
        [organization.id],
        [manager.id, invitee.id],
      );
    }
  });

  test("closes an invitation when the invitee is already a member", async () => {
    const manager = await createTestUser();
    const invitee = await createTestUser();
    const organization = await createTestOrganization();

    try {
      const managerMembership = await createMembership(
        manager.id,
        organization.id,
        "manager",
      );

      const invitedEmail = `existing-member-${randomUUID()}@example.com`;

      await prisma.user.update({
        where: { id: invitee.id },
        data: {
          email: invitedEmail,
          emailVerifiedAt: new Date(),
        },
      });

      const existingMembership = await createMembership(
        invitee.id,
        organization.id,
        "member",
        { managerMembershipId: managerMembership.id },
      );

      const { invitation, token } = await createInvitation(
        manager.id,
        organization.id,
        {
          email: invitedEmail,
          roleCode: "member",
          managerMembershipId: managerMembership.id,
        },
      );

      await expect(
        acceptInvitation(invitee.id, token, prisma),
      ).rejects.toMatchObject({
        code: "ALREADY_MEMBER",
      });

      const storedInvitation = await prisma.invitation.findUniqueOrThrow({
        where: { id: invitation.id },
      });

      expect(storedInvitation.acceptedAt).toBeNull();
      expect(storedInvitation.revokedAt).toBeInstanceOf(Date);

      const memberships = await prisma.membership.findMany({
        where: {
          userId: invitee.id,
          organizationId: organization.id,
        },
      });

      expect(memberships).toHaveLength(1);
      expect(memberships[0]).toMatchObject({
        id: existingMembership.id,
        roleId: existingMembership.roleId,
        adminMembershipId: existingMembership.adminMembershipId,
        managerMembershipId: existingMembership.managerMembershipId,
      });

      const auditLogs = await prisma.auditLog.findMany({
        where: {
          organizationId: organization.id,
          action: "invitation.closed",
          targetType: "invitation",
          targetId: invitation.id,
        },
      });

      expect(auditLogs).toHaveLength(1);
      expect(auditLogs[0]).toMatchObject({
        action: "invitation.closed",
        result: "success",
        actorUserId: invitee.id,
        actorMembershipId: existingMembership.id,
        metadata: { reason: "already_member" },
      });
    } finally {
      await cleanupInvitationTestData(
        [organization.id],
        [manager.id, invitee.id],
      );
    }
  });

  test("allows only one concurrent acceptance of the same invitation", async () => {
    const manager = await createTestUser();
    const invitee = await createTestUser();
    const organization = await createTestOrganization();

    try {
      const managerMembership = await createMembership(
        manager.id,
        organization.id,
        "manager",
      );

      const invitedEmail = `concurrent-accept-${randomUUID()}@example.com`;

      await prisma.user.update({
        where: { id: invitee.id },
        data: {
          email: invitedEmail,
          emailVerifiedAt: new Date(),
        },
      });

      const { invitation, token } = await createInvitation(
        manager.id,
        organization.id,
        {
          email: invitedEmail,
          roleCode: "member",
          managerMembershipId: managerMembership.id,
        },
      );

      const results = await Promise.allSettled([
        acceptInvitation(invitee.id, token, prisma),
        acceptInvitation(invitee.id, token, prisma),
      ]);

      const fulfilled = results.filter(
        (result) => result.status === "fulfilled",
      );
      const rejected = results.filter((result) => result.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const storedInvitation = await prisma.invitation.findUniqueOrThrow({
        where: { id: invitation.id },
      });

      expect(storedInvitation.acceptedAt).toBeInstanceOf(Date);

      const memberships = await prisma.membership.findMany({
        where: {
          userId: invitee.id,
          organizationId: organization.id,
        },
      });

      expect(memberships).toHaveLength(1);
      expect(memberships[0]?.managerMembershipId).toBe(managerMembership.id);

      const auditLogs = await prisma.auditLog.findMany({
        where: {
          organizationId: organization.id,
          action: "invitation.accepted",
          targetType: "invitation",
          targetId: invitation.id,
        },
      });

      expect(auditLogs).toHaveLength(1);
    } finally {
      await cleanupInvitationTestData(
        [organization.id],
        [manager.id, invitee.id],
      );
    }
  });

  test("rolls back invitation acceptance if audit logging fails", async () => {
    const manager = await createTestUser();
    const invitee = await createTestUser();
    const organization = await createTestOrganization();
    const triggerName = `test_acceptance_audit_failure_${randomUUID().replaceAll("-", "")}`;
    const functionName = `${triggerName}_fn`;

    try {
      const managerMembership = await createMembership(
        manager.id,
        organization.id,
        "manager",
      );

      const invitedEmail = `rollback-accept-${randomUUID()}@example.com`;

      await prisma.user.update({
        where: { id: invitee.id },
        data: {
          email: invitedEmail,
          emailVerifiedAt: new Date(),
        },
      });

      const { invitation, token } = await createInvitation(
        manager.id,
        organization.id,
        {
          email: invitedEmail,
          roleCode: "member",
          managerMembershipId: managerMembership.id,
        },
      );

      await prisma.$executeRawUnsafe(`
        CREATE FUNCTION ${functionName}() RETURNS trigger AS $$
        BEGIN
          IF NEW.action = 'invitation.accepted' THEN
            RAISE EXCEPTION 'forced invitation acceptance audit failure';
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

      await expect(acceptInvitation(invitee.id, token, prisma)).rejects.toThrow(
        "forced invitation acceptance audit failure",
      );

      const storedInvitation = await prisma.invitation.findUniqueOrThrow({
        where: { id: invitation.id },
      });

      expect(storedInvitation.acceptedAt).toBeNull();

      const membership = await prisma.membership.findUnique({
        where: {
          userId_organizationId: {
            userId: invitee.id,
            organizationId: organization.id,
          },
        },
      });

      expect(membership).toBeNull();
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS ${triggerName} ON audit_logs`,
      );
      await prisma.$executeRawUnsafe(
        `DROP FUNCTION IF EXISTS ${functionName}()`,
      );

      await cleanupInvitationTestData(
        [organization.id],
        [manager.id, invitee.id],
      );
    }
  });

  test("preserves the invited Manager's Admin assignment on acceptance", async () => {
    const admin = await createTestUser();
    const invitee = await createTestUser();
    const organization = await createTestOrganization();

    try {
      const adminMembership = await createMembership(
        admin.id,
        organization.id,
        "admin",
      );

      const invitedEmail = `accept-manager-${randomUUID()}@example.com`;

      await prisma.user.update({
        where: { id: invitee.id },
        data: {
          email: invitedEmail,
          emailVerifiedAt: new Date(),
        },
      });

      const { invitation, token } = await createInvitation(
        admin.id,
        organization.id,
        {
          email: invitedEmail,
          roleCode: "manager",
          adminMembershipId: adminMembership.id,
        },
      );

      const result = await acceptInvitation(invitee.id, token, prisma);

      expect(result).toMatchObject({
        invitationId: invitation.id,
        status: "accepted",
        membership: {
          organizationId: organization.id,
          userId: invitee.id,
          roleId: invitation.roleId,
          adminMembershipId: adminMembership.id,
          managerMembershipId: null,
        },
      });

      const membership = await prisma.membership.findUniqueOrThrow({
        where: {
          userId_organizationId: {
            userId: invitee.id,
            organizationId: organization.id,
          },
        },
        include: { role: true },
      });

      expect(membership.role.code).toBe("manager");
      expect(membership.adminMembershipId).toBe(adminMembership.id);
      expect(membership.managerMembershipId).toBeNull();
    } finally {
      await cleanupInvitationTestData(
        [organization.id],
        [admin.id, invitee.id],
      );
    }
  });

  test("accepts an Admin invitation without reporting assignments", async () => {
    const superUser = await createTestUser();
    const invitee = await createTestUser();
    const organization = await createTestOrganization();

    try {
      await createMembership(superUser.id, organization.id, "super_user");

      const invitedEmail = `accept-admin-${randomUUID()}@example.com`;

      await prisma.user.update({
        where: { id: invitee.id },
        data: {
          email: invitedEmail,
          emailVerifiedAt: new Date(),
        },
      });

      const { invitation, token } = await createInvitation(
        superUser.id,
        organization.id,
        {
          email: invitedEmail,
          roleCode: "admin",
        },
      );

      const result = await acceptInvitation(invitee.id, token, prisma);

      expect(result).toMatchObject({
        invitationId: invitation.id,
        status: "accepted",
        membership: {
          organizationId: organization.id,
          userId: invitee.id,
          roleId: invitation.roleId,
          adminMembershipId: null,
          managerMembershipId: null,
        },
      });

      const membership = await prisma.membership.findUniqueOrThrow({
        where: {
          userId_organizationId: {
            userId: invitee.id,
            organizationId: organization.id,
          },
        },
        include: { role: true },
      });

      expect(membership.role.code).toBe("admin");
      expect(membership.adminMembershipId).toBeNull();
      expect(membership.managerMembershipId).toBeNull();
    } finally {
      await cleanupInvitationTestData(
        [organization.id],
        [superUser.id, invitee.id],
      );
    }
  });
});
