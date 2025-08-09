import React from "react";
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import Table from '../components/Table';

export default function Leads() {
  const [rows, setRows] = useState([]);
  useEffect(() => { api('/metrics/leads').then(setRows).catch(console.error); }, []);
  const columns = [
    { key: 'id', label: 'ID' },
    { key: 'fullName', label: 'Name' },
    { key: 'phone', label: 'Phone' },
    { key: 'email', label: 'Email' },
    { key: 'timezone', label: 'TZ' },
    { key: 'status', label: 'Status' },
    { key: 'attempts', label: 'Attempts' },
    { key: 'lastOutcome', label: 'Last Outcome' },
    { key: 'lastAttemptAt', label: 'Last Attempt' }
  ];
  return <Table columns={columns} rows={rows} />;
}
