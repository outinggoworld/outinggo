require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const Razorpay = require("razorpay");
const nodemailer = require("nodemailer");
const admin = require("firebase-admin");
const serviceAccount = require("./firebase-service-account.json");

const app = express();
app.use(cors());
app.use(express.json());

// ---------- Firebase ----------
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DB_URL,
});
const db = admin.firestore();

// ---------- Razorpay ----------
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ---------- Email (Gmail via App Password) ----------
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

// ---------- Server-side pricing truth for The Anthurium ----------
// Never trust amounts sent from the frontend — always recompute here.
const ANTHURIUM_PACKAGES = {
  "glamping-pods": { name: "Glamping Pods (Tent Stays)", pricePerPerson: 1199, maxPax: null },
  "standard-rooms": { name: "Standard Rooms", pricePerPerson: 1799, maxPax: null },
  "premium-suites": { name: "Premium Suites", flatPrice: 6999, maxPax: 5 },
  "luxurious-villa": { name: "Luxurious Villa", flatPrice: 14999, maxPax: 6 },
};
const TAX_RATE = 0.05;

function computeAmount(packageId, guests) {
  const pkg = ANTHURIUM_PACKAGES[packageId];
  if (!pkg) return null;
  if (pkg.maxPax && guests > pkg.maxPax) return null;
  const base = pkg.flatPrice ? pkg.flatPrice : pkg.pricePerPerson * guests;
  const tax = Math.round(base * TAX_RATE);
  return { base, tax, total: base + tax, packageName: pkg.name };
}

function generateBookingId() {
  const date = new Date();
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const rand = Math.floor(100 + Math.random() * 900);
  return `ANT-${y}${m}${d}-${rand}`;
}

function isTomorrow(dateStr) {
  const bookingDate = new Date(dateStr);
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return (
    bookingDate.getFullYear() === tomorrow.getFullYear() &&
    bookingDate.getMonth() === tomorrow.getMonth() &&
    bookingDate.getDate() === tomorrow.getDate()
  );
}

// ---------- 1. Create order (booking pending) ----------
app.post("/api/booking/create-order", async (req, res) => {
  try {
    const { packageId, guests, date, name, phone, email, message } = req.body;

    if (!packageId || !guests || !date || !name || !phone || !email) {
      return res.status(400).json({ error: "Missing required fields." });
    }

    const pricing = computeAmount(packageId, Number(guests));
    if (!pricing) {
      return res.status(400).json({ error: "Invalid package or guest count for this option." });
    }

    const bookingId = generateBookingId();

    const order = await razorpay.orders.create({
      amount: pricing.total * 100, // paise
      currency: "INR",
      receipt: bookingId,
    });

    await db.collection("bookings").doc(bookingId).set({
      bookingId,
      property: "The Anthurium",
      packageId,
      packageName: pricing.packageName,
      guests: Number(guests),
      bookingDate: date,
      customerName: name,
      customerPhone: phone,
      customerEmail: email,
      specialRequests: message || "",
      baseAmount: pricing.base,
      tax: pricing.tax,
      totalAmount: pricing.total,
      razorpayOrderId: order.id,
      paymentStatus: "PENDING",
      bookingStatus: "PENDING_PAYMENT",
      source: "theanthurium",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({
      bookingId,
      orderId: order.id,
      amount: pricing.total * 100,
      currency: "INR",
      keyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error("create-order error:", err);
    res.status(500).json({ error: "Could not create order. Please try again." });
  }
});

// ---------- 2. Verify payment (backend-authoritative) ----------
app.post("/api/booking/verify-payment", async (req, res) => {
  try {
    const { bookingId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!bookingId || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: "Missing payment details." });
    }

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      await db.collection("bookings").doc(bookingId).update({
        paymentStatus: "PAYMENT_FAILED",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return res.status(400).json({ error: "Payment verification failed." });
    }

    const bookingRef = db.collection("bookings").doc(bookingId);
    const bookingSnap = await bookingRef.get();
    if (!bookingSnap.exists) {
      return res.status(404).json({ error: "Booking not found." });
    }
    const booking = bookingSnap.data();

    await bookingRef.update({
      paymentStatus: "PAID",
      bookingStatus: "CONFIRMED",
      razorpayPaymentId: razorpay_payment_id,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const tomorrow = isTomorrow(booking.bookingDate);

    // Email to Anthurium — failure here must never undo the confirmed booking.
    try {
      await transporter.sendMail({
        from: `"OutingGo Bookings" <${process.env.GMAIL_USER}>`,
        to: process.env.ANTHURIUM_BOOKING_EMAIL,
        subject: `${tomorrow ? "TOMORROW'S BOOKING — " : ""}NEW BOOKING – THE ANTHURIUM – ${bookingId}`,
        html: `
          <p>Hello The Anthurium Team,</p>
          <p>A new booking has been successfully confirmed through OutingGo.</p>
          ${tomorrow ? "<p><strong>IMPORTANT: This is TOMORROW'S booking.</strong></p>" : ""}
          <table cellpadding="6" style="border-collapse:collapse">
            <tr><td><strong>Booking ID</strong></td><td>${bookingId}</td></tr>
            <tr><td><strong>Booking Date</strong></td><td>${booking.bookingDate}</td></tr>
            <tr><td><strong>Customer Name</strong></td><td>${booking.customerName}</td></tr>
            <tr><td><strong>Mobile</strong></td><td>${booking.customerPhone}</td></tr>
            <tr><td><strong>Email</strong></td><td>${booking.customerEmail}</td></tr>
            <tr><td><strong>Guests</strong></td><td>${booking.guests}</td></tr>
            <tr><td><strong>Package</strong></td><td>${booking.packageName}</td></tr>
            <tr><td><strong>Special Requests</strong></td><td>${booking.specialRequests || "-"}</td></tr>
            <tr><td><strong>Total Amount</strong></td><td>Rs ${booking.totalAmount}</td></tr>
            <tr><td><strong>Payment Status</strong></td><td>PAID</td></tr>
          </table>
          <p>Regards,<br/>OutingGo</p>
        `,
      });
    } catch (mailErr) {
      console.error("Anthurium email failed (booking still confirmed):", mailErr);
    }

    // Email to customer
    try {
      await transporter.sendMail({
        from: `"OutingGo" <${process.env.GMAIL_USER}>`,
        to: booking.customerEmail,
        subject: `Booking Confirmed – The Anthurium – ${bookingId}`,
        html: `
          <p>Hi ${booking.customerName},</p>
          <p>Your booking at <strong>The Anthurium Resort</strong> is confirmed.</p>
          <table cellpadding="6" style="border-collapse:collapse">
            <tr><td><strong>Booking ID</strong></td><td>${bookingId}</td></tr>
            <tr><td><strong>Date</strong></td><td>${booking.bookingDate}</td></tr>
            <tr><td><strong>Guests</strong></td><td>${booking.guests}</td></tr>
            <tr><td><strong>Package</strong></td><td>${booking.packageName}</td></tr>
            <tr><td><strong>Amount Paid</strong></td><td>Rs ${booking.totalAmount}</td></tr>
          </table>
          <p>See you soon!<br/>OutingGo</p>
        `,
      });
    } catch (mailErr) {
      console.error("Customer email failed (booking still confirmed):", mailErr);
    }

    res.json({ success: true, bookingId, bookingStatus: "CONFIRMED" });
  } catch (err) {
    console.error("verify-payment error:", err);
    res.status(500).json({ error: "Could not verify payment." });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`OutingGo backend running on port ${PORT}`));
