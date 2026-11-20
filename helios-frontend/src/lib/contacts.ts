// Contacts from helios-gateway (GET /contacts, /contacts/{id}): people at
// companies and who at Helbling knows them. Types mirror the gateway's JSON.

import type { Cell } from "./corpus";
import { MEMBERS } from "./members";

/** A person's role at a company. */
export type ContactRole = {
  id: string;
  company_id: string | null;
  company_name: string | null;
  title: string | null;
  function: string | null;
  primary: boolean;
  /** False once the role's end date has passed. */
  current: boolean;
};

/** Someone at Helbling who knows the contact; `user` when it's a team member. */
export type KnownBy = { name: string; email: string | null; user: boolean };

export type Contact = {
  id: string;
  name: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  linkedin: string | null;
  /** Current roles, current first, then by company name. */
  roles: ContactRole[];
  known_by: KnownBy[];
  /** The role at the company asked about (a company's or a list row's contacts). */
  role?: ContactRole;
};

export type ContactPage = {
  total: number;
  offset: number;
  limit: number;
  items: Contact[];
};

export type ContactDetail = {
  id: string;
  name: string;
  cells: Cell[];
  /** Current and past roles, current first. */
  roles: (ContactRole & { cells: Cell[] })[];
  known_by: KnownBy[];
};

/** "Managing Director · Rheintal Growth Partners" (title, else function). */
export const contactRoleLine = (c: Contact | ContactRole): string => {
  const role = "roles" in c ? (c.role ?? c.roles[0]) : c;
  if (!role) return "";
  return [role.title ?? role.function, role.company_name]
    .filter(Boolean)
    .join(" · ");
};

/** A team member's portrait, matched by email. */
export const knownPhoto = (k: KnownBy) =>
  k.user && k.email
    ? MEMBERS.find((m) => m.email === k.email!.toLowerCase())?.photo
    : undefined;

/** The name the avatar's initials come from: given and family name, without
 * a title like "Dr." in front. */
export const initialsName = (c: Contact) =>
  [c.first_name, c.last_name].filter(Boolean).join(" ") || c.name;
