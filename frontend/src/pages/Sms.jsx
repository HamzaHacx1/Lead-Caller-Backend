import { useEffect, useState } from "react";

import { listConversations, getMessages, sendMessage } from "../lib/sms";
import { socket } from "../lib/socket";

export default function Sms() {
  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState("");

  // Load conversations
  useEffect(() => {
    listConversations().then((res) => setConversations(res.conversations));
  }, []);

  // Load messages when a conversation is selected
  useEffect(() => {
    if (!activeId) return;
    getMessages(activeId).then((res) => setMessages(res.messages));
  }, [activeId]);

  // Realtime socket updates
  useEffect(() => {
    function handleReceived(msg) {
      if (msg.conversationId === activeId) {
        setMessages((prev) => [msg, ...prev]);
      }
    }
    function handleSent(msg) {
      if (msg.conversationId === activeId) {
        setMessages((prev) => [msg, ...prev]);
      }
    }

    socket.on("sms:received", handleReceived);
    socket.on("sms:sent", handleSent);

    return () => {
      socket.off("sms:received", handleReceived);
      socket.off("sms:sent", handleSent);
    };
  }, [activeId]);

  async function handleSend(e) {
    e.preventDefault();
    if (!text.trim()) return;
    await sendMessage(activeId, text.trim());
    setText("");
  }

  return (
    <div className="flex h-[600px] border rounded-lg overflow-hidden">
      {/* Sidebar with conversations */}
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
            <div className="text-xs text-gray-500">
              Last: {new Date(c.lastMsgAt).toLocaleString()}
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
            </div>
            <form onSubmit={handleSend} className="flex border-t">
              <input
                className="flex-1 p-2"
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
