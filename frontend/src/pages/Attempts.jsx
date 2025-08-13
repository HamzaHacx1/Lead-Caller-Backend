import { useEffect, useMemo, useState } from "react";
import React from "react";

import Table from "../components/Table";
import { api } from "../lib/api";

export default function Attempts() {
  const [rows, setRows] = useState([]);

  useEffect(() => {
    api("/metrics/attempts").then(setRows).catch(console.error);
  }, []);

  const columns = useMemo(
    () => [
      { key: "id", label: "ID" },
      { key: "leadId", label: "Lead" },
      { key: "attemptNumber", label: "Try #" },
      { key: "status", label: "Status" },
      {
        key: "scheduledAt",
        label: "Scheduled",
        type: "datetime",
        timeZone: "America/Toronto",
      },
      {
        key: "startedAt",
        label: "Started",
        type: "datetime",
        timeZone: "America/Toronto",
      },
      {
        key: "endedAt",
        label: "Ended",
        type: "datetime",
        timeZone: "America/Toronto",
      },
      { key: "conversationId", label: "Conversation" },
    ],
    []
  );

  return (
    <Table columns={columns} rows={rows} defaultTimeZone="America/Toronto" />
  );
}
