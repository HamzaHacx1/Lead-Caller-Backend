import { io } from "socket.io-client";

const BASE = import.meta.env.VITE_API_BASE || "http://localhost:3001";
export const socket = io(BASE, { withCredentials: true });
