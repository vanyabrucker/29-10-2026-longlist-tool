// The first exchange: Helios profiles the company from the user's message,
// then asks these questions one at a time before building the buyer lists.

export type ScopingQuestion = {
  /** Short name used in the answers message. */
  label: string;
  question: string;
  /** Preset answers; the card adds "Type your own" after them. */
  options: string[];
};

export const SCOPING_QUESTIONS: ScopingQuestion[] = [
  {
    label: "Geography",
    question: "Where should the buyer universe be?",
    options: ["Global", "Europe", "DACH"],
  },
  {
    label: "Buyer size",
    question: "How large should buyers be?",
    options: ["Big enough to fund the deal", "Any size", "Revenue above €1B"],
  },
  {
    label: "Exclude",
    question: "Who should I leave out?",
    options: [
      "Current owner and its investors",
      "Competitors in active talks",
      "No one",
    ],
  },
];

export const INTAKE_STEPS = [
  { at: 0, label: "Reading the company information" },
  { at: 0.22, label: "Matching the company in registries and databases" },
  { at: 0.5, label: "Mapping its sector and closest peers" },
  { at: 0.76, label: "Reviewing recent deals in the space" },
];

export const INTAKE_DURATION_MS = 6000;

// Plain-text version of the profile (for copying); IntakeMessage renders it.
export const INTAKE_TEXT = [
  "I've profiled the company and its market:",
  "- Sector: B2B software for industrial asset management, mostly recurring revenue.\n- Peers: 14 comparable companies, 9 of them acquired in the last five years.\n- Deal activity: steady consolidation by software platforms and growth investors since 2023.",
  "Three quick questions to scope the buyer universe.",
].join("\n\n");

/** The answers as one user message, one line per question. */
export const answersMessage = (answers: string[]) =>
  answers
    .map((a, i) => `${SCOPING_QUESTIONS[i]?.label ?? "Note"}: ${a}`)
    .join("\n");

/** "two global buyer lists", "two European buyer lists", … */
export function listsPhrase(geography?: string) {
  if (!geography || geography === "Global") return "two global buyer lists";
  if (geography === "Europe") return "two European buyer lists";
  if (geography === "DACH") return "two DACH buyer lists";
  return `two buyer lists for ${geography}`;
}
