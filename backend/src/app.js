import "dotenv/config";

import express from "express";
import morgan from "morgan";
import cors from "cors";

import webhooks from "./routes/webhooks.js";
import metrics from "./routes/metrics.js";
import authRoutes from "./routes/auth.js";
import intake from "./routes/intake.js";

const app = express();
app.use(cors());
app.use(
  morgan(":method :url :status :res[content-length] - :response-time ms")
);

// IMPORTANT: capture raw body for HMAC verification
app.use(
  express.json({
    limit: "2mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.get("/", (req, res) => res.json({ ok: true }));

app.use("/intake", intake);
app.use("/webhooks", webhooks);
app.use("/metrics", metrics);
app.use("/auth", authRoutes);

const port = process.env.PORT || 3001;
app.listen(port, () => console.log(`Backend listening on :${port}`));
