import { useEffect, useRef, useState } from "react";
import React from "react";

import {
  listConversations,
  getMessages,
  sendMessage,
  startConversation,
} from "../lib/sms";
import { socket } from "../lib/socket";

const API_BASE = "https://call.emploirapide.ca";

export default function Sms() {
  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState("");
  const [newTo, setNewTo] = useState("");
  const [newBody, setNewBody] = useState("");
  const messagesEndRef = useRef(null);

  useEffect(() => {
    refreshConversations();
  }, []);

  async function refreshConversations() {
    const res = await listConversations();
    setConversations(res.conversations || []);
  }
  // --- helper: add a message uniquely, replacing temp when matching ---
  function addMessageUnique(msg) {
    setMessages((prev) => {
      // already have this exact id?
      if (prev.some((p) => p.id === msg.id)) return prev;

      // if this is an OUTBOUND server message, try to replace a temp
      if (msg.direction === "OUTBOUND") {
        const now = Date.now();
        const pruned = prev.filter((p) => {
          const isTemp = typeof p.id === "string" && p.id.startsWith("tmp-");
          const isRecent =
            isTemp && now - Number(p.id.replace("tmp-", "")) < 15_000; // within 15s window
          const sameConv = p.conversationId === msg.conversationId;
          const sameBody = (p.body || "") === (msg.body || "");
          // drop temp if same conversation + same body + very recent
          return !(isTemp && isRecent && sameConv && sameBody);
        });
        return [...pruned, msg];
      }

      return [...prev, msg];
    });
  }

  // Realtime socket events
  useEffect(() => {
    function handleReceived(msg) {
      if (msg.conversationId === activeId) addMessageUnique(msg);
      refreshConversations();
    }

    function handleSent(msg) {
      if (msg.conversationId === activeId) addMessageUnique(msg);
      refreshConversations();
    }

    function handleNewConversation(conv) {
      setConversations((prev) => {
        const filtered = prev.filter((c) => c.id !== conv.id);
        return [conv, ...filtered];
      });
    }

    socket.on("sms:received", handleReceived);
    socket.on("sms:sent", handleSent);
    socket.on("sms:newConversation", handleNewConversation);

    return () => {
      socket.off("sms:received", handleReceived);
      socket.off("sms:sent", handleSent);
      socket.off("sms:newConversation", handleNewConversation);
    };
  }, [activeId]);

  // Send
  async function handleSend(e) {
    e.preventDefault();
    if (!text.trim() || !activeId) return;

    const body = text.trim();

    // optimistic temp bubble
    const tempId = `tmp-${Date.now()}`;
    const tempMsg = {
      id: tempId,
      conversationId: activeId,
      body,
      direction: "OUTBOUND",
    };
    setMessages((prev) => [...prev, tempMsg]);
    setText("");

    try {
      // if your sendMessage returns the saved message, use it to replace temp immediately
      const saved = await sendMessage(activeId, body);
      if (saved && saved.id) addMessageUnique(saved);
      // else: the socket 'sms:sent' will arrive and replace the temp via addMessageUnique
    } catch (err) {
      // on error, remove the temp and optionally show a toast
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      console.error("Failed to send message:", err);
    }
  }

  // Load messages when selecting a conversation
  useEffect(() => {
    if (!activeId) return;
    getMessages(activeId).then((res) => {
      // server sends newest first; display oldest -> newest
      const ordered = (res.messages || []).slice().reverse();
      setMessages(ordered);
    });
  }, [activeId]);

  // Scroll to bottom when messages update
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  // Realtime socket events

  function resolveMediaUrl(url) {
    if (!url) return "";

    // normalize old saved paths
    let u = url.trim();

    // fix older records that start with /api/sms/...
    if (u.startsWith("/api/sms/")) u = u.replace("/api/sms/", "/sms/");

    // skip obviously bad entries
    if (u.endsWith("/undefined")) return "";

    // already absolute?
    if (u.startsWith("http://") || u.startsWith("https://")) return u;

    // make absolute
    return `${API_BASE}${u}`;
  }
  async function handleStartConversation(e) {
    e.preventDefault();
    const to = newTo.trim();
    const body = newBody.trim();
    if (!to || !body) return;

    const res = await startConversation({ to, body });
    // Pick the created conversation
    if (res.conversationId) {
      await refreshConversations();
      setActiveId(res.conversationId);
      setNewTo("");
      setNewBody("");
    }
  }

  return (
    <div className="flex h-[600px] border rounded-lg overflow-hidden">
      {/* Sidebar */}
      <div className="w-1/3 overflow-y-auto border-r">
        {/* New conversation composer */}
        <form
          onSubmit={handleStartConversation}
          className="p-3 space-y-2 border-b"
        >
          <div className="text-sm font-semibold">New conversation</div>
          <input
            className="w-full p-2 border rounded"
            placeholder="Recipient phone (E.164)"
            value={newTo}
            onChange={(e) => setNewTo(e.target.value)}
          />
          <textarea
            className="w-full p-2 border rounded"
            placeholder="Your message"
            value={newBody}
            onChange={(e) => setNewBody(e.target.value)}
            rows={2}
          />
          <button
            type="submit"
            className="w-full px-3 py-2 text-white bg-black rounded"
          >
            Start
          </button>
        </form>

        {/* Conversation list */}
        {conversations.map((c) => (
          <div
            key={c.id}
            onClick={() => setActiveId(c.id)}
            className={`p-3 cursor-pointer ${
              activeId === c.id ? "bg-slate-200" : "hover:bg-slate-100"
            }`}
          >
            <div className="font-semibold">
              {c.Lead?.fullName || c.Lead?.phone || "Unknown Lead"}
            </div>
            <div className="text-[10px] text-gray-400">
              {c.lastMsgAt && new Date(c.lastMsgAt).toLocaleString()}
            </div>
          </div>
        ))}
      </div>

      {/* Chat window */}
      <div className="flex flex-col flex-1">
        {activeId ? (
          <>
            <div className="flex-1 p-4 space-y-2 overflow-y-auto">
              {messages.map((m) => (
                <div
                  key={m.id}
                  className={`p-2 rounded-lg max-w-xs ${
                    m.direction === "OUTBOUND"
                      ? "bg-black text-white ml-auto"
                      : "bg-gray-200"
                  }`}
                >
                  {/* text */}
                  {m.body && <div>{m.body}</div>}

                  {/* media */}
                  {Array.isArray(m.mediaUrls) && m.mediaUrls.length > 0 && (
                    <div className="mt-2 space-y-2">
                      {m.mediaUrls
                        .map((raw, i) => {
                          const ct = m.mediaContentTypes?.[i];
                          const resolved = resolveMediaUrl(raw);
                          if (!resolved) return null; // skip bad/undefined

                          const isImg =
                            (ct && ct.startsWith("image/")) ||
                            /\.(png|jpe?g|gif|webp|svg)$/i.test(resolved);

                          return isImg ? (
                            <a
                              key={`${m.id}-media-${i}`}
                              href={resolved}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <img
                                src={resolved}
                                alt={`media ${i + 1}`}
                                className="rounded"
                                style={{
                                  maxWidth: 280,
                                  maxHeight: 360,
                                  objectFit: "contain",
                                }}
                                onError={(e) => {
                                  console.warn(
                                    "Image failed to load:",
                                    resolved,
                                    e?.nativeEvent
                                  );
                                  // optional: show a tiny fallback
                                  e.currentTarget.style.display = "none";
                                }}
                              />
                            </a>
                          ) : (
                            <a
                              key={`${m.id}-media-${i}`}
                              href={resolved}
                              target="_blank"
                              rel="noreferrer"
                              className="underline break-all"
                            >
                              Attachment {i + 1} {ct ? `(${ct})` : ""}
                            </a>
                          );
                        })
                        .filter(Boolean)}
                    </div>
                  )}
                </div>
              ))}

              <div ref={messagesEndRef} />
            </div>
            <form onSubmit={handleSend} className="flex border-t">
              <input
                className="flex-1 p-2 outline-none"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Type a message..."
              />
              <button type="submit" className="px-4 py-2 text-white bg-black">
                Send
              </button>
            </form>
          </>
        ) : (
          <div className="flex items-center justify-center flex-1 text-gray-500">
            Select a conversation or start a new one
          </div>
        )}
      </div>
    </div>
  );
}
