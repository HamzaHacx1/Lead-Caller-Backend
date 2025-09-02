import { useState } from "react";

function LeadForm() {
  const API_URL = import.meta.env.VITE_API_BASE || "http://localhost:3000";
  const [formData, setFormData] = useState({
    fbLeadId: crypto.randomUUID(),
    full_name: "",
    phone: "",
    email: "",
    forceNow: false,
    ignoreWindow: false,
    outcomes: "ANSWERED",
    simulate: true,
    useQuickNotifications: true,
  });
  const [response, setResponse] = useState(null);
  const [error, setError] = useState(null);

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData({
      ...formData,
      [name]: type === "checkbox" ? checked : value,
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setResponse(null);

    const payload = {
      ...formData,
      outcomes: formData.outcomes
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean),
    };

    try {
      const res = await fetch(`${API_URL}/test/test-flow`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (res.ok) {
        setResponse(data);
        // Reset form with new fbLeadId
        setFormData({
          fbLeadId: crypto.randomUUID(),
          full_name: "",
          phone: "",
          email: "",
          forceNow: false,
          ignoreWindow: false,
          outcomes: "ANSWERED",
          simulate: true,
          useQuickNotifications: true,
        });
      } else {
        setError(data.error || "Request failed");
      }
    } catch (err) {
      setError("Network error: " + err.message);
    }
  };

  return (
    <div className="flex items-center justify-center px-4 py-20 bg-gray-100 sm:px-6 lg:px-8">
      <div className="w-full max-w-md p-6 bg-white rounded-lg shadow-md sm:max-w-lg md:max-w-xl">
        <h2 className="mb-6 text-xl font-bold text-center text-gray-800 sm:text-2xl">
          Test Lead Form
        </h2>
        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700">
              Full Name
            </label>
            <input
              type="text"
              name="full_name"
              value={formData.full_name}
              onChange={handleChange}
              className="w-full p-2 mt-1 border rounded-md focus:ring-blue-500 focus:border-blue-500 sm:p-3"
              required
            />
          </div>
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700">
              Phone
            </label>
            <input
              type="tel"
              name="phone"
              value={formData.phone}
              onChange={handleChange}
              className="w-full p-2 mt-1 border rounded-md focus:ring-blue-500 focus:border-blue-500 sm:p-3"
              required
            />
          </div>
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700">
              Email
            </label>
            <input
              type="email"
              name="email"
              value={formData.email}
              onChange={handleChange}
              className="w-full p-2 mt-1 border rounded-md focus:ring-blue-500 focus:border-blue-500 sm:p-3"
            />
          </div>
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700">
              Outcomes (comma-separated, e.g. ANSWERED,NO_ANSWER)
            </label>
            <input
              type="text"
              name="outcomes"
              value={formData.outcomes}
              onChange={handleChange}
              className="w-full p-2 mt-1 border rounded-md focus:ring-blue-500 focus:border-blue-500 sm:p-3"
            />
          </div>
          <div className="mb-4">
            <label className="flex items-center">
              <input
                type="checkbox"
                name="forceNow"
                checked={formData.forceNow}
                onChange={handleChange}
                className="w-4 h-4 mr-2 text-blue-500 border-gray-300 rounded focus:ring-blue-500"
              />
              <span className="text-sm text-gray-700">Force Now</span>
            </label>
          </div>
          <div className="mb-4">
            <label className="flex items-center">
              <input
                type="checkbox"
                name="ignoreWindow"
                checked={formData.ignoreWindow}
                onChange={handleChange}
                className="w-4 h-4 mr-2 text-blue-500 border-gray-300 rounded focus:ring-blue-500"
              />
              <span className="text-sm text-gray-700">Ignore Window</span>
            </label>
          </div>
          <div className="mb-4">
            <label className="flex items-center">
              <input
                type="checkbox"
                name="simulate"
                checked={formData.simulate}
                onChange={handleChange}
                className="w-4 h-4 mr-2 text-blue-500 border-gray-300 rounded focus:ring-blue-500"
              />
              <span className="text-sm text-gray-700">Simulate</span>
            </label>
          </div>
          <div className="mb-6">
            <label className="flex items-center">
              <input
                type="checkbox"
                name="useQuickNotifications"
                checked={formData.useQuickNotifications}
                onChange={handleChange}
                className="w-4 h-4 mr-2 text-blue-500 border-gray-300 rounded focus:ring-blue-500"
              />
              <span className="text-sm text-gray-700">
                Use Quick Notifications
              </span>
            </label>
          </div>
          <button
            type="submit"
            className="w-full p-2 text-white bg-blue-500 rounded-md hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 sm:p-3"
          >
            Submit
          </button>
        </form>
        {response && (
          <div className="p-4 mt-6 text-green-700 bg-green-100 rounded-md">
            <pre className="overflow-auto text-sm">
              {JSON.stringify(response, null, 2)}
            </pre>
          </div>
        )}
        {error && (
          <div className="p-4 mt-6 text-red-700 bg-red-100 rounded-md">
            Error: {error}
          </div>
        )}
      </div>
    </div>
  );
}

export default LeadForm;
