const Stripe = require("stripe");
const { getStore } = require("@netlify/blobs");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = event.headers["stripe-signature"];

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  if (stripeEvent.type === "checkout.session.completed") {
    const session = stripeEvent.data.object;
    const { planId, date } = session.metadata || {};

    // Increment the booked count for that date so the desk can't be double-booked.
    if (planId === "day-pass" && date) {
      try {
        const store = getStore("bookings");
        const current = parseInt((await store.get(date)) || "0", 10);
        await store.set(date, String(current + 1));
      } catch (err) {
        console.error("Failed to record day-pass booking:", err.message);
      }
    }

    // Only one private office exists — mark it occupied and remember the subscription
    // so it can be released automatically if the member cancels.
    if (planId === "private-office" || planId === "private-office-247") {
      try {
        const officeStore = getStore("private-office");
        await officeStore.setJSON("status", {
          occupied: true,
          subscriptionId: session.subscription || null,
          email: session.customer_details?.email || null,
          since: new Date().toISOString(),
        });
      } catch (err) {
        console.error("Failed to mark private office occupied:", err.message);
      }
    }

    // Keep a simple log of every paid booking/membership for your records.
    try {
      const logStore = getStore("booking-log");
      await logStore.set(session.id, JSON.stringify({
        planId,
        date: date || null,
        email: session.customer_details?.email || null,
        name: session.customer_details?.name || null,
        amountPaid: session.amount_total,
        mode: session.mode,
        createdAt: new Date().toISOString(),
      }));
    } catch (err) {
      console.error("Failed to write booking log:", err.message);
    }
  }

  // If the private office member's subscription ends, free up the room again.
  if (stripeEvent.type === "customer.subscription.deleted") {
    const subscription = stripeEvent.data.object;
    try {
      const officeStore = getStore("private-office");
      const status = await officeStore.get("status", { type: "json" });
      if (status && status.subscriptionId === subscription.id) {
        await officeStore.setJSON("status", { occupied: false });
      }
    } catch (err) {
      console.error("Failed to release private office:", err.message);
    }
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
