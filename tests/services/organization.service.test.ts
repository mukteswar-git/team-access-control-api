import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "@jest/globals";
import {
  testPrisma as prisma,
  disconnectTestDatabase,
  testPrisma,
} from "../helpers/database.js";
import {
  createOrganizationForUser,
  getOrganizationForUser,
  transferOrganizationOwnership,
} from "../../src/services/organization.service.js";

const rollbackTriggerName = "test_fail_organization_created_audit";
const rollbackFunctionName = "test_fail_organization_created_audit_fn";

describe("Organization service", () => {
  afterAll(async () => {
    await disconnectTestDatabase();
  });

  async function createTestUser(verified = true) {
    return prisma.user.create({
      data: {
        email: `organization-service-${randomUUID()}@example.com`,
        passwordHash: "test-hash",
        emailVerifiedAt: verified ? new Date() : null,
      },
    });
  }

  async function cleanupOrganization(organizationId: string) {
    await testPrisma.$executeRaw`
      ALTER TABLE "audit_logs" DISABLE TRIGGER "audit_logs_append_only"
    `;

    try {
      await testPrisma.auditLog.deleteMany({
        where: { organizationId },
      });
    } finally {
      await testPrisma.$executeRaw`
        ALTER TABLE "audit_logs" ENABLE TRIGGER "audit_logs_append_only"
      `;
    }

    await testPrisma.membership.deleteMany({
      where: { organizationId },
    });

    await testPrisma.organization.deleteMany({
      where: { id: organizationId },
    });
  }

  async function createTestMembership(
    userId: string,
    organizationId: string,
    roleCode: string,
    reporting: {
      adminMembershipId?: string | null;
      managerMembershipId?: string | null;
    } = {},
  ) {
    const role = await prisma.role.findUniqueOrThrow({
      where: { code: roleCode },
    });

    return prisma.membership.create({
      data: {
        userId,
        organizationId,
        roleId: role.id,
        ...reporting,
      },
    });
  }

  test("creates an organization with its initial Super User membership and audit event", async () => {
    const user = await createTestUser();
    const name = `Organization ${randomUUID()}`;
    let organizationId: string | undefined;

    try {
      const organization = await createOrganizationForUser(
        user.id,
        { name },
        prisma,
      );
      organizationId = organization.id;

      const membership = await prisma.membership.findUnique({
        where: {
          userId_organizationId: {
            userId: user.id,
            organizationId: organization.id,
          },
        },
        include: { role: true },
      });
      const auditLog = await prisma.auditLog.findFirst({
        where: {
          organizationId: organization.id,
          action: "organization.created",
          targetId: organization.id,
        },
      });

      expect(organization.name).toBe(name);
      expect(membership?.role.code).toBe("super_user");
      expect(auditLog).toMatchObject({
        organizationId: organization.id,
        actorUserId: user.id,
        actorMembershipId: membership?.id,
        action: "organization.created",
        result: "success",
        targetType: "organization",
        targetId: organization.id,
      });
    } finally {
      if (organizationId) await cleanupOrganization(organizationId);
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("rejects an empty organization name", async () => {
    const user = await createTestUser();

    try {
      await expect(
        createOrganizationForUser(user.id, { name: "   " }, prisma),
      ).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("rejects an unverified user", async () => {
    const user = await createTestUser(false);

    try {
      await expect(
        createOrganizationForUser(
          user.id,
          { name: `Organization ${randomUUID()}` },
          prisma,
        ),
      ).rejects.toMatchObject({ code: "EMAIL_NOT_VERIFIED" });

      expect(
        await prisma.membership.count({ where: { userId: user.id } }),
      ).toBe(0);
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("does not disclose an organization to a non-member", async () => {
    const owner = await createTestUser();
    const otherUser = await createTestUser();
    let organizationId: string | undefined;

    try {
      const organization = await createOrganizationForUser(
        owner.id,
        { name: `Organization ${randomUUID()}` },
        prisma,
      );
      organizationId = organization.id;

      await expect(
        getOrganizationForUser(otherUser.id, organization.id, prisma),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      if (organizationId) await cleanupOrganization(organizationId);
      await prisma.user.deleteMany({
        where: { id: { in: [owner.id, otherUser.id] } },
      });
    }
  });

  test("allows an organization member with organization.read to retrieve it", async () => {
    const owner = await createTestUser();
    let organizationId: string | undefined;

    try {
      const created = await createOrganizationForUser(
        owner.id,
        { name: `Organization ${randomUUID()}` },
        prisma,
      );
      organizationId = created.id;

      const result = await getOrganizationForUser(owner.id, created.id, prisma);

      expect(result).toMatchObject({ id: created.id, name: created.name });
    } finally {
      if (organizationId) await cleanupOrganization(organizationId);
      await prisma.user.delete({ where: { id: owner.id } });
    }
  });

  test("rolls back organization and membership if audit logging fails", async () => {
    const user = await createTestUser();
    const name = `Rollback organization ${randomUUID()}`;

    try {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS ${rollbackTriggerName} ON audit_logs`,
      );
      await prisma.$executeRawUnsafe(
        `DROP FUNCTION IF EXISTS ${rollbackFunctionName}()`,
      );
      await prisma.$executeRawUnsafe(`
        CREATE FUNCTION ${rollbackFunctionName}() RETURNS trigger AS $$
        BEGIN
          IF NEW.action = 'organization.created' THEN
            RAISE EXCEPTION 'forced organization audit failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `);
      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER ${rollbackTriggerName}
        BEFORE INSERT ON audit_logs
        FOR EACH ROW EXECUTE FUNCTION ${rollbackFunctionName}()
      `);

      await expect(
        createOrganizationForUser(user.id, { name }, prisma),
      ).rejects.toThrow("forced organization audit failure");

      expect(await prisma.organization.count({ where: { name } })).toBe(0);
      expect(
        await prisma.membership.count({ where: { userId: user.id } }),
      ).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS ${rollbackTriggerName} ON audit_logs`,
      );
      await prisma.$executeRawUnsafe(
        `DROP FUNCTION IF EXISTS ${rollbackFunctionName}()`,
      );
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("transfers ownership and records an audit event", async () => {
    const previousOwner = await createTestUser();
    const targetUser = await createTestUser();
    const name = `Organization ${randomUUID()}`;
    let organizationId: string | undefined;

    try {
      const organization = await createOrganizationForUser(
        previousOwner.id,
        { name },
        prisma,
      );
      organizationId = organization.id;

      const targetMembership = await prisma.membership.create({
        data: {
          userId: targetUser.id,
          organizationId: organization.id,
          roleId: await (async () => {
            const role = await prisma.role.findUnique({
              where: { code: "member" },
            });
            if (!role) throw new Error('Role "member" not found.');
            return role.id;
          })(),
        },
      });

      const result = await transferOrganizationOwnership(
        previousOwner.id,
        organization.id,
        targetMembership.id,
        prisma,
      );

      const memberships = await prisma.membership.findMany({
        where: { organizationId: organization.id },
        include: { role: true },
      });

      const auditLog = await prisma.auditLog.findFirst({
        where: {
          organizationId: organization.id,
          action: "organization.ownership_transferred",
          targetId: organization.id,
        },
      });

      expect(result).toEqual({
        organizationId: organization.id,
        previousOwnerMembershipId: expect.any(String),
        newOwnerMembershipId: targetMembership.id,
      });

      expect(
        memberships.find((membership) => membership.userId === previousOwner.id)
          ?.role.code,
      ).toBe("admin");

      expect(
        memberships.find((membership) => membership.userId === targetUser.id)
          ?.role.code,
      ).toBe("super_user");

      expect(
        memberships.filter(
          (membership) => membership.role.code === "super_user",
        ),
      ).toHaveLength(1);

      expect(auditLog).toMatchObject({
        organizationId: organization.id,
        actorUserId: previousOwner.id,
        actorMembershipId: result.previousOwnerMembershipId,
        action: "organization.ownership_transferred",
        result: "success",
        targetType: "organization",
        targetId: organization.id,
        metadata: {
          previousOwnerMembershipId: result.previousOwnerMembershipId,
          previousOwnerUserId: previousOwner.id,
          newOwnerMembershipId: targetMembership.id,
          newOwnerUserId: targetUser.id,
        },
      });
    } finally {
      if (organizationId) await cleanupOrganization(organizationId);
      await prisma.user.deleteMany({
        where: { id: { in: [previousOwner.id, targetUser.id] } },
      });
    }
  });

  test("rejects ownership transfer by a non-owner", async () => {
    const owner = await createTestUser();
    const actor = await createTestUser();
    const target = await createTestUser();
    let organizationId: string | undefined;

    try {
      const organization = await createOrganizationForUser(
        owner.id,
        { name: `Organization ${randomUUID()}` },
        prisma,
      );
      organizationId = organization.id;

      const memberRole = await prisma.role.findUniqueOrThrow({
        where: { code: "member" },
      });

      const actorMembership = await prisma.membership.create({
        data: {
          userId: actor.id,
          organizationId: organization.id,
          roleId: memberRole.id,
        },
      });

      const targetMembership = await prisma.membership.create({
        data: {
          userId: target.id,
          organizationId: organization.id,
          roleId: memberRole.id,
        },
      });

      await expect(
        transferOrganizationOwnership(
          actor.id,
          organization.id,
          targetMembership.id,
          prisma,
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      expect(
        await prisma.membership.findUniqueOrThrow({
          where: { id: actorMembership.id },
          include: { role: true },
        }),
      ).toMatchObject({ role: { code: "member" } });

      expect(
        await prisma.membership.findUniqueOrThrow({
          where: {
            userId_organizationId: {
              userId: owner.id,
              organizationId: organization.id,
            },
          },
          include: { role: true },
        }),
      ).toMatchObject({ role: { code: "super_user" } });
    } finally {
      if (organizationId) await cleanupOrganization(organizationId);
      await prisma.user.deleteMany({
        where: { id: { in: [owner.id, actor.id, target.id] } },
      });
    }
  });

  test("rejects a target from another organization", async () => {
    const owner = await createTestUser();
    const otherOwner = await createTestUser();
    let organizationId: string | undefined;
    let otherOrganizationId: string | undefined;

    try {
      const organization = await createOrganizationForUser(
        owner.id,
        { name: `Organization ${randomUUID()}` },
        prisma,
      );
      organizationId = organization.id;

      const otherOrganization = await createOrganizationForUser(
        otherOwner.id,
        { name: `Organization ${randomUUID()}` },
        prisma,
      );
      otherOrganizationId = otherOrganization.id;

      const targetMembership = await prisma.membership.findUniqueOrThrow({
        where: {
          userId_organizationId: {
            userId: otherOwner.id,
            organizationId: otherOrganization.id,
          },
        },
      });

      await expect(
        transferOrganizationOwnership(
          owner.id,
          organization.id,
          targetMembership.id,
          prisma,
        ),
      ).rejects.toMatchObject({
        code: "OWNERSHIP_TRANSFER_TARGET_INVALID",
      });

      expect(
        await prisma.membership.findUniqueOrThrow({
          where: {
            userId_organizationId: {
              userId: owner.id,
              organizationId: organization.id,
            },
          },
          include: { role: true },
        }),
      ).toMatchObject({ role: { code: "super_user" } });
    } finally {
      if (organizationId) await cleanupOrganization(organizationId);
      if (otherOrganizationId) await cleanupOrganization(otherOrganizationId);

      await prisma.user.deleteMany({
        where: { id: { in: [owner.id, otherOwner.id] } },
      });
    }
  });

  test("rejects transferring ownership to the current owner", async () => {
    const owner = await createTestUser();
    let organizationId: string | undefined;

    try {
      const organization = await createOrganizationForUser(
        owner.id,
        { name: `Organization ${randomUUID()}` },
        prisma,
      );
      organizationId = organization.id;

      const ownerMembership = await prisma.membership.findUniqueOrThrow({
        where: {
          userId_organizationId: {
            userId: owner.id,
            organizationId: organization.id,
          },
        },
      });

      await expect(
        transferOrganizationOwnership(
          owner.id,
          organization.id,
          ownerMembership.id,
          prisma,
        ),
      ).rejects.toMatchObject({
        code: "OWNERSHIP_TRANSFER_TARGET_INVALID",
      });

      expect(
        await prisma.membership.findUniqueOrThrow({
          where: { id: ownerMembership.id },
          include: { role: true },
        }),
      ).toMatchObject({ role: { code: "super_user" } });
    } finally {
      if (organizationId) await cleanupOrganization(organizationId);
      await prisma.user.delete({ where: { id: owner.id } });
    }
  });

  test("rolls back ownership transfer if audit logging fails", async () => {
    const owner = await createTestUser();
    const targetUser = await createTestUser();
    const triggerName = "test_fail_ownership_transfer_audit";
    const functionName = "test_fail_ownership_transfer_audit_fn";
    let organizationId: string | undefined;
    let triggerCreated = false;

    try {
      const organization = await createOrganizationForUser(
        owner.id,
        { name: `Organization ${randomUUID()}` },
        prisma,
      );
      organizationId = organization.id;

      const memberRole = await prisma.role.findUniqueOrThrow({
        where: { code: "member" },
      });

      const targetMembership = await prisma.membership.create({
        data: {
          userId: targetUser.id,
          organizationId: organization.id,
          roleId: memberRole.id,
        },
      });

      await testPrisma.$executeRaw`
        CREATE OR REPLACE FUNCTION test_fail_ownership_transfer_audit_fn()
        RETURNS trigger AS $$
        BEGIN
          IF NEW.action = 'organization.ownership_transferred' THEN
            RAISE EXCEPTION 'Simulated ownership-transfer audit failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `;

      await testPrisma.$executeRaw`
        CREATE TRIGGER test_fail_ownership_transfer_audit
        BEFORE INSERT ON "audit_logs"
        FOR EACH ROW
        EXECUTE FUNCTION test_fail_ownership_transfer_audit_fn()
      `;
      triggerCreated = true;

      await expect(
        transferOrganizationOwnership(
          owner.id,
          organization.id,
          targetMembership.id,
          prisma,
        ),
      ).rejects.toThrow("Simulated ownership-transfer audit failure");

      const previousOwnerMembership = await prisma.membership.findUniqueOrThrow(
        {
          where: {
            userId_organizationId: {
              userId: owner.id,
              organizationId: organization.id,
            },
          },
          include: { role: true },
        },
      );

      const unchangedTargetMembership =
        await prisma.membership.findUniqueOrThrow({
          where: { id: targetMembership.id },
          include: { role: true },
        });

      expect(previousOwnerMembership.role.code).toBe("super_user");
      expect(unchangedTargetMembership.role.code).toBe("member");

      expect(
        await prisma.auditLog.findFirst({
          where: {
            organizationId: organization.id,
            action: "organization.ownership_transferred",
          },
        }),
      ).toBeNull();
    } finally {
      if (triggerCreated) {
        await testPrisma.$executeRaw`
          DROP TRIGGER IF EXISTS test_fail_ownership_transfer_audit
          ON "audit_logs"
        `;
      }

      await testPrisma.$executeRaw`
        DROP FUNCTION IF EXISTS test_fail_ownership_transfer_audit_fn()
      `;

      if (organizationId) await cleanupOrganization(organizationId);

      await prisma.user.deleteMany({
        where: { id: { in: [owner.id, targetUser.id] } },
      });
    }
  });

  test("cleans up reporting relationships when transferring ownership to an Admin", async () => {
    const users = await Promise.all(
      Array.from({ length: 7 }, () => createTestUser()),
    );
    const [
      owner,
      targetUser,
      managerUser,
      memberUser,
      unrelatedAdminUser,
      unrelatedManagerUser,
      unrelatedMemberUser,
    ] = users;

    let organizationId: string | undefined;

    try {
      const organization = await createOrganizationForUser(
        owner.id,
        { name: `Organization ${randomUUID()}` },
        prisma,
      );
      organizationId = organization.id;

      const targetAdmin = await createTestMembership(
        targetUser.id,
        organization.id,
        "admin",
      );

      const manager = await createTestMembership(
        managerUser.id,
        organization.id,
        "manager",
        { adminMembershipId: targetAdmin.id },
      );

      const member = await createTestMembership(
        memberUser.id,
        organization.id,
        "member",
        { managerMembershipId: manager.id },
      );

      const unrelatedAdmin = await createTestMembership(
        unrelatedAdminUser.id,
        organization.id,
        "admin",
      );

      const unrelatedManager = await createTestMembership(
        unrelatedManagerUser.id,
        organization.id,
        "manager",
        { adminMembershipId: unrelatedAdmin.id },
      );

      const unrelatedMember = await createTestMembership(
        unrelatedMemberUser.id,
        organization.id,
        "member",
        { managerMembershipId: unrelatedManager.id },
      );

      await transferOrganizationOwnership(
        owner.id,
        organization.id,
        targetAdmin.id,
        prisma,
      );

      const updatedTarget = await prisma.membership.findUniqueOrThrow({
        where: { id: targetAdmin.id },
        include: { role: true },
      });

      const updatedOwner = await prisma.membership.findUniqueOrThrow({
        where: {
          userId_organizationId: {
            userId: owner.id,
            organizationId: organization.id,
          },
        },
        include: { role: true },
      });

      const updatedManager = await prisma.membership.findUniqueOrThrow({
        where: { id: manager.id },
      });

      const updatedMember = await prisma.membership.findUniqueOrThrow({
        where: { id: member.id },
      });

      const updatedUnrelatedManager = await prisma.membership.findUniqueOrThrow(
        {
          where: { id: unrelatedManager.id },
        },
      );

      const updatedUnrelatedMember = await prisma.membership.findUniqueOrThrow({
        where: { id: unrelatedMember.id },
      });

      expect(updatedTarget.role.code).toBe("super_user");
      expect(updatedTarget.adminMembershipId).toBeNull();
      expect(updatedTarget.managerMembershipId).toBeNull();
      expect(updatedOwner.role.code).toBe("admin");

      // The Manager can no longer report to the new Super User.
      expect(updatedManager.adminMembershipId).toBeNull();

      // The Member's valid assignment to that Manager is preserved.
      expect(updatedMember.managerMembershipId).toBe(manager.id);

      // Unrelated reporting relationships are unchanged.
      expect(updatedUnrelatedManager.adminMembershipId).toBe(unrelatedAdmin.id);
      expect(updatedUnrelatedMember.managerMembershipId).toBe(
        unrelatedManager.id,
      );
    } finally {
      if (organizationId) await cleanupOrganization(organizationId);
      await prisma.user.deleteMany({
        where: { id: { in: users.map((user) => user.id) } },
      });
    }
  });

  test("cleans up reporting relationships when transferring ownership to a Manager", async () => {
    const users = await Promise.all(
      Array.from({ length: 7 }, () => createTestUser()),
    );
    const [
      owner,
      targetUser,
      adminUser,
      memberUser,
      unrelatedAdminUser,
      unrelatedManagerUser,
      unrelatedMemberUser,
    ] = users;

    let organizationId: string | undefined;

    try {
      const organization = await createOrganizationForUser(
        owner.id,
        { name: `Organization ${randomUUID()}` },
        prisma,
      );
      organizationId = organization.id;

      const admin = await createTestMembership(
        adminUser.id,
        organization.id,
        "admin",
      );

      const targetManager = await createTestMembership(
        targetUser.id,
        organization.id,
        "manager",
        { adminMembershipId: admin.id },
      );

      const member = await createTestMembership(
        memberUser.id,
        organization.id,
        "member",
        { managerMembershipId: targetManager.id },
      );

      const unrelatedAdmin = await createTestMembership(
        unrelatedAdminUser.id,
        organization.id,
        "admin",
      );

      const unrelatedManager = await createTestMembership(
        unrelatedManagerUser.id,
        organization.id,
        "manager",
        { adminMembershipId: unrelatedAdmin.id },
      );

      const unrelatedMember = await createTestMembership(
        unrelatedMemberUser.id,
        organization.id,
        "member",
        { managerMembershipId: unrelatedManager.id },
      );

      await transferOrganizationOwnership(
        owner.id,
        organization.id,
        targetManager.id,
        prisma,
      );

      const updatedTarget = await prisma.membership.findUniqueOrThrow({
        where: { id: targetManager.id },
        include: { role: true },
      });

      const updatedMember = await prisma.membership.findUniqueOrThrow({
        where: { id: member.id },
      });

      const updatedAdmin = await prisma.membership.findUniqueOrThrow({
        where: { id: admin.id },
        include: { role: true },
      });

      const updatedUnrelatedManager = await prisma.membership.findUniqueOrThrow(
        {
          where: { id: unrelatedManager.id },
        },
      );

      const updatedUnrelatedMember = await prisma.membership.findUniqueOrThrow({
        where: { id: unrelatedMember.id },
      });

      expect(updatedTarget.role.code).toBe("super_user");
      expect(updatedTarget.adminMembershipId).toBeNull();
      expect(updatedTarget.managerMembershipId).toBeNull();

      // Members can no longer report to the new Super User.
      expect(updatedMember.managerMembershipId).toBeNull();

      // The former Admin and unrelated reporting chain remain valid.
      expect(updatedAdmin.role.code).toBe("admin");
      expect(updatedUnrelatedManager.adminMembershipId).toBe(unrelatedAdmin.id);
      expect(updatedUnrelatedMember.managerMembershipId).toBe(
        unrelatedManager.id,
      );
    } finally {
      if (organizationId) await cleanupOrganization(organizationId);
      await prisma.user.deleteMany({
        where: { id: { in: users.map((user) => user.id) } },
      });
    }
  });
});
