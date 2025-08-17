// src/server.js (ESM)
import "dotenv/config";

import { Server as SocketIOServer } from "socket.io";
import bodyParser from "body-parser";
import express from "express";
import morgan from "morgan";
import http from "http";
import cors from "cors";

import { setIo, emit } from "./lib/realtime.js"; // <-- include .js
import webhooks from "./routes/webhooks.js";
import metrics from "./routes/metrics.js";
import authRoutes from "./routes/auth.js";
import intake from "./routes/intake.js";
import sms from "./routes/sms.js";

// <-- include .js

const app = express();

// --- Logging & CORS ---
app.use(
  morgan(":method :url :status :res[content-length] - :response-time ms")
);

// Parse origins from env (comma-separated), fallback to localhost dev
const origins = process.env.PUBLIC_WS_ORIGIN
  ? process.env.PUBLIC_WS_ORIGIN.split(",").map((o) => o.trim())
  : ["http://localhost:5173"];

console.log("Allowed origins:", origins);

// REST API CORS
app.use(
  cors({
    origin: function (origin, callback) {
      // allow requests with no origin (e.g. curl, mobile apps)
      if (!origin) return callback(null, true);
      if (origins.indexOf(origin) !== -1) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS: " + origin));
    },
    credentials: true,
  })
);

// 2) Twilio posts application/x-www-form-urlencoded by default:
app.use(bodyParser.urlencoded({ extended: true })); // not false

// --- Health ---
app.get("/", (_req, res) => res.json({ ok: true }));

// --- Your routes ---
app.use("/intake", intake);
app.use("/webhooks", webhooks);
app.use("/metrics", metrics);
app.use("/auth", authRoutes);
app.use("/sms", sms);
// --- HTTP + Socket.IO (single listener) ---
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: origins, credentials: true },
});
setIo(io);

io.on("connection", (socket) => {
  console.log("WS connected", socket.id);
  socket.on("disconnect", () => console.log("WS disconnected", socket.id));
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`API + WS on :${PORT}`);
});
