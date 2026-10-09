import express from "express";
import helmet from "helmet";
import errorHandler from "./middleware/error-handler.js";

const app = express();

app.use(helmet());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.use(errorHandler);

export default app;
