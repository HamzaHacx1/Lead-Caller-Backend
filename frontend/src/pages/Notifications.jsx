import { useEffect, useMemo, useState } from "react";

import { api } from "../lib/api";

const EDITABLE_FIELDS = [
  "subject",
  "title",
  "subtitle",
  "bodyText",
  "cta_text",
  "cta_link",
  "closingText",
];

const FIELD_LABELS = {
  subject: "Email subject",
  title: "Header title",
  subtitle: "Header subtitle",
  bodyText: "Body content (HTML allowed)",
  cta_text: "CTA button text",
  cta_link: "CTA link",
  closingText: "Closing / signature",
};

const STEP_LABELS = {
  ANSWERED_15M: "Answered – 15 minutes",
  ANSWERED_30M: "Answered – 30 minutes",
  ANSWERED_24H: "Answered – 24 hours",
  ANSWERED_48H: "Answered – 48 hours",
  AFTER_1_NO_ANSWER: "No Answer – Attempt 1",
  AFTER_2_NO_ANSWER: "No Answer – Attempt 2",
  AFTER_3_NO_ANSWER: "No Answer – Attempt 3",
  AFTER_1_NO_ANSWER_QUICK: "No Answer (Quick) – Attempt 1",
  AFTER_2_NO_ANSWER_QUICK: "No Answer (Quick) – Attempt 2",
  AFTER_3_NO_ANSWER_QUICK: "No Answer (Quick) – Attempt 3",
};

const ERROR_MESSAGES = {
  unknown_step: "Unknown notification step.",
  empty_payload: "Change at least one field before saving.",
  internal_error: "Server error. Try again in a moment.",
};

const TYPE_DESCRIPTIONS = {
  answered: "Follow-ups sent after a successful call.",
  missed: "Follow-ups when the lead did not answer.",
};

function friendlyStep(step) {
  return STEP_LABELS[step] || step.replace(/_/g, " ");
}

function describeStep(template) {
  return template.isAnswered ? TYPE_DESCRIPTIONS.answered : TYPE_DESCRIPTIONS.missed;
}

function pickEditableFields(source = {}) {
  const picked = {};
  for (const field of EDITABLE_FIELDS) {
    const raw = source[field];
    picked[field] = typeof raw === "string" ? raw : "";
  }
  return picked;
}

function extractErrorMessage(error) {
  if (!error) return "Unexpected error";
  const raw = error.message || String(error);
  try {
    const parsed = JSON.parse(raw);
    const code = parsed?.error;
    if (code && ERROR_MESSAGES[code]) return ERROR_MESSAGES[code];
    if (code) return code;
  } catch (_) {}
  const key = raw?.trim?.();
  if (ERROR_MESSAGES[key]) return ERROR_MESSAGES[key];
  return raw;
}

export default function Notifications() {
  const [templates, setTemplates] = useState([]);
  const [formValues, setFormValues] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState({});
  const [status, setStatus] = useState({});

  useEffect(() => {
    let cancelled = false;
    async function fetchTemplates() {
      setLoading(true);
      setError(null);
      try {
        const res = await api("/notifications/templates");
        if (cancelled) return;
        const list = Array.isArray(res?.templates) ? res.templates : [];
        setTemplates(list);
        const initial = {};
        for (const tpl of list) {
          initial[tpl.step] = pickEditableFields(tpl.current || tpl.defaults || {});
        }
        setFormValues(initial);
      } catch (err) {
        if (cancelled) return;
        setError(extractErrorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchTemplates();
    return () => {
      cancelled = true;
    };
  }, []);

  const sortedTemplates = useMemo(() => {
    return [...templates].sort((a, b) => a.step.localeCompare(b.step));
  }, [templates]);

  const updateFormValue = (step, field, value) => {
    setFormValues((prev) => ({
      ...prev,
      [step]: { ...pickEditableFields(prev[step]), [field]: value },
    }));
    setStatus((prev) => ({ ...prev, [step]: null }));
  };

  const handleSave = async (step) => {
    const template = templates.find((tpl) => tpl.step === step);
    if (!template) return;
    const values = pickEditableFields(formValues[step]);
    const payload = {};

    for (const field of EDITABLE_FIELDS) {
      const currentValue = values[field] ?? "";
      const defaultValue = template.defaults?.[field] ?? "";
      if (currentValue !== defaultValue) {
        payload[field] = currentValue;
      }
    }

    if (!Object.keys(payload).length) {
      setStatus((prev) => ({
        ...prev,
        [step]: { type: "info", message: "No changes to save." },
      }));
      return;
    }

    setSaving((prev) => ({ ...prev, [step]: true }));
    setStatus((prev) => ({ ...prev, [step]: { type: "pending", message: "Saving…" } }));

    try {
      const res = await api(`/notifications/templates/${step}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const updated = res?.template;
      if (updated) {
        setTemplates((prev) =>
          prev.map((tpl) => (tpl.step === step ? updated : tpl))
        );
        setFormValues((prev) => ({
          ...prev,
          [step]: pickEditableFields(updated.current || {}),
        }));
        setStatus((prev) => ({
          ...prev,
          [step]: { type: "success", message: "Template saved." },
        }));
      } else {
        setStatus((prev) => ({
          ...prev,
          [step]: {
            type: "error",
            message: "Unable to read server response.",
          },
        }));
      }
    } catch (err) {
      setStatus((prev) => ({
        ...prev,
        [step]: { type: "error", message: extractErrorMessage(err) },
      }));
    } finally {
      setSaving((prev) => ({ ...prev, [step]: false }));
    }
  };

  const handleReset = async (step) => {
    const template = templates.find((tpl) => tpl.step === step);
    if (!template) return;

    setSaving((prev) => ({ ...prev, [step]: true }));
    setStatus((prev) => ({ ...prev, [step]: { type: "pending", message: "Resetting…" } }));

    try {
      const res = await api(`/notifications/templates/${step}`, {
        method: "DELETE",
      });
      const updated = res?.template;
      if (updated) {
        setTemplates((prev) =>
          prev.map((tpl) => (tpl.step === step ? updated : tpl))
        );
        setFormValues((prev) => ({
          ...prev,
          [step]: pickEditableFields(updated.current || updated.defaults || {}),
        }));
        setStatus((prev) => ({
          ...prev,
          [step]: { type: "success", message: "Template reset to default." },
        }));
      } else {
        setStatus((prev) => ({
          ...prev,
          [step]: {
            type: "error",
            message: "Unable to read server response.",
          },
        }));
      }
    } catch (err) {
      setStatus((prev) => ({
        ...prev,
        [step]: { type: "error", message: extractErrorMessage(err) },
      }));
    } finally {
      setSaving((prev) => ({ ...prev, [step]: false }));
    }
  };

  const handleLoadDefaults = (step) => {
    const template = templates.find((tpl) => tpl.step === step);
    if (!template) return;
    setFormValues((prev) => ({
      ...prev,
      [step]: pickEditableFields(template.defaults || {}),
    }));
    setStatus((prev) => ({ ...prev, [step]: { type: "info", message: "Defaults loaded in editor." } }));
  };

  if (loading) {
    return <div className="text-sm text-slate-600">Loading notification templates…</div>;
  }

  if (error) {
    return <div className="text-sm text-red-600">{error}</div>;
  }

  if (!sortedTemplates.length) {
    return (
      <div className="text-sm text-slate-600">
        No notification templates available. Check back later.
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {sortedTemplates.map((template) => {
        const { step } = template;
        const values = pickEditableFields(formValues[step]);
        const stepStatus = status[step];
        const isSaving = Boolean(saving[step]);
        return (
          <section
            key={step}
            className="p-5 bg-white border rounded-2xl shadow-sm space-y-4"
          >
            <header className="flex flex-col gap-1">
              <h2 className="text-lg font-semibold text-slate-900">
                {friendlyStep(step)}
              </h2>
              <p className="text-xs text-slate-500">{describeStep(template)}</p>
              {template.updatedAt ? (
                <p className="text-xs text-slate-400">
                  Last updated {new Date(template.updatedAt).toLocaleString()}
                </p>
              ) : null}
            </header>

            <div className="grid gap-4">
              {EDITABLE_FIELDS.map((field) => (
                <div key={field}>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    {FIELD_LABELS[field]}
                  </label>
                  {field === "bodyText" || field === "closingText" ? (
                    <textarea
                      className="w-full p-3 border rounded-lg text-sm min-h-[120px] focus:outline-none focus:ring-2 focus:ring-slate-400"
                      value={values[field] ?? ""}
                      onChange={(e) => updateFormValue(step, field, e.target.value)}
                      spellCheck={false}
                    />
                  ) : (
                    <input
                      type="text"
                      className="w-full p-3 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
                      value={values[field] ?? ""}
                      onChange={(e) => updateFormValue(step, field, e.target.value)}
                    />
                  )}
                </div>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => handleSave(step)}
                disabled={isSaving}
                className={`px-4 py-2 rounded-lg text-sm font-medium text-white ${
                  isSaving ? "bg-slate-400" : "bg-black hover:bg-slate-800"
                }`}
              >
                {isSaving ? "Saving…" : "Save changes"}
              </button>
              <button
                type="button"
                onClick={() => handleReset(step)}
                disabled={isSaving}
                className="px-4 py-2 rounded-lg text-sm font-medium border border-slate-300 text-slate-700 hover:bg-slate-100"
              >
                Reset to default
              </button>
              <button
                type="button"
                onClick={() => handleLoadDefaults(step)}
                disabled={isSaving}
                className="px-4 py-2 rounded-lg text-sm font-medium border border-slate-200 text-slate-600 hover:bg-slate-50"
              >
                Load defaults into editor
              </button>
            </div>

            {stepStatus ? (
              <div
                className={`text-xs ${
                  stepStatus.type === "error"
                    ? "text-red-600"
                    : stepStatus.type === "success"
                    ? "text-green-600"
                    : "text-slate-500"
                }`}
              >
                {stepStatus.message}
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
