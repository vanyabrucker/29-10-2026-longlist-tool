"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

// Interface strings in English and German. Keys are the English text, with
// {name} placeholders; DE must translate every key (the type enforces it).
// Agent output (messages, intake, summaries, work-log steps, questions) and
// table data stay as written. German uses Swiss spelling (ss, not ß) and the
// formal "Sie", since Helbling is a Zurich firm.

export type Lang = "en" | "de";

const DE = {
  // Sidebar
  Home: "Startseite",
  Companies: "Unternehmen",
  Recents: "Zuletzt",
  Pin: "Anheften",
  Unpin: "Lösen",
  Rename: "Umbenennen",
  Delete: "Löschen",
  "Chat actions": "Chat-Aktionen",
  "Rename chat": "Chat umbenennen",
  Longlists: "Longlists",
  Imports: "Importe",
  "Search by list name or owner":
    "Nach Listenname oder Verantwortlichem suchen",
  Name: "Name",
  Owner: "Verantwortlich",
  Size: "Grösse",
  "Last edited": "Zuletzt bearbeitet",
  "{n} buyers": "{n} Käufer",
  "Today, {time}": "Heute, {time}",
  "Yesterday, {time}": "Gestern, {time}",
  "No longlists match “{query}”.": "Keine Longlists für «{query}» gefunden.",
  "Search by company name or website": "Nach Firmenname oder Website suchen",
  "Find companies instantly": "Unternehmen sofort finden",
  "Search companies by legal name or website for precise results.":
    "Suchen Sie nach Firmenname oder Website für präzise Ergebnisse.",
  Settings: "Einstellungen",
  "Sign out": "Abmelden",
  Profile: "Profil",
  Members: "Mitglieder",
  "Open sidebar": "Seitenleiste öffnen",
  "Collapse sidebar": "Seitenleiste einklappen",
  "Back to app": "Zurück zur App",
  "Helios home": "Helios Startseite",

  // Home and chat
  "Good morning, {name}": "Guten Morgen, {name}",
  "Good afternoon, {name}": "Guten Tag, {name}",
  "Good evening, {name}": "Guten Abend, {name}",
  "What’s your next move?": "Was ist Ihr nächster Schritt?",
  "Happy to Helbling": "Happy to Helbling",
  "Need a Helbling hand?": "Brauchen Sie eine Helbling-Hand?",
  "An Excel-lent day!": "Ein Excel-lenter Tag!",
  "Find new market entrants in Swiss solar installation":
    "Neue Marktteilnehmer in der Schweizer Solarinstallation finden",
  "Build a buyer longlist for a DACH packaging business":
    "Käufer-Longlist für ein DACH-Verpackungsunternehmen erstellen",
  "Who are the decision makers at mid-market PE funds in Milan?":
    "Wer entscheidet bei Mid-Market-PE-Fonds in Mailand?",
  "Track founder-led medtech companies preparing to raise":
    "Gründergeführte Medtech-Firmen vor einer Finanzierungsrunde verfolgen",
  "Ask Helios": "Helios fragen",
  "Message Helios": "Nachricht an Helios",
  "Send (Enter)": "Senden (Enter)",
  Send: "Senden",
  Stop: "Stoppen",
  "Stop generating": "Generierung stoppen",
  "Add attachment": "Anhang hinzufügen",
  "Upload a file": "Datei hochladen",
  "Add Excel file": "Excel-Datei hinzufügen",
  "Drop Excel file to add it to the conversation":
    "Excel-Datei hier ablegen, um sie der Unterhaltung hinzuzufügen",
  Spreadsheet: "Tabelle",
  File: "Datei",
  "Remove file": "Datei entfernen",
  More: "Mehr",
  "Scroll to latest": "Zur neuesten Nachricht",
  Copy: "Kopieren",
  Copied: "Kopiert",
  "Working… {time}": "Arbeitet… {time}",
  "Worked for {time}": "Gearbeitet: {time}",
  "Stopped after {time}": "Gestoppt nach {time}",
  Stopped: "Gestoppt",
  Dismiss: "Überspringen",
  Submit: "Senden",

  // Research table
  "Financial buyers": "Finanzinvestoren",
  "Strategic buyers": "Strategische Käufer",
  buyers: "Käufer",
  "Full screen": "Vollbild",
  "Exit full screen": "Vollbild beenden",
  Export: "Exportieren",
  Columns: "Spalten",
  "Version {n}": "Version {n}",
  "{n} changes": "{n} Änderungen",
  "Back to latest": "Zurück zur neuesten",
  "Select all rows": "Alle Zeilen auswählen",
  "Select {name}": "{name} auswählen",
  "Searching…": "Suche läuft…",
  "Buyer company information": "Unternehmensinformationen",
  "Deal activity": "Transaktionsaktivität",
  "Buyer profile": "Käuferprofil",
  "Buyer name": "Käufername",
  "Investor type": "Investorentyp",
  Sector: "Sektor",
  "Sub-sector": "Teilsektor",
  "Relevance explanation": "Begründung",
  "Relevance score": "Relevanz",
  "Deal count": "Anzahl Transaktionen",
  Financials: "Finanzzahlen",
  Revenue: "Umsatz",
  EBITDA: "EBITDA",
  AUM: "AUM",
  Employees: "Mitarbeitende",
  "Owner type": "Eigentümer",
  "Acquisition interest": "Akquisitionsinteresse",
  "Last deal": "Letzte Transaktion",
  Headquarters: "Hauptsitz",
  Founded: "Gründung",
  Website: "Website",
  "Owner likes Sauvignon": "Inhaber mag Sauvignon",
  "Remove column": "Spalte entfernen",
  "Remove row": "Zeile entfernen",
  "Remove rows": "Zeilen entfernen",
  "{n} selected": "{n} ausgewählt",
  "Clear selection": "Auswahl aufheben",
  "{label} column options": "Optionen für Spalte {label}",
  "Filter {label}...": "{label} filtern...",
  Filter: "Filtern",
  "Clear filter": "Filter entfernen",
  "Sort Ascending": "Aufsteigend sortieren",
  "Sort Descending": "Absteigend sortieren",
  "Clear Sort": "Sortierung entfernen",
  Latest: "Neueste",
  "Restore version {n}": "Version {n} wiederherstellen",
  "Restore this version": "Diese Version wiederherstellen",
  Quality: "Qualität",
  Changes: "Änderungen",
  "Restore version {n}?": "Version {n} wiederherstellen?",
  "This creates Version {next} with the contents of Version {n} ({message}). The current version stays in the history, so you can switch back anytime.":
    "Dadurch entsteht Version {next} mit dem Inhalt von Version {n} ({message}). Die aktuelle Version bleibt im Verlauf, Sie können jederzeit zurückwechseln.",
  Cancel: "Abbrechen",
  Restore: "Wiederherstellen",
  Agent: "Agent",

  // Data quality
  "Data quality": "Datenqualität",
  "Data quality details": "Details zur Datenqualität",
  High: "Hoch",
  Medium: "Mittel",
  Low: "Niedrig",
  Unknown: "Unbekannt",
  "High quality": "Hohe Qualität",
  "Medium quality": "Mittlere Qualität",
  "Low quality": "Niedrige Qualität",
  "Unknown quality": "Unbekannte Qualität",
  "Source confidence": "Quellenvertrauen",
  "High reliability": "Hohe Zuverlässigkeit",
  "Medium reliability": "Mittlere Zuverlässigkeit",
  "Low reliability": "Geringe Zuverlässigkeit",
  Freshness: "Aktualität",
  "Never checked": "Nie geprüft",
  "{n} day ago": "vor {n} Tag",
  "{n} days ago": "vor {n} Tagen",
  "{n} weeks ago": "vor {n} Wochen",
  "{n} months ago": "vor {n} Monaten",
  "{n} years ago": "vor {n} Jahren",
  "Proprietary data": "Proprietäre Daten",
  "Internal data": "Interne Daten",
  "Public data": "Öffentliche Daten",
  "View source": "Quelle öffnen",
  Source: "Quelle",
  Updated: "Aktualisiert",
  Current: "Aktuell",

  // Settings
  "Profile picture": "Profilbild",
  Email: "E-Mail",
  "Full name": "Vollständiger Name",
  Language: "Sprache",
  "Email of the new member": "E-Mail des neuen Mitglieds",
  Role: "Rolle",
  Add: "Hinzufügen",
  "(you)": "(Sie)",
  "Remove {name}": "{name} entfernen",
  "Remove {name}?": "{name} entfernen?",
  "They can no longer sign in. Data they imported or edited stays.":
    "Die Person kann sich nicht mehr anmelden. Von ihr importierte oder bearbeitete Daten bleiben erhalten.",
  Remove: "Entfernen",
  "{email} was added": "{email} wurde hinzugefügt",
  "Share this password with them. It's shown only this once.":
    "Teilen Sie dieses Passwort mit der Person. Es wird nur dieses eine Mal angezeigt.",
  Done: "Fertig",
  "A user with this email exists already.":
    "Ein Benutzer mit dieser E-Mail-Adresse existiert bereits.",
  "Enter a valid email address.":
    "Bitte geben Sie eine gültige E-Mail-Adresse ein.",
  Member: "Mitglied",
  Admin: "Admin",
  Dev: "Dev",

  // Login
  "First-move intelligence": "First-Move-Intelligence",
  "for Helbling": "für Helbling",
  "100M+ Companies": "100 Mio.+ Unternehmen",
  "Global database": "Globale Datenbank",
  "Complete Data": "Vollständige Daten",
  "Internal, proprietary, public": "Intern, proprietär, öffentlich",
  "Real-time Data": "Echtzeitdaten",
  "Live search for anything": "Live-Suche nach allem",
  "Verified Data": "Verifizierte Daten",
  "SOC 2 compliant": "SOC-2-konform",
  "Enter your email...": "E-Mail-Adresse eingeben...",
  Continue: "Weiter",
  "Don't have an account?": "Noch kein Konto?",
  "Request access": "Zugang anfordern",
  Password: "Passwort",
  "Enter your password...": "Passwort eingeben...",
  "Wrong email or password.": "E-Mail-Adresse oder Passwort falsch.",
  "The server isn't reachable. Try again in a moment.":
    "Der Server ist nicht erreichbar. Bitte versuchen Sie es gleich nochmals.",
  "Couldn't save. Try again.": "Speichern fehlgeschlagen. Bitte nochmals versuchen.",
} satisfies Record<string, string>;

export type MessageKey = keyof typeof DE;
export type Translate = (
  key: MessageKey,
  vars?: Record<string, string | number>,
) => string;

// English month abbreviations in data dates ("30 Oct 2026") and German ones.
const MONTHS_DE: Record<string, string> = {
  Jan: "Jan.",
  Feb: "Feb.",
  Mar: "März",
  Apr: "Apr.",
  May: "Mai",
  Jun: "Juni",
  Jul: "Juli",
  Aug: "Aug.",
  Sep: "Sept.",
  Oct: "Okt.",
  Nov: "Nov.",
  Dec: "Dez.",
};

// The chosen language lives in localStorage, shared by every component
// through a tiny external store (no provider needed).
const STORAGE_KEY = "helios-lang";
const listeners = new Set<() => void>();

function readLang(): Lang {
  try {
    return localStorage.getItem(STORAGE_KEY) === "de" ? "de" : "en";
  } catch {
    return "en";
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setLang(lang: Lang) {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {}
  document.documentElement.lang = lang;
  listeners.forEach((l) => l());
}

export function useI18n() {
  // English on the server and the first paint, then the stored choice.
  const lang = useSyncExternalStore(subscribe, readLang, () => "en" as Lang);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const t: Translate = useCallback(
    (key, vars) => {
      const text: string = lang === "de" ? DE[key] : key;
      return vars
        ? text.replace(/\{(\w+)\}/g, (m, name) =>
            name in vars ? String(vars[name]) : m,
          )
        : text;
    },
    [lang],
  );

  /** 1,662 in English, 1’662 in (Swiss) German. */
  const formatNumber = useCallback(
    (n: number) => n.toLocaleString(lang === "de" ? "de-CH" : "en-US"),
    [lang],
  );

  /** Swaps English month abbreviations in a data date for German ones. */
  const formatDate = useCallback(
    (date: string) =>
      lang === "de"
        ? date.replace(/\b[A-Z][a-z]{2}\b/g, (m) => MONTHS_DE[m] ?? m)
        : date,
    [lang],
  );

  return { lang, setLang, t, formatNumber, formatDate };
}
