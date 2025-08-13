import React from "react";

function fmtDate(value, timeZone) {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d)) return String(value);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, // e.g., "America/Toronto" or undefined for browser local
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(d);
}

export default function Table({ columns, rows, defaultTimeZone }) {
  return (
    <div className="overflow-auto bg-white border shadow rounded-2xl">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="text-left bg-slate-100">
            {columns.map((c) => (
              <th key={c.key} className="px-3 py-2 font-medium">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t">
              {columns.map((c) => {
                const raw = r[c.key];
                let content;

                if (typeof c.render === "function") {
                  content = c.render(r, raw, i);
                } else if (c.type === "datetime") {
                  content = fmtDate(raw, c.timeZone || defaultTimeZone);
                } else {
                  content = raw ?? "";
                }

                // Only stringify primitives; allow React nodes to pass through
                const isReactNode =
                  typeof content === "object" && content !== null;
                return (
                  <td key={c.key} className="px-3 py-2">
                    {isReactNode ? content : String(content)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
