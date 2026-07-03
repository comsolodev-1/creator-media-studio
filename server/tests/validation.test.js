// tests/validation.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateEmail,
  validatePassword,
  validateBirthday,
  validateRecoveryKeyphrase,
  normalizeRecoveryKeyphrase,
  validateName,
} = require('../validation');

test('validateEmail requires @creator.com', () => {
  assert.equal(validateEmail('someone@gmail.com').ok, false);
  assert.equal(validateEmail('someone@creator.com').ok, true);
});

test('validateEmail normalizes case', () => {
  const result = validateEmail('Someone@Creator.com');
  assert.equal(result.ok, true);
  assert.equal(result.value, 'someone@creator.com');
});

test('validatePassword enforces all character classes', () => {
  assert.equal(validatePassword('weak').ok, false);
  assert.equal(validatePassword('alllowercase1!').ok, false); // no uppercase
  assert.equal(validatePassword('ALLUPPERCASE1!').ok, false); // no lowercase
  assert.equal(validatePassword('NoNumbers!').ok, false);
  assert.equal(validatePassword('NoSpecial1').ok, false);
  assert.equal(validatePassword('Str0ng!Pass1').ok, true);
});

test('validatePassword rejects emoji', () => {
  assert.equal(validatePassword('Str0ng!Pass😀').ok, false);
});

test('validatePassword enforces length bounds', () => {
  assert.equal(validatePassword('Sh0rt!').ok, false); // under 8
  assert.equal(validatePassword('A'.repeat(25) + '1!').ok, false); // over 20
});

test('validateBirthday enforces minimum age of 13', () => {
  const tooYoung = new Date();
  tooYoung.setFullYear(tooYoung.getFullYear() - 10);
  assert.equal(validateBirthday(tooYoung.toISOString().slice(0, 10)).ok, false);

  const oldEnough = new Date();
  oldEnough.setFullYear(oldEnough.getFullYear() - 20);
  assert.equal(validateBirthday(oldEnough.toISOString().slice(0, 10)).ok, true);
});

test('validateRecoveryKeyphrase requires at least 6 characters', () => {
  assert.equal(validateRecoveryKeyphrase('short').ok, false);
  assert.equal(validateRecoveryKeyphrase('long enough').ok, true);
});

// Regression test for the real bug reported and fixed in this project: a multi-word
// keyphrase typed with a different number of spaces between words at recovery time than at
// signup time used to fail to match, even though it's the same phrase to a person.
test('normalizeRecoveryKeyphrase collapses internal whitespace (regression: recovery mismatch bug)', () => {
  assert.equal(normalizeRecoveryKeyphrase('my recovery phrase'), 'my recovery phrase');
  assert.equal(normalizeRecoveryKeyphrase('my    recovery     phrase'), 'my recovery phrase');
  assert.equal(normalizeRecoveryKeyphrase('  my recovery phrase  '), 'my recovery phrase');
  assert.equal(normalizeRecoveryKeyphrase('My Recovery Phrase'), 'my recovery phrase');
  // All four variants above must normalize to the exact same string, or recovery breaks.
  const variants = ['my recovery phrase', 'my    recovery     phrase', '  my recovery phrase  ', 'My Recovery Phrase'];
  const normalized = variants.map(normalizeRecoveryKeyphrase);
  assert.ok(normalized.every((v) => v === normalized[0]));
});

test('validateName enforces length bounds', () => {
  assert.equal(validateName('').ok, false);
  assert.equal(validateName('A'.repeat(51)).ok, false);
  assert.equal(validateName('Jae').ok, true);
});
