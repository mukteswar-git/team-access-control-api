import express from "express";
import helmet from "helmet";
import authRoutes from "./modules/auth/auth.routes.js";
import errorHandler from "./middleware/error-handler.js";

const app = express();

app.use(helmet());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.use("/auth", authRoutes);

app.use(errorHandler);

export default app;
