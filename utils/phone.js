const { httpError } = require('./httpError');

// Same country table as the frontend (lib/phone.js). The country code decides how many digits a number needs.
// min / max: digits AFTER the country code.
const COUNTRIES = [
  { code: 'NG', name: 'Nigeria', dial: '234', min: 10, max: 10, trunk: true },
  { code: 'GH', name: 'Ghana', dial: '233', min: 9, max: 9, trunk: true },
  { code: 'KE', name: 'Kenya', dial: '254', min: 9, max: 9, trunk: true },
  { code: 'ZA', name: 'South Africa', dial: '27', min: 9, max: 9, trunk: true },
  { code: 'TZ', name: 'Tanzania', dial: '255', min: 9, max: 9, trunk: true },
  { code: 'UG', name: 'Uganda', dial: '256', min: 9, max: 9, trunk: true },
  { code: 'RW', name: 'Rwanda', dial: '250', min: 9, max: 9, trunk: true },
  { code: 'ET', name: 'Ethiopia', dial: '251', min: 9, max: 9, trunk: true },
  { code: 'ZM', name: 'Zambia', dial: '260', min: 9, max: 9, trunk: true },
  { code: 'ZW', name: 'Zimbabwe', dial: '263', min: 9, max: 9, trunk: true },
  { code: 'CM', name: 'Cameroon', dial: '237', min: 9, max: 9, trunk: false },
  { code: 'SN', name: 'Senegal', dial: '221', min: 9, max: 9, trunk: false },
  { code: 'CI', name: "Côte d'Ivoire", dial: '225', min: 10, max: 10, trunk: false },
  { code: 'EG', name: 'Egypt', dial: '20', min: 10, max: 10, trunk: true },
  { code: 'MA', name: 'Morocco', dial: '212', min: 9, max: 9, trunk: true },
  { code: 'US', name: 'United States / Canada', dial: '1', min: 10, max: 10, trunk: false },
  { code: 'GB', name: 'United Kingdom', dial: '44', min: 9, max: 10, trunk: true },
  { code: 'DE', name: 'Germany', dial: '49', min: 10, max: 11, trunk: true },
  { code: 'FR', name: 'France', dial: '33', min: 9, max: 9, trunk: true },
  { code: 'ES', name: 'Spain', dial: '34', min: 9, max: 9, trunk: false },
  { code: 'IT', name: 'Italy', dial: '39', min: 9, max: 10, trunk: false },
  { code: 'NL', name: 'Netherlands', dial: '31', min: 9, max: 9, trunk: true },
  { code: 'IN', name: 'India', dial: '91', min: 10, max: 10, trunk: true },
  { code: 'PK', name: 'Pakistan', dial: '92', min: 10, max: 10, trunk: true },
  { code: 'AE', name: 'United Arab Emirates', dial: '971', min: 9, max: 9, trunk: true },
  { code: 'SA', name: 'Saudi Arabia', dial: '966', min: 9, max: 9, trunk: true },
  { code: 'CN', name: 'China', dial: '86', min: 11, max: 11, trunk: false },
  { code: 'BR', name: 'Brazil', dial: '55', min: 10, max: 11, trunk: true },
  { code: 'MX', name: 'Mexico', dial: '52', min: 10, max: 10, trunk: false },
];


const BY_LONGEST_DIAL = [...COUNTRIES].sort((a, b) => b.dial.length - a.dial.length);

// A comparable key for any saved number. Numbers saved before country codes existed
// (0803...) are treated as Nigerian.
function phoneKey(stored) {
  const text = String(stored || '').trim();
  const digits = text.replace(/\D/g, '');
  if (!digits) return '';
  if (text.startsWith('+')) return digits;
  if (digits.startsWith('0')) return `234${digits.slice(1)}`;
  if (digits.startsWith('234') && digits.length >= 13) return digits;
  return `234${digits}`;
}

// Checks a phone number sent to the API (international form, e.g. +2348031234567)
// and returns it cleaned up. Throws a 400 if the digit count is wrong for the country.
function normalizePhone(raw) {
  const text = String(raw || '').trim();
  if (!/^\+[\d\s().-]+$/.test(text)) {
    throw httpError(400, 'Phone number must start with the country code, e.g. +2348031234567');
  }
  const digits = text.replace(/\D/g, '');

  const country = BY_LONGEST_DIAL.find((c) => digits.startsWith(c.dial));
  if (country) {
    const national = digits.length - country.dial.length;
    if (national < country.min || national > country.max) {
      const need = country.min === country.max ? `${country.min}` : `${country.min}-${country.max}`;
      throw httpError(400, `${country.name} phone numbers have ${need} digits after +${country.dial}. You entered ${national}.`);
    }
  } else if (digits.length < 8 || digits.length > 15) {
    throw httpError(400, 'Phone number must be 8 to 15 digits including the country code');
  }

  return `+${digits}`;
}

module.exports = { COUNTRIES, normalizePhone, phoneKey };
