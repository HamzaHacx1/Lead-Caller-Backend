// src/api/sms.js
import { api } from "./api"; // your existing helper

// your existing helper

// Conversations
export function listConversations(params = {}) {
  const query = new URLSearchParams(params).toString();
  return api(`/sms/conversations${query ? `?${query}` : ""}`);
}

export function getMessages(conversationId, params = {}) {
  const query = new URLSearchParams({ ...params, conversationId }).toString();
  return api(`/sms/messages?${query}`);
}

export function sendMessage(conversationId, body) {
  return api(`/sms/conversations/${conversationId}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  });
}

export function markMessagesRead(conversationId, upToId) {
  return api(`/sms/messages/mark-read`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId, upToId }),
  });
}

export function searchSms(q, limit = 20) {
  return api(`/sms/search?q=${encodeURIComponent(q)}&limit=${limit}`);
}
