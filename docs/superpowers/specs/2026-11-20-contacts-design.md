# Contacts — design

Date: 2026-11-20. Status: draft for approval.

## Why

In the old Excel longlists, contacts were among the most important columns: who
to call at each buyer, and who at Helbling knows them. Each contact took a block
of columns (Contact person 1 name, role, phone, email, contact lead), repeated
for Contact 2, 3, … That reads crowded. Helios should show one **Contacts**
column with names, open a contact's details on click, and expand back to the
column blocks in the Excel export. People also need their own place in the app,
a **Contacts** page next to Companies and Longlists.

## Decisions made with the owner

- **Contacts belong to the corpus, not to a list.** A person is linked to
  companies globally; every list containing a company shows that company's
  contacts, and so does the company page.
- **Relationship, not "contact lead".** For now it only says "this Helbling
  person knows this contact" (the owner's word: *knows*). No strength, kind or
  history yet; those are later iterations.
- **Approach A**: build on the corpus's existing `person` and `role` entities
  (append-only observations with sources, quality, versions, revert), not a
  separate contacts table.
- **Contacts arrive through imports only**, and that import work (reading
  "Contact 1 / Contact 2…" blocks) is **not part of this change**; the owner
  builds it later. This change uses dummy data. Manual entry, email or LinkedIn
  sync are later.

## Goals

1. Data model for relationships ("X at Helbling knows this person").
2. Read API for contacts: a searchable list, a contact's detail, a company's
   contacts.
3. Frontend: Contacts page (sidebar), contact detail page, contacts on the
   company page.
4. Longlists: a Contacts column whose cell lists names; a click opens the
   details.
5. Full export spreads contacts into numbered column blocks; the client
   export's "Helbling Contact" column gets filled.
6. Dummy contacts for development.

## Non-goals

- Importing contacts from spreadsheets (repeated column blocks), and reading the
  export's contact columns back in. Re-importing an export must keep working,
  with its contact columns ignored.
- Adding or editing contacts in the UI.
- Relationship strength, kinds, last interaction, email/LinkedIn sync.
- The agent seeing or using contacts (see Agent below).

## Anti-goals

- A second, unversioned place where contact data lives. Every contact value has
  a source and can be reverted, like company values.
- A crowded list table: no column per contact field in the app.
- Guessing: a contact field with no value stays empty; nothing is filled in.

## Approaches considered

- **A. Corpus entities (chosen).** People and roles already exist in
  `app/catalogue.py` and `app/models.py` (`Entity.kind` person/role, role links
  `person_id` + `company_id`), the corpus import already creates one person and
  role per row with matching by email/LinkedIn/name+company
  (`app/ingest/match.py`, `app/ingest/commit.py`). Every value keeps source,
  as-of date, quality and revert. Cost: list cells and export read contacts from
  the corpus as of a version, like corpus columns already do.
- **B. Separate contacts table, linked to companies.** Simpler CRUD, but no
  provenance, no revert, and contacts would behave unlike every other value.
  The owner leaned towards it at first, then chose A as the better structure.
- Within A, for the relationship: a **`known_by` data point on the person**
  (list value) was rejected, because observations compete and the best one
  wins: two sources saying "Vanya knows her" and "Marc knows her" must add up,
  not replace each other. Hence its own entity (below).

## Data model

- **New entity kind `relationship`**: a child of a person, `Entity.person_id` =
  the contact. Add it to `Entity` in `catalogue.py`; no table change (the
  `entities` table already has `person_id`).
- **New data point `helbling_person`** (entity `relationship`, type text,
  label "Known by"): the Helbling team member's name or email as written by the
  source. No half-life (a fact, not perishable data) — builder may revisit.
- One relationship entity per (contact, Helbling person). Matching key for later
  imports: same contact + same normalised name/email. A relationship whose
  observations are all retracted no longer shows (revert works for free).
- **Resolving the Helbling person to a user**: at read time, match the value to
  `users` by email, else by exact full name (case-insensitive). A match shows
  the member's name and portrait; otherwise the text as written (former staff,
  typos). Never stored as a foreign key, so imports with plain names work.
- **Current contacts of a company**: role entities with that `company_id` whose
  shown `end_date` is empty or in the future. Ended roles show on the contact's
  page only.
- **Visibility follows live observations** (my call, from the builder check):
  entity rows are never retracted, only observations. So a person shows only
  while they have at least one live observation; a role shows only while its
  person does and it has a live observation; a relationship likewise. For an
  older list version, "live" is as of its `corpus_version` (same rule as
  `corpus_cells`, plus `Entity.created_version_id <= corpus_version`). Every
  contacts query (company page, list cell, export, `/contacts`) uses one shared
  helper for this. The seed always writes at least one observation per role
  (title or function) so its revert removes everything.
- **Kept out of imports for now** (my call): relationship data points are
  hidden from the import mapper (`as_prompt()`, the mapping dropdown) until the
  contact-import work, and `report._row` / `commit.py` get a guard that refuses
  a relationship mapping with a clear error instead of a KeyError. Tested.
- Bump `CATALOGUE_VERSION`. No schema change: the entity kind is a string.

## API (gateway)

New module `app/contacts.py` (read logic) with routes in the companies API style.

- `GET /contacts?q=&company_id=&known_by=&offset=&limit=` → `{total, offset,
  limit, items}`. Each item: person id, full name (or first + last), current
  roles (company id + name, title, falling back to function), email, phone,
  LinkedIn, known by (list of {name, email?, user?}). Search: case-insensitive
  match on name, email, title and company name (pg_trgm/ILIKE over shown values;
  no embeddings, the corpus of people is small). Sorted by name.
- `GET /contacts/{id}` → like `GET /companies/{id}`: `cells` per data point with
  shown value, quality, sources (reuse the same cell-building code), plus
  `roles` (each with its company and its own role cells) and `relationships`.
- `GET /companies/{id}` gains `contacts`: the current contacts in the item shape
  above (replacing the bare `people` id list, which no UI uses — builder to
  confirm with grep).
- All need a signed-in user, like companies.

## Longlists

- **A real list column**, key `contacts`, source `contacts`, type `contacts`,
  label "Contacts". Read-only: `set` on it is a `ListError` ("Contacts come from
  the corpus and can't be edited on a list."). It can be removed, re-ordered and
  restored like any column. `column_spec()` and `AddColumn` assume catalogue
  keys, so `contacts` gets an explicit special case there.
- New lists (`create_list`) get it right after the name/main fact block.
  Existing lists get it through a data migration that writes **one new list
  version per list**, author `Helios`, message "Added the Contacts column", so
  diffs and history stay honest (no history rewrite). Decided with the owner:
  the migration **keeps each list's `updated_at`** (last edited and the
  Longlists order don't change). It runs in SQL with frozen logic, like other
  migrations (close/insert `list_columns`, positions, `list_versions` with
  `corpus_version` and `changes`, `head_version`). Pending list imports on those
  lists go stale once and get their review rebuilt; accepted. The Version menu
  shows the `Helios` author with the `brand` square, like the agent's circle
  but square (frontend special case).
- `table()` fills the cell per row with a corpus company: `{"value": [names],
  "contacts": [items]}` in the `/contacts` item shape, as of the version's
  `corpus_version` for older versions (same `live()` rule as `corpus_cells`),
  live on the latest. Rows without a corpus company have no contacts. Contacts
  are not part of the list diff or change count.
- Frontend (`LonglistTable.tsx`): the cell shows the names, comma-separated,
  truncated like other cells; primary contact first, then by name. A click opens
  a popover (popover rules: `rounded-xl`, `border-line`, soft shadow) listing
  each contact: name, title · company, email (mailto), phone (tel), LinkedIn,
  "Known by Vanya Brucker, …", and a link to the contact page. Double-click does
  nothing (no edit). Same in the chat's research panel (it reuses
  `LonglistDetail`).
- Update `helios-frontend/AGENTS.md` (it says "There are no projects or
  contacts") and both AGENTS.md files for the new parts.

## Contacts page and contact page (frontend)

- Sidebar: "Contacts" after Longlists, Feather `Users` icon, route `/contacts`,
  shown by `AppShell` like Companies.
- `/contacts`: serif title with count, search field ("Search by name, company,
  title or email", debounced 200ms, kept in `?q=`), table: Name (avatar
  initials), Company, Title, Email, Phone, Known by (portraits/initials of
  matched users, else names). 50 per page, "Show more". Empty states as on
  Companies ("No contacts found" / "No contacts yet").
- `/contacts/[id]`: back arrow + serif name, muted subline (title · company),
  one bordered card with a row per data point, expanding to sources exactly like
  the company page (reuse `QualityRow`, `SourceIcon`), a "Companies" section
  (current and past roles, linking to the company), and "Known by".
- Company page: a "Contacts" card under the data points, one row per current
  contact (name, title, email, phone, known by), each linking to the contact.
- All strings in `i18n.ts` with German (Swiss spelling, "Sie"). Prioritize
  buttons on contact sources are out of scope unless the pin API takes person
  entities as-is (builder checks `app/corpus.py`; if it is company-only, leave
  them out).

## Export

- **Full export**: the Contacts column expands into blocks, as many as the most
  contacts on any row: "Contact person 1 name", "Contact person 1 role",
  "Contact person 1 phone", "Contact person 1 email", "Contact person 1
  relationship" (Helbling people who know them, comma-separated), then 2, 3…
  Same order as the cell. Recorded in `list_exports.columns` with `key` null
  (display-only), so `premap` skips them on re-import and they never become new
  columns. No contact columns when no row has contacts.
- **Client export**: "Helbling Contact" = the Helbling people who know any
  current contact at the company, comma-separated (stays display-only).

## Agent

The agent does not see contacts in this change: `_read_list` leaves the
`contacts` column out, and the agent can't add or set it. That edit touches the
tools, so per the root AGENTS.md: run `helios_scenarios` (3 epochs) before and
after, record both with `evals.history`, and report. The expected result is no
change in scores. Giving the agent contacts ("who do we know at X?") is a good
follow-up.

## Dummy data

`app/seed_contacts.py` (dev databases only, like `seed_users`): picks existing
corpus companies and writes fictional people (name, email at the company's
domain, phone, LinkedIn), their roles (title, function, primary contact for
some) and relationships to seeded Helbling users (and one or two non-user
names), all as observations in **one version** (author
`contacts-seed@helbling.ch`, source type `internal`), so a revert removes it.
Some companies get 0, most 1–3, a few 4–5 contacts; some fields left empty.
Tests use their own fixtures.

## Testing

- Gateway: tests for the contacts API (search, detail, company contacts, ended
  roles hidden, retracted relationships gone, user resolution by email and by
  name), the list column (read-only error, cell content, as-of an older
  corpus version, migration version), and export (column blocks, display-only
  record, re-import of an export with contact columns makes no changes).
  `./scripts/check.sh`.
- Frontend: `npm run check` plus the visual check (Playwright screenshots at
  1440×900) of the Contacts page, contact page, company page card and the list
  cell popover, in English and German.

## Left to the builder

- Exact component split and file names in the frontend.
- Contact search query shape, as long as it covers the fields above.
- Whether `helbling_person` gets a half-life.
- Popover layout details within the design rules.
