// validation.js
// Every rule here is enforced server-side. Any matching validation in the client HTML is
// convenience-only (instant feedback) — the server never trusts it and re-checks everything.

const EMAIL_DOMAIN = '@creator.com';
const PASSWORD_RE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,20}$/;
const MIN_AGE = 13;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function validateEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized.endsWith(EMAIL_DOMAIN)) {
    return { ok: false, error: `Email must end with ${EMAIL_DOMAIN}` };
  }
  const local = normalized.slice(0, -EMAIL_DOMAIN.length);
  if (!/^[a-z0-9._-]{1,64}$/.test(local)) {
    return { ok: false, error: 'Email must be a valid creator.com address' };
  }
  return { ok: true, value: normalized };
}

function validatePassword(password) {
  if (typeof password !== 'string' || !PASSWORD_RE.test(password)) {
    return {
      ok: false,
      error: 'Password must be 8–20 characters with at least one uppercase letter, one lowercase letter, one number, and one special character (no emoji).',
    };
  }
  // Reject astral-plane characters (covers most emoji) even though the regex above doesn't.
  if (/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/u.test(password)) {
    return { ok: false, error: 'Password cannot contain emoji.' };
  }
  return { ok: true, value: password };
}

function calculateAge(birthdayStr) {
  const bday = new Date(birthdayStr);
  if (Number.isNaN(bday.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - bday.getFullYear();
  const m = today.getMonth() - bday.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < bday.getDate())) age--;
  return age;
}

function validateBirthday(birthdayStr) {
  const age = calculateAge(birthdayStr);
  if (age === null) return { ok: false, error: 'Enter a valid birthday.' };
  if (age < MIN_AGE) return { ok: false, error: `You must be at least ${MIN_AGE} to create an account.` };
  return { ok: true, value: birthdayStr, age };
}

function normalizeRecoveryKeyphrase(phrase) {
  // Trimming only the ends isn't enough for multi-word keyphrases: "creator  userkey" (two
  // spaces) and "creator userkey" (one space) look identical to a person typing it from memory
  // but would hash to different values and never match. Collapse all internal whitespace runs
  // to a single space too.
  return String(phrase || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function validateRecoveryKeyphrase(phrase) {
  const normalized = normalizeRecoveryKeyphrase(phrase);
  if (normalized.length < 6) {
    return { ok: false, error: 'Recovery keyphrase must be at least 6 characters.' };
  }
  return { ok: true, value: normalized };
}

function validateName(name) {
  const trimmed = String(name || '').trim();
  if (trimmed.length < 1 || trimmed.length > 50) {
    return { ok: false, error: 'Name must be between 1 and 50 characters.' };
  }
  return { ok: true, value: trimmed };
}

module.exports = {
  EMAIL_DOMAIN,
  PASSWORD_RE,
  MIN_AGE,
  normalizeEmail,
  validateEmail,
  validatePassword,
  calculateAge,
  validateBirthday,
  normalizeRecoveryKeyphrase,
  validateRecoveryKeyphrase,
  validateName,
};
