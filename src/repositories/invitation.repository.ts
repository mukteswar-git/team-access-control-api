import { prisma, type DatabaseClient } from "../lib/prisma.js";

export async function findPendingInvitation(
  organizationId: string,
  invitedEmail: string,
  db: DatabaseClient = prisma,
) {
  return db.invitation.findFirst({
    where: {
      organizationId,
      invitedEmail,
      acceptedAt: null,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
  });
}
