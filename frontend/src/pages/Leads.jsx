import { useEffect, useState } from "react";
import React from "react";

import Table from "../components/Table";
import { api } from "../lib/api";

export default function Leads() {
  const [rows, setRows] = useState([]);
  useEffect(() => {
    api("/metrics/leads").then(setRows).catch(console.error);
  }, []);
  const columns = [
    { key: "id", label: "ID" },
    { key: "fullName", label: "Name" },
    { key: "phone", label: "Phone" },
    { key: "email", label: "Email" },
    { key: "timezone", label: "TZ" },
    { key: "status", label: "Status" },
    { key: "attempts", label: "Attempts" },
    { key: "lastOutcome", label: "Last Outcome" },
    {
      key: "lastAttemptAt",
      label: "Last Attempt",
      type: "datetime",
      timeZone: "America/Toronto",
    },
  ];

  // If you want browser-local time, remove timeZone or pass defaultTimeZone={undefined}
  return (
    <Table columns={columns} rows={rows} defaultTimeZone="America/Toronto" />
  );
}
