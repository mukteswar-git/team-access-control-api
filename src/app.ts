import express from "express";
import helmet from "helmet";
import authRoutes from "./modules/auth/auth.routes.js";
import organizationRoutes from "./modules/organization/organization.routes.js";
import invitationRoutes from "./modules/invitation/invitation.routes.js";
import errorHandler from "./middleware/error-handler.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import swaggerUi from "swagger-ui-express";

const openApiPath = fileURLToPath(
  new URL("../docs/openapi.yaml", import.meta.url),
);

const openApiSpec = parse(readFileSync(openApiPath, "utf8"));

const app = express();

app.use(helmet());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(openApiSpec));

app.use("/auth", authRoutes);
app.use("/organizations", organizationRoutes);
app.use(invitationRoutes);

app.use(errorHandler);

export default app;
