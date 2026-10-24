import { prisma, type DatabaseClient } from "../lib/prisma.js";
import type { Prisma } from "../generated/prisma/client.js";

export const SecurityEventType = {
  PASSWORD_RESET_COMPLETED: "PASSWORD_RESET_COMPLETED",
} as const;

type CreateSecurityEventInput = {
  userId: string;
  eventType: string;
  metadata?: Prisma.InputJsonValue;
};

export function createSecurityEvent(
  input: CreateSecurityEventInput,
  db: DatabaseClient = prisma,
) {
  return db.securityEvent.create({
    data: {
      userId: input.userId,
      eventType: input.eventType,
      metadata: input.metadata ?? {},
    },
  });
}
