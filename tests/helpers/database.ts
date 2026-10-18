import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../src/generated/prisma/client.js";
import { env } from "../../src/config/env.js";

const adapter = new PrismaPg({
  connectionString: env.DATABASE_URL,
});

export const testPrisma = new PrismaClient({ adapter });

export async function disconnectTestDatabase() {
  await testPrisma.$disconnect();
}
