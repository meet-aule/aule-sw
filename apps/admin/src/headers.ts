// The headers on every answer: pages, files, the API, errors and the health
// probe. The pages load one module script and a stylesheet of their own, and
// nothing from anywhere else: no inline code, no analytics, no other site.

export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  // A Chromium browser then refuses any assignment of HTML from a string, on
  // top of the code never making one (test/page.test.mjs).
  "require-trusted-types-for 'script'",
  "trusted-types 'none'",
].join("; ");

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  // Files with their fingerprint are kept (assets.ts cacheFor); nothing else is.
  "Cache-Control": "no-store",
};
