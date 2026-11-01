/**
 * Disposable / temporary email detection.
 *
 * Sign-up is blocked when the email domain belongs to a known throwaway
 * provider (mailinator, 10minutemail, yopmail, ...) or matches obvious
 * temp-mail patterns. This complements email verification: verification proves
 * the address exists, this keeps one-time inboxes out in the first place.
 *
 * The list is intentionally conservative — well-known disposable providers and
 * clear patterns only, so real businesses are never blocked.
 */

const DISPOSABLE_DOMAINS = new Set<string>([
  // Major throwaway providers
  'mailinator.com', 'mailinator.net', 'mailinator2.com', 'notmailinator.com',
  '10minutemail.com', '10minutemail.net', '10minutemail.org', '10minemail.com',
  'tempmail.com', 'tempmail.net', 'tempmail.org', 'tempmail.dev', 'temp-mail.org', 'temp-mail.io', 'temp-mail.ru',
  'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'guerrillamail.de', 'sharklasers.com', 'grr.la',
  'yopmail.com', 'yopmail.fr', 'yopmail.net', 'cool.fr.nf', 'jetable.fr.nf',
  'throwawaymail.com', 'throwaway.email', 'trashmail.com', 'trashmail.net', 'trashmail.de', 'trash-mail.com',
  'getnada.com', 'nada.email', 'dispostable.com', 'maildrop.cc', 'mailnesia.com', 'mailcatch.com',
  'mohmal.com', 'mohmal.im', 'mohmal.tech', 'emailondeck.com', 'fakeinbox.com', 'mailnull.com',
  'spamgourmet.com', 'spam4.me', 'spambog.com', 'spambox.us', 'spamex.com', 'spamfree24.org',
  'mytemp.email', 'mytempemail.com', 'tempr.email', 'discard.email', 'discardmail.com', 'wegwerfmail.de',
  'mail-temporaire.fr', 'email-temp.com', 'tempinbox.com', 'tempinbox.co.uk', 'instantemailaddress.com',
  'throwam.com', 'kurzepost.de', 'objectmail.com', 'proxymail.eu', 'rcpt.at', 'wegwerfmail.net',
  'mailmetrash.com', 'thankyou2010.com', 'trash2009.com', 'mt2009.com', 'trashymail.com', 'trashymail.net',
  'uggsrock.com', 'binkmail.com', 'bobmail.info', 'chammy.info', 'devnullmail.com', 'letthemeatspam.com',
  'lookugly.com', 'lortemail.dk', 'smellfear.com', 'sofort-mail.de', 'sogetthis.com', 'spamavert.com',
  'spamherelots.com', 'spamhereplease.com', 'supergreatmail.com', 'teewars.org', 'teleworm.us',
  'tempemail.net', 'tempemail.co.za', 'temporaryemail.net', 'temporaryinbox.com', 'thankyou2010.com',
  'veryrealemail.com', 'viditag.com', 'viewcastmedia.com', 'webemail.me', 'whyspam.me', 'willhackforfood.biz',
  'wronghead.com', 'wuzup.net', 'xagloo.com', 'xemaps.com', 'xents.com', 'xmaily.com', 'xoxy.net',
  'yep.it', 'yogamaven.com', 'yopmail.gq', 'ypmail.webarnak.fr.eu.org', 'yuurok.com', 'zehnminutenmail.de',
  'zippymail.info', 'zoaxe.com', 'zoemail.org', 'mailforspam.com', 'safetymail.info', 'spam.la',
  'throwawaymail.net', 'mailtemp.info', 'clipmail.eu', 'deadaddress.com', 'despam.it', 'dumpmail.de',
  'e4ward.com', 'emailias.com', 'emailinfive.com', 'emailmiser.com', 'emailproxsy.com', 'emailsensei.com',
  'emailtemporario.com.br', 'emailthe.net', 'emailtmp.com', 'emailwarden.com', 'emailx.at.hm', 'emailxfer.com',
]);

// Patterns that are almost always disposable-mail services. Kept narrow enough
// that legitimate domains (e.g. "templates.co.tz") never match.
const DISPOSABLE_PATTERNS: RegExp[] = [
  /^(10|20|30)?minutemail\./i,
  /^(temp|temporary|throwaway|trash|junk|fake|spam|disposable)[-_.]?(mail|email|inbox|address|box)?\./i,
  /\.(temp|temporary|throwaway|trash|junk|fake|spam|disposable)[-_.]?(mail|email|inbox|address|box)?$/i,
  /(mailinator|guerrillamail|yopmail|sharklasers|getnada|dispostable|maildrop|mailnesia|tempmail)/i,
];

export function isDisposableEmail(email: string | null | undefined): boolean {
  const value = String(email || '').trim().toLowerCase();
  const at = value.lastIndexOf('@');
  if (at === -1) return false;
  const domain = value.slice(at + 1).replace(/\.$/, '');
  if (!domain) return false;

  if (DISPOSABLE_DOMAINS.has(domain)) return true;

  // Also match subdomains of listed providers (e.g. inbox.mailinator.com).
  for (const d of DISPOSABLE_DOMAINS) {
    if (domain.endsWith(`.${d}`)) return true;
  }

  return DISPOSABLE_PATTERNS.some((re) => re.test(domain));
}

export const DISPOSABLE_EMAIL_MESSAGE =
  'Please use a permanent email address — temporary/disposable emails are not allowed.';
