import { afterAll, describe, expect, test } from "@jest/globals";
import request from "supertest";
import argon2 from "argon2";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  testPrisma as prisma,
  disconnectTestDatabase,
} from "../../helpers/database.js";

const { default: app } = await import("../../../src/app.js");

async function createAuthenticatedUser() {
  const email = `invitation-test-${randomUUID()}@example.com`;
  const sessionToken = randomBytes(32).toString("hex");

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await argon2.hash("Strong-test-password-123", {
        type: argon2.argon2id,
      }),
      emailVerifiedAt: new Date(),
    },
  });

  try {
    await prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: createHash("sha256").update(sessionToken).digest("hex"),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
  } catch (error) {
    await prisma.user.delete({ where: { id: user.id } });
    throw error;
  }

  return { user, sessionToken };
}

async function createOrganization(name: string, ownerId: string) {
  const organization = await prisma.organization.create({
    data: { name },
  });

  const role = await prisma.role.findUniqueOrThrow({
    where: { code: "super_user" },
  });

  await prisma.membership.create({
    data: {
      organizationId: organization.id,
      userId: ownerId,
      roleId: role.id,
    },
  });

  return organization;
}

async function createMembership(
  organizationId: string,
  userId: string,
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
      organizationId,
      userId,
      roleId: role.id,
      ...reporting,
    },
  });
}

async function cleanupOrganization(organizationId: string) {
  await prisma.invitation.deleteMany({ where: { organizationId } });

  await prisma.$executeRaw`
    ALTER TABLE "audit_logs" DISABLE TRIGGER "audit_logs_append_only"
  `;

  try {
    await prisma.auditLog.deleteMany({ where: { organizationId } });
  } finally {
    await prisma.$executeRaw`
      ALTER TABLE "audit_logs" ENABLE TRIGGER "audit_logs_append_only"
    `;
  }

  await prisma.membership.deleteMany({ where: { organizationId } });
  await prisma.organization.deleteMany({ where: { id: organizationId } });
}

async function cleanupUser(userId: string) {
  await prisma.session.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
}

afterAll(async () => {
  await disconnectTestDatabase();
});

describe("Invitation routes", () => {
  test("rejects invitation creation without authentication", async () => {
    const response = await request(app)
      .post(`/organizations/${randomUUID()}/invitations`)
      .send({
        email: "new-member@example.com",
        roleCode: "member",
      });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
  });

  test("rejects invalid organization and invitation IDs", async () => {
    const { user, sessionToken } = await createAuthenticatedUser();

    try {
      const createResponse = await request(app)
        .post("/organizations/not-a-uuid/invitations")
        .set("Authorization", `Bearer ${sessionToken}`)
        .send({
          email: "new-member@example.com",
          roleCode: "member",
        });

      expect(createResponse.status).toBe(400);
      expect(createResponse.body.error.code).toBe("VALIDATION_ERROR");

      const revokeResponse = await request(app)
        .delete(`/organizations/${randomUUID()}/invitations/not-a-uuid`)
        .set("Authorization", `Bearer ${sessionToken}`);

      expect(revokeResponse.status).toBe(400);
      expect(revokeResponse.body.error.code).toBe("VALIDATION_ERROR");
    } finally {
      await cleanupUser(user.id);
    }
  });

  test("creates an invitation and returns its token once", async () => {
    const { user, sessionToken } = await createAuthenticatedUser();
    let organizationId: string | undefined;

    try {
      const organization = await createOrganization(
        `Invitation test ${randomUUID()}`,
        user.id,
      );
      organizationId = organization.id;

      const response = await request(app)
        .post(`/organizations/${organization.id}/invitations`)
        .set("Authorization", `Bearer ${sessionToken}`)
        .send({
          email: "  New.Member@Example.com  ",
          roleCode: "member",
        });

      expect(response.status).toBe(201);
      expect(response.body.data.invitation.invitedEmail).toBe(
        "new.member@example.com",
      );
      expect(response.body.data.token).toMatch(/^[a-f0-9]{64}$/);
      expect(response.body.data.invitation).not.toHaveProperty("tokenHash");

      const savedInvitation = await prisma.invitation.findUniqueOrThrow({
        where: { id: response.body.data.invitation.id },
      });

      expect(savedInvitation.tokenHash).not.toBe(response.body.data.token);
      expect(savedInvitation.tokenHash).toHaveLength(64);
    } finally {
      if (organizationId) {
        await cleanupOrganization(organizationId);
      }
      await cleanupUser(user.id);
    }
  });

  test("rejects a member's attempt to create an invitation", async () => {
    const { user, sessionToken } = await createAuthenticatedUser();
    let organizationId: string | undefined;
    let memberUserId: string | undefined;

    try {
      const organization = await createOrganization(
        `Invitation permissions ${randomUUID()}`,
        user.id,
      );
      organizationId = organization.id;

      const memberUser = await createAuthenticatedUser();
      memberUserId = memberUser.user.id;

      const response = await request(app)
        .post(`/organizations/${organization.id}/invitations`)
        .set("Authorization", `Bearer ${memberUser.sessionToken}`)
        .send({
          email: "another-member@example.com",
          roleCode: "member",
        });

      await createMembership(organization.id, memberUser.user.id, "member");

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("FORBIDDEN");
    } finally {
      if (organizationId) {
        await cleanupOrganization(organizationId);
      }

      if (memberUserId) {
        await cleanupUser(memberUserId);
      }

      await cleanupUser(user.id);
    }
  });

  test("revokes a pending invitation", async () => {
    const { user, sessionToken } = await createAuthenticatedUser();
    let organizationId: string | undefined;

    try {
      const organization = await createOrganization(
        `Invitation revocation ${randomUUID()}`,
        user.id,
      );
      organizationId = organization.id;

      const createResponse = await request(app)
        .post(`/organizations/${organization.id}/invitations`)
        .set("Authorization", `Bearer ${sessionToken}`)
        .send({
          email: "revoke-me@example.com",
          roleCode: "member",
        });

      expect(createResponse.status).toBe(201);

      const invitationId = createResponse.body.data.invitation.id as string;

      const revokeResponse = await request(app)
        .delete(`/organizations/${organization.id}/invitations/${invitationId}`)
        .set("Authorization", `Bearer ${sessionToken}`);

      expect(revokeResponse.status).toBe(200);
      expect(revokeResponse.body.data.invitationId).toBe(invitationId);
      expect(revokeResponse.body.data.status).toBe("revoked");

      const savedInvitation = await prisma.invitation.findUniqueOrThrow({
        where: { id: invitationId },
      });

      expect(savedInvitation.revokedAt).not.toBeNull();
    } finally {
      if (organizationId) {
        await cleanupOrganization(organizationId);
      }
      await cleanupUser(user.id);
    }
  });

  test("accepts an invitation using its token", async () => {
    const { user: owner, sessionToken: ownerToken } =
      await createAuthenticatedUser();
    const invitee = await createAuthenticatedUser();
    let organizationId: string | undefined;

    try {
      const organization = await createOrganization(
        `Invitation acceptance ${randomUUID()}`,
        owner.id,
      );
      organizationId = organization.id;

      const createResponse = await request(app)
        .post(`/organizations/${organization.id}/invitations`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          email: invitee.user.email,
          roleCode: "member",
        });

      expect(createResponse.status).toBe(201);

      const token = createResponse.body.data.token as string;

      const acceptResponse = await request(app)
        .post("/invitations/accept")
        .set("Authorization", `Bearer ${invitee.sessionToken}`)
        .send({ token });

      expect(acceptResponse.status).toBe(200);
      expect(acceptResponse.body.data.status).toBe("accepted");
      expect(acceptResponse.body.data.membership.userId).toBe(invitee.user.id);

      const membership = await prisma.membership.findUnique({
        where: {
          userId_organizationId: {
            userId: invitee.user.id,
            organizationId: organization.id,
          },
        },
      });

      expect(membership).not.toBeNull();
    } finally {
      if (organizationId) {
        await cleanupOrganization(organizationId);
      }
      await cleanupUser(invitee.user.id);
      await cleanupUser(owner.id);
    }
  });
});
