// email.js
const nodemailer = require('nodemailer');

let transporterPromise = null;
let lastDevEmail = null; // exposed via a dev-only endpoint so the reset flow is testable end-to-end without a real inbox

function getTransporter() {
  if (transporterPromise) return transporterPromise;

  if (process.env.SMTP_HOST) {
    transporterPromise = Promise.resolve(
      nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: process.env.SMTP_SECURE === 'true',
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
      })
    );
  } else {
    // DEV MODE: no SMTP_HOST configured. nodemailer's jsonTransport formats the message
    // without sending anything over the network — nothing leaves the server. The content is
    // logged and kept in memory (see getLastDevEmail) so the reset-via-email flow can actually
    // be exercised end-to-end during local development. Set SMTP_HOST (and SMTP_PORT,
    // SMTP_USER, SMTP_PASS, MAIL_FROM) in .env once you have a real provider — the dev-only
    // endpoint that exposes getLastDevEmail is automatically disabled the moment SMTP_HOST is
    // set, so there's no way for it to leak into a real deployment.
    transporterPromise = Promise.resolve(nodemailer.createTransport({ jsonTransport: true }));
  }
  return transporterPromise;
}

async function sendMail({ to, subject, text, html }) {
  const transporter = await getTransporter();
  const info = await transporter.sendMail({
    from: process.env.MAIL_FROM || 'no-reply@creator.com',
    to,
    subject,
    text,
    html,
  });
  if (!process.env.SMTP_HOST) {
    lastDevEmail = { to, subject, text, html, sentAt: new Date().toISOString() };
    console.log(`[email:DEV MODE] Would send to ${to}: ${subject}\n${text}`);
  }
  return info;
}

function getLastDevEmail() {
  return lastDevEmail;
}

function isDevMode() {
  return !process.env.SMTP_HOST;
}

module.exports = { sendMail, getLastDevEmail, isDevMode };
