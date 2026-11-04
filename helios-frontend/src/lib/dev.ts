// Who sees the dev-only import area. Login is fake for now, so this is an
// allowlist of emails (NEXT_PUBLIC_DEV_EMAILS, comma-separated); swap it for a
// real role once real login exists.
const DEV_EMAILS = (
  process.env.NEXT_PUBLIC_DEV_EMAILS ??
  "vanya@helbling.ch,vanya.brucker@helbling.ch"
)
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

export const isDev = (email: string | null | undefined) =>
  !!email && DEV_EMAILS.includes(email.trim().toLowerCase());
