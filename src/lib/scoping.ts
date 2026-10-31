// The first exchange: Helios reads the company from the user's message,
// replies with a buyer profile per list, then asks FLOW_QUESTIONS in the
// question card before building the lists.

export type ScopingQuestion = {
  /** Short name used in the answers message. */
  label: string;
  question: string;
  /** Preset answers; the card adds a free-text row after them. */
  options: string[];
  /** Placeholder of the free-text row (default "Type your own"). */
  custom?: string;
};

/** Asked after the buyer profile; "Yes" is the default. */
export const CONFIRM_QUESTIONS: ScopingQuestion[] = [
  {
    label: "Scope",
    question: "Build both longlists on this basis?",
    options: ["Yes"],
    custom: "Refine the scope",
  },
];

// The questions the demo flow asks. The geography set below is kept for
// later use but isn't in the flow.
export const FLOW_QUESTIONS = CONFIRM_QUESTIONS;

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
  { at: 0.18, label: "Scoping the buyer universe" },
  { at: 0.4, label: "Matching the company in registries and databases" },
  { at: 0.6, label: "Mapping its sector and closest peers" },
  { at: 0.8, label: "Reviewing recent deals in the space" },
];

export const INTAKE_DURATION_MS = 7000;

// The intake reply: a short read of the target, then a buyer profile per
// list. IntakeMessage renders it; INTAKE_TEXT is the copyable version.
export type ProfilePoint = { label: string; text: string };

export const INTAKE = {
  intro:
    "Consilio is an SAP Gold Partner from Aschheim near Munich: more than 200 consultants across ten sites in Germany, Switzerland, Bulgaria and the US, covering the full SAP lifecycle up to S/4HANA, with a niche in supply chain management and production planning for industrial clients. At typical consulting productivity that points to roughly €35–45M revenue and an enterprise value of about €30–60M. Here's who could buy it:",
  profiles: [
    {
      title: "Strategic buyers",
      points: [
        {
          label: "Size",
          text: "revenue of at least €200M, about five times Consilio's, so a deal of this size is a bolt-on rather than a bet on the company.",
        },
        {
          label: "Interest",
          text: "same or adjacent sector: SAP and ERP consultancies, IT service groups and supply chain software vendors that want S/4HANA capacity, production planning know-how, industrial clients or a nearshore base in Bulgaria.",
        },
        {
          label: "Financing",
          text: "enough dry powder to pay for it: net cash or leverage below about 2.5× EBITDA, undrawn credit lines, or an owner that funds add-ons. A recent deal of similar size is a strong signal.",
        },
      ],
    },
    {
      title: "Financial buyers",
      points: [
        {
          label: "Investment scope",
          text: "a published focus on IT services, B2B services or software in DACH, ideally with succession or majority deals, or a platform Consilio could join as an add-on.",
        },
        {
          label: "Ticket size",
          text: "equity tickets of about €15–60M, or a target range of €3–15M EBITDA. Large-cap funds only through a portfolio company.",
        },
        {
          label: "Stage",
          text: "buyout and growth investors. Venture funds publish their stages (seed to Series B, for example), and a mature, profitable consultancy falls outside them.",
        },
      ],
    },
  ] satisfies { title: string; points: ProfilePoint[] }[],
  outro:
    "If this profile works for you, I'll build both longlists and score every buyer for fit.",
};

export const INTAKE_TEXT = [
  INTAKE.intro,
  ...INTAKE.profiles.map(
    (p) =>
      `${p.title}\n${p.points.map((pt) => `- ${pt.label}: ${pt.text}`).join("\n")}`,
  ),
  INTAKE.outro,
].join("\n\n");

/** The answers as one user message: a single answer as is, several as one
 *  "Label: answer" line each. */
export const answersMessage = (answers: string[]) =>
  answers.length === 1
    ? answers[0]
    : answers
        .map((a, i) => `${FLOW_QUESTIONS[i]?.label ?? "Note"}: ${a}`)
        .join("\n");

/** The geography answer, when the flow asked for one. */
export function geographyFrom(answers?: string[]) {
  const i = FLOW_QUESTIONS.findIndex((q) => q.label === "Geography");
  return i < 0 ? undefined : answers?.[i];
}

/** "two global buyer lists", "two European buyer lists", … */
export function listsPhrase(geography?: string) {
  if (!geography || geography === "Global") return "two global buyer lists";
  if (geography === "Europe") return "two European buyer lists";
  if (geography === "DACH") return "two DACH buyer lists";
  return `two buyer lists for ${geography}`;
}
