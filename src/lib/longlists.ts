// Sample longlists for the Longlists page: earlier mandates of the team,
// fictional targets. Edit times are relative to now, so the list always
// reads as recent activity.

import type { BuyerList } from "./research";

export type LonglistItem = {
  id: string;
  /** The company being sold; the list is "<target> – <kind> buyers". */
  target: string;
  kind: BuyerList["id"];
  owner: string;
  /** Buyers on the list. */
  size: number;
  minutesAgo: number;
};

const H = 60;
const D = 24 * H;

export const LONGLISTS: LonglistItem[] = (
  [
    {
      target: "Nordlicht Cold Chain",
      kind: "strategic",
      owner: "Malte Jantz",
      size: 842,
      minutesAgo: 35,
    },
    {
      target: "Nordlicht Cold Chain",
      kind: "financial",
      owner: "Malte Jantz",
      size: 1118,
      minutesAgo: 52,
    },
    {
      target: "Alpenwerk Präzision",
      kind: "financial",
      owner: "Eduard Dorzweiler",
      size: 1436,
      minutesAgo: 3 * H + 10,
    },
    {
      target: "Vetora Clinics",
      kind: "strategic",
      owner: "Nuria Pantaleo",
      size: 512,
      minutesAgo: D + 2 * H,
    },
    {
      target: "Lumen Specialty Chemicals",
      kind: "strategic",
      owner: "Ivor Kramer",
      size: 977,
      minutesAgo: D + 6 * H,
    },
    {
      target: "Hofmann Verpackungen",
      kind: "financial",
      owner: "Vanya Brucker",
      size: 1284,
      minutesAgo: 2 * D + 3 * H,
    },
    {
      target: "Solano Renewables",
      kind: "financial",
      owner: "Nicolas Gubler",
      size: 2031,
      minutesAgo: 3 * D + 5 * H,
    },
    {
      target: "Peopleware HR Cloud",
      kind: "strategic",
      owner: "Gabriel Schmidhäusler",
      size: 1563,
      minutesAgo: 4 * D + H,
    },
    {
      target: "Dentalis Labor",
      kind: "financial",
      owner: "Vanya Brucker",
      size: 694,
      minutesAgo: 6 * D + 4 * H,
    },
    {
      target: "Aéro Composants",
      kind: "strategic",
      owner: "Eduard Dorzweiler",
      size: 388,
      minutesAgo: 9 * D,
    },
    {
      target: "Limmat Vermögensverwaltung",
      kind: "strategic",
      owner: "Nicolas Gubler",
      size: 241,
      minutesAgo: 12 * D + 7 * H,
    },
    {
      target: "Sensoria IoT",
      kind: "financial",
      owner: "Ivor Kramer",
      size: 1902,
      minutesAgo: 16 * D + 2 * H,
    },
    {
      target: "Bastion Cyber",
      kind: "strategic",
      owner: "Malte Jantz",
      size: 733,
      minutesAgo: 21 * D + 5 * H,
    },
    {
      target: "Polskie Składniki",
      kind: "financial",
      owner: "Nuria Pantaleo",
      size: 1057,
      minutesAgo: 34 * D,
    },
  ] satisfies Omit<LonglistItem, "id">[]
).map((item, i) => ({ ...item, id: `ll-${i}` }));
