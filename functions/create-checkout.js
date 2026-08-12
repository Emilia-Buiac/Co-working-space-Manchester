const Stripe = require("stripe");
const { getStore } = require("@netlify/blobs");

// Keep this in sync with the prices shown on the site.
// amount is in pence. mode "payment" = one-off, "subscription" = monthly recurring.
const PLANS = {
  "day-pass": { name: "Hot Desk — Day Pass", amount: 1500, mode: "payment" },
  "hot-desk-day": { name: "Hot Desk — Day Rate (Monthly)", amount: 15000, mode: "subscription" },
  "hot-desk-night": { name: "Hot Desk — Night Rate (Monthly)", amount: 15000, mode: "subscription" },
  "hot-desk-247": { name: "Hot Desk — 24/7 Access (Monthly)", amount: 25000, mode: "subscription" },
  "private-office": { name: "Private Office (Monthly)", amount: 30000, mode: "subscription" },
  "private-office-247": { name: "Private Office — 24/7 Access (Monthly)", amount: 45000, mode: "subscription" },
};

const DAY_PASS_CAPACITY = 15; // total hot desk seats available per date
const PRIVATE_OFFICE_ROOMS = 1; // only one private office room exists
const PRIVATE_OFFICE_PLANS = ["private-office", "private-office-247"];

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid request body" }) };
  }

  const { planId, date, email } = body;
  const plan = PLANS[planId];

  if (!plan) {
    return { statusCode: 400, body: JSON.stringify({ error: "Unknown plan selected" }) };
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "Payments are not configured yet. Please call to book instead." }) };
  }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const siteUrl = process.env.URL || `https://${event.headers.host}`;

  // Day passes are date-specific and capacity-limited — check before creating a payment session.
  if (planId === "day-pass") {
    if (!date) {
      return { statusCode: 400, body: JSON.stringify({ error: "Please choose a date for your day pass." }) };
    }
    try {
      const store = getStore("bookings");
      const current = parseInt((await store.get(date)) || "0", 10);
      if (current >= DAY_PASS_CAPACITY) {
        return { statusCode: 409, body: JSON.stringify({ error: "That date is fully booked. Please choose another date." }) };
      }
    } catch (err) {
      // If Blobs isn't set up yet, don't block bookings — just skip the capacity check.
      console.error("Availability check failed:", err.message);
    }
  }

  // Only one private office exists — block new sign-ups while it's occupied.
  if (PRIVATE_OFFICE_PLANS.includes(planId)) {
    try {
      const officeStore = getStore("private-office");
      const status = await officeStore.get("status", { type: "json" });
      if (status && status.occupied) {
        return {
          statusCode: 409,
          body: JSON.stringify({ error: "The private office is currently taken. Call us to join the waiting list." }),
        };
      }
    } catch (err) {
      console.error("Private office check failed:", err.message);
    }
  }

  const lineItem = {
    quantity: 1,
    price_data: {
      currency: "gbp",
      product_data: { name: plan.name + (date ? ` — ${date}` : "") },
      unit_amount: plan.amount,
    },
  };

  if (plan.mode === "subscription") {
    lineItem.price_data.recurring = { interval: "month" };
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: plan.mode,
      payment_method_types: ["card"],
      line_items: [lineItem],
      customer_email: email || undefined,
      success_url: `${siteUrl}/booking.html?success=true&plan=${encodeURIComponent(planId)}`,
      cancel_url: `${siteUrl}/booking.html?canceled=true&plan=${encodeURIComponent(planId)}`,
      metadata: { planId, date: date || "" },
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: session.url }),
    };
  } catch (err) {
    console.error("Stripe error:", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: "Could not start checkout. Please try again or call us." }) };
  }
};
