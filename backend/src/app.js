// src/server.js (ESM)
import "dotenv/config";

import { Server as SocketIOServer } from "socket.io";
import bodyParser from "body-parser";
import express from "express";
import multer from "multer";
import morgan from "morgan";
import http from "http";
import cors from "cors";

import webhooks from "./routes/webhooks.js";
import metrics from "./routes/metrics.js";
import authRoutes from "./routes/auth.js";
import { setIo } from "./lib/realtime.js";
import intake from "./routes/intake.js";
import sms from "./routes/sms.js";

const app = express();

// --- Logging ---
app.use(
  morgan(":method :url :status :res[content-length] - :response-time ms")
);

// --- Allowed origins (adjust if needed) ---
const allowedOrigins = [
  "http://localhost:5173", // local dev
  "https://call.emploirapide.ca", // prod frontend
];

// --- CORS ---
app.use(
  cors({
    origin: function (origin, callback) {
      // allow requests with no origin (like curl, Postman)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS: " + origin));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Origin",
      "X-Requested-With",
      "Content-Type",
      "Accept",
      "Authorization",
    ],
  })
);

// Preflight handler
app.options("*", cors());

// --- Body parsers ---
// 1) JSON
app.use(
  express.json({
    limit: "2mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// 2) URL-encoded (Twilio, forms)
app.use(bodyParser.urlencoded({ extended: true }));

// 3) Multipart / form-data
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

// --- HTTP + Socket.IO ---
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: allowedOrigins,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  },
});
setIo(io);

io.on("connection", (socket) => {
  console.log("WS connected", socket.id);
  socket.on("disconnect", () => console.log("WS disconnected", socket.id));
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`API + WS running on :${PORT}`);
});
