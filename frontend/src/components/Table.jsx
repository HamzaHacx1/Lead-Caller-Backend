import React from "react";
export default function Table({ columns, rows }) {
  return (
    <div className="overflow-auto rounded-2xl border bg-white shadow">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="bg-slate-100 text-left">
            {columns.map(c => (
              <th key={c.key} className="px-3 py-2 font-medium">{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t">
              {columns.map(c => (
                <td key={c.key} className="px-3 py-2">{String(r[c.key] ?? '')}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
