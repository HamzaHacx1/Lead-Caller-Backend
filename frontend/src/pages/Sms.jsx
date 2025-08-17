import { useEffect, useRef, useState } from "react";
import React from "react";

import {
  listConversations,
  getMessages,
  sendMessage,
  startConversation,
} from "../lib/sms";
import { socket } from "../lib/socket";

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
  useEffect(() => {
    function handleReceived(msg) {
      if (msg.conversationId === activeId) {
        setMessages((prev) => [...prev, msg]);
      }
      refreshConversations();
    }

    function handleSent(msg) {
      if (msg.conversationId === activeId) {
        setMessages((prev) => [...prev, msg]);
      }
      refreshConversations();
    }

    function handleNewConversation(conv) {
      // Ensure newest on top in sidebar
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

  async function handleSend(e) {
    e.preventDefault();
    if (!text.trim() || !activeId) return;

    const body = text.trim();

    // Optimistic UI update (OUTBOUND)
    const tempMsg = {
      id: `tmp-${Date.now()}`,
      conversationId: activeId,
      body,
      direction: "OUTBOUND",
    };
    setMessages((prev) => [...prev, tempMsg]);

    await sendMessage(activeId, body);
    setText("");
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
                  {m.body}
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
