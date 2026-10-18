import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.url("DATABASE_URL must be a valid URL"),
  RESEND_API_KEY: z.string().min(1, "RESEND_API_KEY is required"),
  FRONTEND_URL: z.url("FRONTEND_URL must be a valid URL"),
});

export const env = envSchema.parse(process.env);
