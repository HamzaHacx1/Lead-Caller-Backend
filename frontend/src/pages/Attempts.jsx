import React from "react";
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import Table from '../components/Table';

export default function Attempts() {
  const [rows, setRows] = useState([]);
  useEffect(() => { api('/metrics/attempts').then(setRows).catch(console.error); }, []);
  const columns = [
    { key: 'id', label: 'ID' },
    { key: 'leadId', label: 'Lead' },
    { key: 'attemptNumber', label: 'Try #' },
    { key: 'status', label: 'Status' },
    { key: 'scheduledAt', label: 'Scheduled' },
    { key: 'startedAt', label: 'Started' },
    { key: 'endedAt', label: 'Ended' },
    { key: 'conversationId', label: 'Conversation' }
  ];
  return <Table columns={columns} rows={rows} />;
}
