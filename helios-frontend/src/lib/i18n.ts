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
  "Delete chat?": "Chat löschen?",
  "Delete “{title}”? This cannot be undone.":
    "«{title}» löschen? Das lässt sich nicht rückgängig machen.",
  "Chat actions": "Chat-Aktionen",
  "Rename chat": "Chat umbenennen",
  Longlists: "Longlists",
  Contacts: "Kontakte",
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
  "No longlists yet. Import a spreadsheet onto a new list to start one.":
    "Noch keine Longlists. Importieren Sie eine Tabelle in eine neue Liste, um eine anzulegen.",
  "Couldn't load longlists": "Longlists konnten nicht geladen werden",
  "Back to longlists": "Zurück zu den Longlists",
  "Longlist not found": "Longlist nicht gefunden",
  "No buyers on this version.": "Diese Version enthält keine Käufer.",
  "Edited by {name}": "Bearbeitet von {name}",
  "Open company": "Unternehmen öffnen",
  Close: "Schliessen",
  "Search by name, website or what a company does":
    "Nach Name, Website oder Tätigkeit suchen",
  "Nothing matches these filters. Try removing one.":
    "Nichts passt zu diesen Filtern. Entfernen Sie einen.",
  "Nothing matches “{query}”. Try other words, part of the name or the website.":
    "Nichts passt zu «{query}». Versuchen Sie andere Wörter, einen Teil des Namens oder die Website.",
  Location: "Standort",
  Regions: "Regionen",
  Countries: "Länder",
  "Buyer type": "Käufertyp",
  Strategic: "Strategisch",
  Financial: "Finanzinvestor",
  "Clear filters": "Filter zurücksetzen",
  "Remove filter": "Filter entfernen",
  "No sectors in the data yet.": "Noch keine Branchen in den Daten.",
  "Other currencies are compared at approximate fixed rates.":
    "Andere Währungen werden zu festen Näherungskursen verglichen.",
  "Include companies without a figure": "Auch Unternehmen ohne Angabe",
  Currency: "Währung",
  Min: "Min.",
  Max: "Max.",
  Any: "Beliebig",
  m: "Mio.",
  DACH: "DACH",
  Europe: "Europa",
  EU: "EU",
  Nordics: "Nordische Länder",
  Benelux: "Benelux",
  "UK & Ireland": "UK & Irland",
  "North America": "Nordamerika",
  "Asia-Pacific": "Asien-Pazifik",
  "{n} company": "{n} Unternehmen",
  "{n} companies": "{n} Unternehmen",
  "Couldn't load companies": "Unternehmen konnten nicht geladen werden",
  "No companies found": "Keine Unternehmen gefunden",
  "No companies yet": "Noch keine Unternehmen",
  "Companies appear here once a spreadsheet is imported.":
    "Unternehmen erscheinen hier, sobald eine Tabelle importiert wurde.",
  "Show more": "Mehr anzeigen",
  "Back to companies": "Zurück zu den Unternehmen",
  "Unnamed company": "Unbenanntes Unternehmen",
  "up to {n}": "bis {n}",
  "Company not found": "Unternehmen nicht gefunden",
  // Contacts
  "{n} contact": "{n} Kontakt",
  "{n} contacts": "{n} Kontakte",
  "Search by name, company, title or email":
    "Nach Name, Unternehmen, Titel oder E-Mail suchen",
  "Couldn't load contacts": "Kontakte konnten nicht geladen werden",
  "No contacts found": "Keine Kontakte gefunden",
  "Nothing matches “{query}”. Try part of a name, a company, a title or an email.":
    "Nichts passt zu «{query}». Versuchen Sie einen Teil eines Namens, ein Unternehmen, einen Titel oder eine E-Mail.",
  "No contacts yet": "Noch keine Kontakte",
  "Contacts appear here once people are added to the corpus.":
    "Kontakte erscheinen hier, sobald Personen im Datenbestand erfasst sind.",
  Title: "Titel",
  Phone: "Telefon",
  LinkedIn: "LinkedIn",
  "Copy link": "Link kopieren",
  "Copy email": "E-Mail kopieren",
  "Copy phone number": "Telefonnummer kopieren",
  "Known by": "Bekannt bei",
  "Known by {names}": "Bekannt bei {names}",
  "Unnamed contact": "Unbenannter Kontakt",
  "Back to contacts": "Zurück zu den Kontakten",
  "Contact not found": "Kontakt nicht gefunden",
  "No companies recorded": "Keine Unternehmen erfasst",
  "No one at Helbling recorded": "Niemand bei Helbling erfasst",
  Former: "Ehemals",
  "{n} source": "{n} Quelle",
  "{n} sources": "{n} Quellen",
  "Prioritized by {name}": "Priorisiert von {name}",
  Value: "Wert",
  Prioritize: "Priorisieren",
  "Remove priority": "Priorität entfernen",
  Yes: "Ja",
  No: "Nein",
  Settings: "Einstellungen",
  "Sign out": "Abmelden",
  Profile: "Profil",
  Members: "Mitglieder",
  Impressum: "Impressum",
  "Helios is built with the open-source software, icons and fonts below. Their notices are reproduced here as their licences require.":
    "Helios basiert auf der unten aufgeführten Open-Source-Software sowie den Icons und Schriften. Deren Hinweise sind hier abgedruckt, wie es ihre Lizenzen verlangen.",
  "Icons and software": "Icons und Software",
  "These icons and this software are licensed under the":
    "Diese Icons und diese Software stehen unter der",
  Fonts: "Schriften",
  "These fonts are licensed under the":
    "Diese Schriften stehen unter der",
  "Other packages": "Weitere Pakete",
  "The packages these depend on carry their own licences, mostly MIT and ISC.":
    "Die Pakete, von denen diese abhängen, haben eigene Lizenzen, überwiegend MIT und ISC.",
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
  "Web research": "Webrecherche",
  "Source {n}": "Quelle {n}",
  Copied: "Kopiert",
  "Working… {time}": "Arbeitet… {time}",
  "Worked for {time}": "Gearbeitet: {time}",
  "Stopped after {time}": "Gestoppt nach {time}",
  "Failed after {time}": "Fehlgeschlagen nach {time}",
  Stopped: "Gestoppt",
  Dismiss: "Überspringen",
  Query: "Query",
  Submit: "Senden",

  // Research table
  "Financial buyers": "Finanzinvestoren",
  "Strategic buyers": "Strategische Käufer",
  buyers: "Käufer",
  "Full screen": "Vollbild",
  "Exit full screen": "Vollbild beenden",
  Export: "Exportieren",
  "Export options": "Exportoptionen",
  "Full export": "Vollständiger Export",
  "Client export": "Kunden-Export",
  Columns: "Spalten",
  "Version {n}": "Version {n}",
  "{n} change": "{n} Änderung",
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
  "Added by {name}": "Hinzugefügt von {name}",
  "Double-click to edit": "Doppelklick zum Bearbeiten",
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
  "Couldn't save. Try again.":
    "Speichern fehlgeschlagen. Bitte nochmals versuchen.",
  // Import dialog (list imports, chat drops, corpus imports)
  Import: "Importieren",
  Upload: "Hochladen",
  "Map columns": "Spalten zuordnen",
  Review: "Prüfen",
  "Import {file}": "{file} importieren",
  "Into the corpus": "In den Datenbestand",
  "Into {list}": "In {list}",
  "Into a new list: {list}": "In eine neue Liste: {list}",
  "Into a list": "In eine Liste",
  "Uploading…": "Wird hochgeladen…",
  Company: "Unternehmen",
  Person: "Person",
  "Role (person at company)": "Rolle (Person im Unternehmen)",
  Transaction: "Transaktion",
  "Project reference": "Projektreferenz",
  "Longlist entry": "Longlist-Eintrag",
  "Not imported": "Nicht importieren",
  "Helios ID (row id)": "Helios-ID (Zeilen-ID)",
  "The hidden Helios ID column is missing, so rows were matched by company and rows deleted from the file can't be detected.":
    "Die ausgeblendete Spalte «Helios ID» fehlt. Die Zeilen wurden deshalb über das Unternehmen zugeordnet, und aus der Datei gelöschte Zeilen lassen sich nicht erkennen.",
  "New column": "Neue Spalte",
  "New column “{name}”": "Neue Spalte «{name}»",
  "This list": "Diese Liste",
  "Other data points": "Weitere Datenpunkte",
  "Recognised as a Helios export, but its hidden Helios ID column is missing: rows will be matched by company.":
    "Als Helios-Export erkannt, aber die ausgeblendete Spalte «Helios ID» fehlt: Die Zeilen werden über das Unternehmen zugeordnet.",
  "Recognised as a Helios export: columns and rows match by their ids.":
    "Als Helios-Export erkannt: Spalten und Zeilen werden über ihre IDs zugeordnet.",
  "Check where each column of the file goes.":
    "Prüfen Sie, wohin jede Spalte der Datei gehört.",
  "Data as of": "Datenstand",
  "{reason} as row {n}": "{reason} wie Zeile {n}",
  "Same as row {n}": "Gleich wie Zeile {n}",
  "Don't import this value": "Diesen Wert nicht importieren",
  "Import this value again": "Diesen Wert wieder importieren",
  "Choose a source…": "Quelle wählen…",
  "Choose where the data is from to continue.": "Wählen Sie, woher die Daten stammen, um fortzufahren.",
  "Search data points": "Datenpunkte suchen",
  "No matching data point": "Kein passender Datenpunkt",
  "dd.mm.yyyy": "TT.MM.JJJJ",
  "Pick a date": "Datum wählen",
  "Not a valid date": "Kein gültiges Datum",
  "Previous month": "Vorheriger Monat",
  "Next month": "Nächster Monat",
  "Earlier years": "Frühere Jahre",
  "Later years": "Spätere Jahre",
  "Choose a year": "Jahr wählen",
  "Back to the days": "Zurück zu den Tagen",
  Today: "Heute",
  "Import this table": "Diese Tabelle importieren",
  "{n} row": "{n} Zeile",
  "{n} rows": "{n} Zeilen",
  Empty: "Leer",
  "Column {letter} goes to": "Spalte {letter} geht nach",
  "Why this column": "Warum diese Zuordnung",
  Suggested: "Vorschlag",
  "No suggestion": "Kein Vorschlag",
  "Corrections or additional context": "Korrekturen oder zusätzlicher Kontext",
  Optional: "Optional",
  "Add transformation": "Umwandlung hinzufügen",
  "Edit transformation": "Umwandlung bearbeiten",
  "Treat as empty": "Als leer behandeln",
  "Combine with columns": "Mit Spalten zusammenführen",
  Scale: "Skalieren",
  "Empty: {values}": "Leer: {values}",
  "Combined with {columns}": "Zusammengeführt mit {columns}",
  "× 1,000": "× 1'000",
  "× 1,000,000": "× 1'000'000",
  "Values to treat as empty, separated by commas":
    "Werte, die als leer gelten, durch Kommas getrennt",
  "e.g. n/a, unknown, -": "z. B. k. A., unbekannt, -",
  Separator: "Trennzeichen",
  Apply: "Anwenden",
  "Transformations of column {letter}": "Umwandlungen der Spalte {letter}",
  "e.g. Column F contains EBITDA, not revenue.":
    "z. B. Spalte F enthält das EBITDA, nicht den Umsatz.",
  "Re-run mapping": "Zuordnung neu vorschlagen",
  "Confirm mapping": "Zuordnung bestätigen",
  "New rows": "Neue Zeilen",
  "Changed cells": "Geänderte Zellen",
  Conflicts: "Konflikte",
  "Lower-scored values": "Schwächer bewertete Werte",
  Errors: "Fehler",
  "Matches, duplicates and per-row decisions are in the full report.":
    "Zuordnungen, Duplikate und Entscheide pro Zeile stehen im vollständigen Bericht.",
  "Open the full report": "Vollständigen Bericht öffnen",
  "Back to mapping": "Zurück zur Zuordnung",
  "Finish without changes": "Ohne Änderungen abschliessen",
  "Exported by {name} on {date} (version {n}). Each cell is compared with what was exported, so edits made in Helios since then are kept.":
    "Exportiert von {name} am {date} (Version {n}). Jede Zelle wird mit dem exportierten Wert verglichen, sodass Änderungen in Helios seither erhalten bleiben.",
  "Not a Helios export: rows were matched by company, and values that differ from the list count as new data from this file.":
    "Kein Helios-Export: Zeilen wurden über das Unternehmen zugeordnet, abweichende Werte gelten als neue Daten aus dieser Datei.",
  empty: "leer",
  "Changed in Helios and in the file since the export":
    "Seit dem Export in Helios und in der Datei geändert",
  "When exported": "Beim Export",
  "Keep Helios": "Helios behalten",
  "Use the file": "Datei übernehmen",
  "Missing from the file": "In der Datei nicht mehr vorhanden",
  "Rows that were exported but aren't in the file any more":
    "Exportierte Zeilen, die in der Datei fehlen",
  Keep: "Behalten",
  "{n} from the file": "{n} aus der Datei",
  "Company in Helios": "Unternehmen in Helios",
  "Not in Helios yet": "Noch nicht in Helios",
  "{n} cells": "{n} Zellen",
  "Skipped; fix them in the file":
    "Übersprungen; bitte in der Datei korrigieren",
  "Row {n}": "Zeile {n}",
  "{n} cells changed in Helios since the export stay as they are.":
    "{n} seit dem Export in Helios geänderte Zellen bleiben, wie sie sind.",
  "Your edit": "Ihre Änderung",
  "From the file": "Aus der Datei",
  "Imported as version v{n}": "Als Version v{n} importiert",
  "Imported as version {n} of the list": "Als Version {n} der Liste importiert",
  "Nothing changed, so no new version was made":
    "Nichts geändert, deshalb keine neue Version",
  "Every change is part of that version; restore an older one from the version menu to undo it.":
    "Alle Änderungen gehören zu dieser Version; stellen Sie über das Versionsmenü eine ältere wieder her, um sie rückgängig zu machen.",
  // Chat drops
  "Drop a spreadsheet to import it":
    "Tabelle hier ablegen, um sie zu importieren",
  "Into a new list": "In eine neue Liste",
  "Into this chat’s list": "In die Liste dieses Chats",
  "Only spreadsheets can be imported (.xlsx, .xlsm, .xls, .xlsb, .ods, .csv).":
    "Nur Tabellen lassen sich importieren (.xlsx, .xlsm, .xls, .xlsb, .ods, .csv).",
  "1 cell changed in Helios since the export stays as it is.":
    "1 seit dem Export in Helios geänderte Zelle bleibt, wie sie ist.",
  "1 cell": "1 Zelle",
  "Import Excel": "Excel importieren",
  "Turn web search on": "Websuche einschalten",
  New: "Neu",
  "Values that differ from the list count as new data from this file.":
    "Werte, die von der Liste abweichen, gelten als neue Daten aus dieser Datei.",
  "Turn web search off": "Websuche ausschalten",
  "Import into…": "Importieren in…",
  "New list": "Neue Liste",
  "Where is this data from?": "Woher stammen diese Daten?",
  "Which source?": "Welche Quelle?",
  "Say which source “Other” is to continue.":
    "Geben Sie an, welche Quelle «Andere» ist, um fortzufahren.",
  "e.g. a broker's list": "z. B. Liste eines Brokers",
  "Also add to a longlist": "Auch zu einer Longlist hinzufügen",
  None: "Keine",
  "New list…": "Neue Liste…",
  "New list name": "Name der neuen Liste",
  "e.g. Project Cedar – Buyers": "z. B. Projekt Cedar – Käufer",
  "This exact file was uploaded before ({when}).":
    "Genau diese Datei wurde schon einmal hochgeladen ({when}).",
  "Upload anyway": "Trotzdem hochladen",
  "Import 1 row": "1 Zeile importieren",
  "Import {n} rows": "{n} Zeilen importieren",
  "Certain match": "Sichere Übereinstimmung",
  "Likely match": "Wahrscheinliche Übereinstimmung",
  "Possible match": "Mögliche Übereinstimmung",
  "New company": "Neues Unternehmen",
  "New contact": "Neuer Kontakt",
  "Duplicate in the file": "Doppelt in der Datei",
  All: "Alle",
  Matches: "Übereinstimmungen",
  Duplicates: "Duplikate",
  "Lower-scored": "Schwächer bewertet",
  "Formulas without a saved result: {cells}":
    "Formeln ohne gespeichertes Ergebnis: {cells}",
  "Columns left out": "Ausgelassene Spalten",
  "Not imported; map them to bring them in":
    "Nicht importiert; ordnen Sie sie zu, um sie zu übernehmen",
  Rows: "Zeilen",
  "{n} of {total} will be imported": "{n} von {total} werden importiert",
  "No rows here.": "Hier gibt es keine Zeilen.",
  "Show values": "Werte anzeigen",
  "same as {row}": "wie {row}",
  Contact: "Kontakt",
  "Decision for row {n}": "Entscheidung für Zeile {n}",
  "Create a new company": "Neues Unternehmen anlegen",
  "Merge into {name}": "Mit {name} zusammenführen",
  "Same as {row}": "Wie {row}",
  "Skip this row": "Zeile überspringen",
  Skipped: "Übersprungen",
  "Data point": "Datenpunkt",
  "Imported as": "Importiert als",
  "Against the shown value": "Gegenüber dem angezeigten Wert",
  derived: "abgeleitet",
  "Replaces “{value}” ({score})": "Ersetzt «{value}» ({score})",
  "“{value}” ({score}) stays; kept as another source":
    "«{value}» ({score}) bleibt; als weitere Quelle behalten",
  "Same value (adds a source)": "Gleicher Wert (zusätzliche Quelle)",
  // Chat feedback
  "How is Helios doing in this chat?": "Wie macht sich Helios in diesem Chat?",
  Bad: "Schlecht",
  Fine: "Okay",
  Good: "Gut",
  "Thanks. Anything to add? (optional)": "Danke. Möchten Sie etwas ergänzen? (optional)",
  "What went well or wrong?": "Was lief gut oder schlecht?",
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
