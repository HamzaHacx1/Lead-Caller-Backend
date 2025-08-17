import { useEffect, useRef, useState } from "react";
import React from "react";

import { listConversations, getMessages, sendMessage } from "../lib/sms";
import { socket } from "../lib/socket";

export default function Sms() {
  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState("");
  const messagesEndRef = useRef(null);

  // Load conversations on mount
  useEffect(() => {
    refreshConversations();
  }, []);

  async function refreshConversations() {
    const res = await listConversations();
    setConversations(res.conversations);
  }

  // Load messages when selecting a conversation
  useEffect(() => {
    if (!activeId) return;
    getMessages(activeId).then((res) => setMessages(res.messages));
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
      // Add to messages if it's for active conversation
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
      setConversations((prev) => [conv, ...prev]);
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

    // Optimistic UI update
    const tempMsg = {
      id: Date.now(),
      conversationId: activeId,
      body,
      direction: "OUTBOUND",
    };
    setMessages((prev) => [...prev, tempMsg]);

    await sendMessage(activeId, body);
    setText("");
  }

  return (
    <div className="flex h-[600px] border rounded-lg overflow-hidden">
      {/* Sidebar */}
      <div className="w-1/3 overflow-y-auto border-r">
        {conversations.map((c) => (
          <div
            key={c.id}
            onClick={() => setActiveId(c.id)}
            className={`p-3 cursor-pointer ${
              activeId === c.id ? "bg-slate-200" : "hover:bg-slate-100"
            }`}
          >
            <div className="font-semibold">
              {c.lead?.fullName || c.lead?.phone}
            </div>
            <div className="text-xs text-gray-500 truncate">
              {c.lastMessage?.body || "No messages yet"}
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
            Select a conversation
          </div>
        )}
      </div>
    </div>
  );
}
