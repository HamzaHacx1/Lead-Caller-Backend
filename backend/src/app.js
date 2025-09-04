import { Server as SocketIOServer } from "socket.io";
import bodyParser from "body-parser";
import express from "express";
import multer from "multer";
import morgan from "morgan";
// src/server.js (ESM)
import dotenv from "dotenv";
import http from "http";
import cors from "cors";

import { startDispatcher } from "./jobs/dispatcher.js";
import testApi from "./tests/notifications.js";
import webhooks from "./routes/webhooks.js";
import metrics from "./routes/metrics.js";
import authRoutes from "./routes/auth.js";
import { setIo } from "./lib/realtime.js";
import intake from "./routes/intake.js";
import n8n from "./tests/calls.js";
import sms from "./routes/sms.js";

const app = express();

// --- Logging ---
app.use(
  morgan(":method :url :status :res[content-length] - :response-time ms")
);

// --- Allowed origins ---
const allowedOrigins = [
  "http://localhost:5173", // local dev
  "https://emploirapide.ca", // prod frontend
  "https://call.emploirapide.ca", // prod subdomain
  "https://crm.emploirapide.ca", // prod CRM
];
dotenv.config();

// --- CORS ---
app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (like curl/Postman) OR matching whitelisted ones
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS: " + origin));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Origin",
      "X-Requested-With",
      "Content-Type",
      "Accept",
      "Authorization",
    ],
  })
);

// Explicit preflight
app.options("*", cors());

// --- Body parsers ---
// JSON (with raw buffer for signature verification)
app.use(
  express.json({
    limit: "2mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// URL-encoded (Twilio + forms)
app.use(bodyParser.urlencoded({ extended: true }));

// Multipart / form-data
const upload = multer();
app.use(upload.none());

// --- Health ---
app.get("/", (_req, res) => res.json({ ok: true }));

// --- Routes ---
app.use("/intake", intake);
app.use("/webhooks", webhooks);
app.use("/metrics", metrics);
app.use("/auth", authRoutes);
app.use("/sms", sms);
app.use("/test", testApi);
app.use("/call", n8n);
// --- HTTP + Socket.IO ---
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: allowedOrigins,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  },
});
setIo(io);

io.on("connection", (socket) => {
  console.log("WS connected", socket.id);
  socket.on("disconnect", () => console.log("WS disconnected", socket.id));
});
const stopDispatcher = startDispatcher();
process.on("SIGINT", async () => {
  try {
    stopDispatcher?.();
  } catch {}
  process.exit(0);
});
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`API + WS running on :${PORT}`);
});
