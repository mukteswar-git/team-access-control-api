import { prisma } from "../lib/prisma.js";

export function findMembershipById(id: string) {
  return prisma.membership.findUnique({
    where: { id },
    include: {
      user: true,
      organization: true,
      role: true,
      adminMembership: {
        include: {
          role: true,
        },
      },
      managerMembership: {
        include: {
          role: true,
        },
      },
    },
  });
}

export function findMembershipByUserAndOrganization(
  userId: string,
  organizationId: string,
) {
  return prisma.membership.findUnique({
    where: {
      userId_organizationId: {
        userId,
        organizationId,
      },
    },
    include: {
      user: true,
      organization: true,
      role: true,
      adminMembership: {
        include: {
          role: true,
        },
      },
      managerMembership: {
        include: {
          role: true,
        },
      },
    },
  });
}

export function findMembershipsByOrganizationId(organizationId: string) {
  return prisma.membership.findMany({
    where: { organizationId },
    include: {
      user: true,
      role: true,
      adminMembership: {
        include: {
          role: true,
        },
      },
      managerMembership: {
        include: {
          role: true,
        },
      },
    },
  });
}

export function findMembershipsByUserId(userId: string) {
  return prisma.membership.findMany({
    where: { userId },
    include: {
      organization: true,
      role: true,
      adminMembership: {
        include: {
          role: true,
        },
      },
      managerMembership: {
        include: {
          role: true,
        },
      },
    },
  });
}
