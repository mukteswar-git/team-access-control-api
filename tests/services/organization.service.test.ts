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
});
