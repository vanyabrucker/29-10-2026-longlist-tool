<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Helios — project notes

Clickable **frontend-only demo** of an M&A deal-sourcing assistant ("Helios", built for the client Helbling). There is no backend: auth, conversations and AI answers are all fake. Don't add APIs, databases or real auth unless asked.

## Stack

- Next.js 16 (App Router, Cache Components on), React 19, Tailwind CSS v4 (CSS-first `@theme` in `src/app/globals.css`, no tailwind config file).
- Icons: **Feather only**, via `react-feather`. If Feather lacks an icon, pick the closest Feather one and say so; don't add another icon set.
- Animation: `motion` (`motion/react`).
- Fonts (Google, via `next/font`): **Lora** (serif) for headings, the wordmark and the chat title, **DM Sans** for everything else.

## Architecture

- `src/app/login/page.tsx`: login screen. Any email "logs in" (stored in localStorage, see `src/lib/auth.ts`).
- `src/app/(app)/layout.tsx` renders `<Sidebar>` and `<Workspace>`. The route pages under `(app)` (`/` and `/c/[id]`) render `null` and set `export const instant = false`. Keep it this way: the layout staying mounted is what lets the sidebar avoid remounting and the composer animate from home to chat.
- `src/components/Workspace.tsx`: home and chat in one tree. The mode comes from the URL plus an optimistic `pending` id, so the switch is instant on submit.
- `src/lib/chat.tsx`: in-memory conversations and a fake streaming answer. Reloading a chat URL redirects home; that's intended.
- The sidebar reads `useChatList()` (titles only), never `useChat()`, so it doesn't re-render on every streamed token.
- `src/lib/useDismiss.ts`: shared outside-click/Escape handling for popovers.
- Settings (`/settings/profile`, `/settings/members`, `/settings` = profile): the route pages render `null` like the others; the `(app)` layout shows `SettingsPanel` (`src/components/Settings.tsx`) instead of `Workspace` on `/settings*`.

## Design rules (from the owner's feedback)

- **Palette:** greys, white, black and light blue only. Tokens live in `globals.css`: `ink`, `canvas`, `line`, `subtle`, `muted`, `faint`, `sky` (#dbe9fb: stripe, avatar, focus ring), `brand` (#c4d9f6: logo and loader only), `sky-ink`, `sheet` (#00a552: green, only for the active table-tab icon, which is Feather `Table`). `good` (#00a552 green), `warn` (#ef9e00 amber) and `bad` (#e24947 red) are only for data-quality dots and status. They are tuned in OKLCH to match `sky-ink`'s saturation, with green and red at its lightness; keep new accent colours in that family. Good data never gets a colour.
- **Favicon:** `src/app/icon.svg`, the same blue square as the logo.
- **Logo:** a plain square in `brand` blue with **sharp corners**, the `Logo` component. Never an image or a "G" mark. It appears in the sidebar and on login, not in the chat input.
- **Text size:** UI text is 13–15px. Reference screenshots may be retina/zoomed (the login reference was about 1.4×), so derive sizes from the actual viewport and don't copy pixel values blindly.
- **Precise alignment matters.** The owner notices 1–5px misalignments. Examples:
  - Optically centre icons against text cap height, not the line box (see the `-top-[3.5px]` on the login logo).
  - The copy button's hover background is flush with the message text (no negative margin).
- **No shadows** on the chat input. Popovers get a soft shadow, `border-line`, `rounded-xl` and `p-1`, with 36px rows.
- **Tooltips:** black background (`bg-ink`), white 12px text.
- **Feature labels** on login: the title and the subtext are one line each (`whitespace-nowrap`).
- **Login hero photo** (`public/login-background.png`) always fills the full panel height and crops the sides; keep a dark overlay so the white copy stays readable.

## Behaviour rules

- Chat input is a multiline textarea: **Cmd/Ctrl+Enter sends, Enter inserts a newline.** Hovering send shows a tooltip "Enter" with ⌘ ↵ key icons.
- Home greeting is randomised per visit: "Good morning/afternoon/evening, Vanya" or a tagline ("What's your next move?", "Happy to Helbling", "Better than CoPilot", "Need a Helbling hand?"). The name is hard-coded for now.
- User messages: light grey bubble. AI messages: plain text with no bubble, and a copy button underneath (tooltip "Copy"; on click the icon pops into a check and the tooltip hides).
- The chat title (from the first message) shows in serif (Lora) in the main header (there is no search bar; the header is otherwise empty), with a gradient fade under the header. The thread has the mirrored fade at the bottom, so messages fade out as they scroll under the composer.
- The step list behind "Working… / Worked for Ns" (research and intake) sits in one box: `border-line`, `rounded-xl`, `px-3 py-2.5`.
- Thinking loader: the logo square split 3×3; corners, edges and centre fade as groups (hollow → corners → X → dot → plus → full), about 0.62s per cycle in ~59ms steps: corners, X, dot and plus hold one step each, the hollow square holds half a step, the full square only passes through, and each of the six fades takes one step.
- The sidebar collapses to a 52px rail. When collapsed, hovering the logo morphs it into the sidebar icon, and clicking it expands the sidebar again.
- Conversation flow (`src/lib/chat.tsx`):
  - The demo pastes a short description of **Consilio** (an SAP consultancy, a real past Helbling mandate where BWK was the buyer). Chats starting "Name: …" are titled "<Name> Buyer Longlist" ("Consilio Buyer Longlist"), otherwise by the first seven words. New chats start untitled and the title streams in letter by letter after ~0.7s (`streamTitle`), in the sidebar and the header at the same time.
  - The 1st reply is an **intake** message (`IntakeMessage`, `runIntake`): "Working… Ns" through `INTAKE_STEPS` (2nd step "Scoping the buyer universe") for `INTAKE_DURATION_MS` (7s), then `INTAKE` in `src/lib/scoping.ts`: a read of Consilio, then a buyer profile per list. Strategic: size (revenue ≥ ~5× the target), interest (same/adjacent sector), financing (dry powder). Financial: published investment scope, ticket size, stage (VCs publish stages; a mature consultancy is outside them). It ends with "If this profile works for you, I'll build both longlists…".
  - Then the `QuestionCard` floats above the composer (soft shadow, `mb-2`): "Build both longlists on this basis?" with a "Dismiss Esc" button in its header and the preset answer "Yes" (highlighted, its number badge turning white, with an ↵ key cap). The composer stays and is the free-text answer; its placeholder stays the default "Ask Helios", and sending it answers the question. While the composer is empty, Enter picks the highlighted answer, arrows move and Esc dismisses; number keys pick only when the composer isn't focused, so typed text starting with a digit never picks an answer. No "1 of 1" counter for a single question. Any answer posts as the user message and starts the **fake research run** (`runResearch`, `RESEARCH_DURATION_MS` 11s, progress 0→1); the demo clicks Yes. Dismissing hides the card and the next message starts research. Later messages get plain canned answers.
  - The earlier three questions (Geography, Buyer size, Exclude: `SCOPING_QUESTIONS`) are kept but not in the flow. The summary only follows a geography answer if the flow asks one (`geographyFrom`).
- Research view:
  - The chat column squashes to 420px (`CHAT_COLUMN`), the conversation title moves into that column's header, and the empty 50px main header collapses to 0 so the chat column and the table start at the top, and the composer switches to its boxed `panel` variant (no disclaimer line).
  - `ResearchTable` slides in from the right and fills its rows and count as progress advances.
  - The table panel copies the reference layout: tabs, title with bell and "New", V4/Export, serif count, find, columns, grouped sticky headers, a sticky checkbox and name column, and horizontal scroll.
  - Hovering a truncated cell shows its full text wrapped in a white box over the cell (max 320px wide). Don't use native `title` tooltips. Safari adds its own tooltip to any ellipsis-truncated text; the `TRUNCATE` class (an empty block `::after`) suppresses it.
  - Hovering a truncated cell shows its full text wrapped in a white box over the cell (max 320px wide). Don't use native `title` tooltips. Safari adds its own tooltip to any ellipsis-truncated text; the `TRUNCATE` class (an empty block `::after`) suppresses it.
  - The full-screen button lifts the table into a fixed layer that grows to cover the whole window, including the sidebar and header (`useFullscreen` in `ResearchTable.tsx`). It animates top/left/width/height rather than scale so the text doesn't distort. Esc or the button returns it to its slot.
  - Links in the summary switch the table tab.
- Version history per list (the `vN` dropdown, like a commit log):
  - The button reads "Version 4" with a clock icon.
  - Each entry shows "Version N", a "Latest" pill on the newest, author ("Agent" or "Vanya Brucker"), date, commit message and "Changes N" (cells changed).
  - Selecting an older version shows that version's diff in the table: removed text grey (`faint`) and struck through, added text plain black (no colours or backgrounds); a changed cell shows the old value struck through before the new one. A banner offers "Back to latest".
  - The restore button (corner-up-left, tooltip "Restore this version") opens a confirm dialog only; restoring isn't implemented.
- Data quality (`src/lib/quality.ts`, `src/components/DataQuality.tsx`):
  - Each cell has fake, deterministic source confidence C and freshness F (field-specific half-life), giving an overall score Q = C·F/100. The levels are High (about 85%), Medium, Low and Unknown. Unknown means no verification date; it is not the same as bad.
  - Wording: High/Medium/Low/Unknown first; 0–100 numbers only in the hover card, the details and the panel.
  - In the table:
    - Only flagged cells get a 7px dot 12px in, and only those cells inset their text to 28px (`DOT_TEXT_INSET`). Other cells keep their normal padding.
    - Hovering adds a "Quality" row to the full-text preview. It shows no reason text.
    - Clicking expands that same box (no second popover). The dot geometry matches the cell exactly: dots at 12px, text at 28px.
    - The expanded box is a dot table: Quality as the head row, then Source confidence and Freshness. Each dot is coloured by its own score; grey notes ("Low reliability", "7 days ago") sit on the same row.
    - Below that is a small sources table (Source / Updated) with several sources per cell. The one the value comes from is marked "Current". Each source has a grey category icon in the dot column (centred on the dots, tooltip on hover): `DollarSign` proprietary (S&P Capital IQ, Moody's Orbis), `Briefcase` internal (fictional names such as "Project Cedar – Longlist" or "Helbling CRM"; not `Home`, which is the sidebar's Home; no real client names), `Globe` public (domain shown). Proprietary and internal sources show their name, public ones their domain. No "Verified by" column (removed on request). Cells have 1–4 sources (mostly one or two), exactly one current, listed first. A last column holds an `ExternalLink` button (tooltip "View source") that opens the source in a new tab; the URLs are placeholders on example.com, never real sites.
    - The expanded box only shifts left if it would leave the window.
    - The box stays open until an outside click, Escape or scroll. There's no evidence link and no disclaimer.
    - Markers are hidden while viewing an older version's diff.
  - The "Data quality" toolbar button shows the overall score (e.g. "Data quality 80") with no status dot. It opens a minimal panel with no title: score out of 100 and the High/Medium/Low/Unknown distribution. No issue lists, filters, trends or recommendations (removed on request).
  - The Version dropdown shows each version's quality score. There's no per-column quality (decided against).
- Buyer data (`src/lib/research.ts`) fits the Consilio mandate: investors on one side, SAP consultancies, IT service groups and supply chain/engineering firms on the other, with sector-fitting names. The top buyers (`FEATURED`) are written by hand with detailed rationales (100–200 words for the best fits) and are always high quality (no flags); the rest come from seeded templates with shorter rationales and fit scores capped at 76, so featured buyers stay on top. Lists are sorted by fit, and the table starts sorted by Fit score descending (arrow in that header); Clear Sort returns to the generated order, which is also by fit.
  - Columns: Buyer types, Inclusion rationale, **Fit score** (0–100, right after the rationale), deal activity, profile.
  - Everything is fictional except **BWK GmbH Unternehmensbeteiligungsgesellschaft** (the real buyer of Consilio, which the demo must show). Its facts come from public sources (Stuttgart, founded 1990, majority and minority stakes in Mittelstand companies, bwk.de); its deal count is illustrative and its AUM "Not disclosed". Don't add other real company names.
  - Long cell text gets a 480px-wide hover box, and a box that would leave the window moves up just enough to fit.
- Settings: the user menu's "Settings" opens `/settings/profile`. The sidebar's middle (nav and recents) slides out to the left while the settings nav slides in from the right (logo row and user menu stay put); going back reverses it. The settings nav has a back arrow (to home) left of a serif "Settings" title, then Profile and Members.
  - Profile: one bordered card with Profile picture (initial avatar), Email (text only, no edit), Full name (input) and Language (English/German dropdown). The user is hard-coded as Vanya Brucker, vanya.brucker@helbling.ch.
  - Members: no subtitle. Invite row (placeholder `name@helbling.ch`; email, Member/Admin dropdown, black Invite; inert) above the member rows. Members are the people in `public/portraits` (small JPEGs; browsers other than Safari can't show TIFF, so convert any new portrait with `sips -s format jpeg -Z 192`), emails `firstname.lastname@helbling.ch` with umlauts spelled out. Everyone is Admin except Gabriel and Nuria (Member). Role pills share the invite row's grid column: Admin `bg-sky text-sky-ink`, Member grey.
- **Third message (scope change, `runRefine` in `chat.tsx`):** the first message after the lists are built (whatever its text; the demo asks for "Only European companies" plus an "Owner likes Sauvignon" column, a joke requirement) runs a refine pass over `REFINE_DURATION_MS` (9s) through `REFINE_STEPS`. `refineStage` in `research.ts` drives the table: buyers headquartered outside Europe (", US") drop out first, then the "Owner likes Sauvignon" column (Yes/No/Unknown, ~60% Unknown) appears right after Fit score and fills top-down while the table scrolls it into view, then fit is rescored (yes +2, no −20, unknown unchanged), every rationale gets a sentence about it, and the lists become **Version 5** (Agent, "Europe only; added Owner likes Sauvignon"). Unknown cells have unknown quality (grey dot). BWK is real, so its owners' preference is always Unknown and it stays on top. The new column has a 1px `sky-ink` outline until the next agent reply (`refine.highlight`). Older versions show the pre-refine rows without the column. Stopping the pass undoes it; the next message reruns it. Later messages get canned answers.
- **Manual edits:** selecting rows shows a black bar over the table ("N selected · Remove row(s) · ×"); the column ⋮ menu has "Remove column" (not for the name column). Removals apply to the latest version only, are kept per table session, and don't create versions.
- **Stop:** while a reply runs (thinking, streaming, intake or research), the composer's send arrow becomes a black stop button with a white square (tooltip "Stop"). `stopGenerating` in `chat.tsx` clears that conversation's timers (tracked per conversation; the title stream is separate and keeps going) and keeps what's there: partial text, the steps reached ("Stopped after Ns"), and the rows the table had loaded. A reply stopped before it started shows "Stopped". Stopping the intake skips the question card; the next message starts research.
- **Languages (i18n):** `src/lib/i18n.ts` holds every interface string; keys are the English text with `{name}` placeholders, and the `DE` map must translate each (the type enforces it). Use `const { t, formatNumber, formatDate } = useI18n()`; type label fields as `MessageKey`. The choice (Settings → Profile → Language: English/Deutsch) is stored in localStorage and shared through an external store, so there's no provider; `<html lang>` follows it. German uses Swiss spelling (ss, no ß), the formal "Sie", and Swiss numbers (1'662). **Agent output stays as written** in both languages: messages, the intake, summaries, work-log steps, question-card questions and options, chat titles, table data and version commit messages. Only the dates in data are localised (month names).
- Non-demo controls (Companies, Contacts, upload, sample recents, Invite) are present but inert. There are no projects (the sidebar section and the home "Choose project" chip were removed on request). Keep them inert rather than inventing pages.

## Working conventions

- Verify UI changes visually, not just with `tsc`/lint. A quick way: a throwaway Playwright script (`playwright-core` with the system Chrome at `/Applications/Google Chrome.app`) that logs in, then screenshots at 1440×900, DPR 2. Keep such tooling out of the project's dependencies.
- **Tailwind v4 pitfall:** don't put a `/* comment */` on the same line as a `--color-*` token inside `@theme`; Tailwind silently drops the token. Put comments on their own line.
- If styles look stale after editing `globals.css`, restart `next dev`.
- `LayoutProps`/`PageProps` are generated types. If `tsc` can't find them, run `next build` or `next dev` once.
- When an instruction is ambiguous (e.g. which element "the rectangle" is, or the direction of an "inset"), take the most conventional reading and say what you assumed in one line, so it's quick to correct.
