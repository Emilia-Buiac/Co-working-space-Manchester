const { getStore } = require("@netlify/blobs");

const DAY_PASS_CAPACITY = 15; // keep in sync with create-checkout.js

exports.handler = async (event) => {
  const month = event.queryStringParameters?.month; // format: YYYY-MM

  if (!month) {
    return { statusCode: 400, body: JSON.stringify({ error: "month query param required, e.g. ?month=2026-09" }) };
  }

  try {
    const store = getStore("bookings");
    const { blobs } = await store.list({ prefix: month });

    const result = {};
    for (const b of blobs) {
      const count = parseInt((await store.get(b.key)) || "0", 10);
      result[b.key] = { booked: count, capacity: DAY_PASS_CAPACITY, full: count >= DAY_PASS_CAPACITY };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify(result),
    };
  } catch (err) {
    console.error("Availability lookup failed:", err.message);
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) };
  }
};
