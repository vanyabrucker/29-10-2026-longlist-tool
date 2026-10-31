// The Helbling team in the demo: the signed-in user plus the people in
// public/portraits. Used by Settings → Members and as longlist owners.

// The signed-in demo user; the name is hard-coded like the home greeting.
export const ME = { name: "Vanya Brucker", email: "vanya.brucker@helbling.ch" };

export type Member = {
  name: string;
  email: string;
  role: "Admin" | "Member";
  /** Portrait in public/portraits; initials otherwise. */
  photo?: string;
};

const person = (
  first: string,
  last: string,
  photo: string,
  role: Member["role"] = "Admin",
): Member => ({
  name: `${first} ${last}`,
  // firstname.lastname@helbling.ch, umlauts spelled out (ä → ae).
  email: `${first}.${last}@helbling.ch`
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue"),
  role,
  photo: `/portraits/${photo}.jpg`,
});

export const MEMBERS: Member[] = [
  { ...ME, role: "Admin" },
  person("Eduard", "Dorzweiler", "eduard_dorzweiler"),
  person("Gabriel", "Schmidhäusler", "gabriel_schmidhaeusler", "Member"),
  person("Ivor", "Kramer", "ivor_kramer"),
  person("Malte", "Jantz", "malte_jantz"),
  person("Nicolas", "Gubler", "nicolas_gubler"),
  person("Nuria", "Pantaleo", "nuria_pantaleo", "Member"),
];

/** A member by full name (owners in sample data refer to people by name). */
export const memberNamed = (name: string) =>
  MEMBERS.find((m) => m.name === name) ?? MEMBERS[0];
