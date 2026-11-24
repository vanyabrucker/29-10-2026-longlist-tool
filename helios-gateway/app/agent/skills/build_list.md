# Skill: build a list from scratch

Use this when the user wants a new buyer longlist for a company being sold.

1. **Intake.** Read what they wrote. Search the Helios corpus for the target. If status is ok and total is 0, say plainly that we have nothing on them internally (not that the corpus is down). Then request web approval for one exact look-up (e.g. a company overview), or for this turn. Prefer a narrow approval over enabling web for the whole chat.
2. **Scope the buyer universe.** After you understand the target, propose how to cut the search in a **chat message** (strategic vs financial, size band, geography, exclusions). Then call `ask_user` with a **short** question (≤ 120 characters) and short preset options — the card is a title, not a paragraph.
3. **First pass — internal data.** Turn the agreed scope into `corpus_search` calls: the business in plain words as the query (what buyers do: the target's own niche, adjacent services, typical acquirers), and the scope as filters (`countries` / `regions`, `buyer_category`, `investor_types`, `revenue_min_m` / `revenue_max_m` with `revenue_currency`, `employees_min` / `employees_max`, `sectors` for broad sectors only). Size filters keep every company whose employee range overlaps them (a company listed as 11–50 matches 50–200). One search per buyer angle, e.g. strategic SAP consultancies in DACH, then IT service groups in Europe above EUR 100m, then PE funds in DACH. If a size filter returns few results, try again with `include_missing` and mention that those companies have no size figure. Then `create_list` / `update_list`. Do not call `web_research` unless already approved. Score and explain every buyer as the score-buyers skill says; if many inputs are likely missing, ask to use web research before you write the scores.
4. **Broader web pass** only if useful: request approval for the whole chat (or this turn), then enrich and update the lists.

Cite as you go: every fact in a rationale or a chat message carries `[[source | url | evidence]]` (url empty for our internal data), as the score-buyers skill shows. Do this in the first pass too, not only after web research.

Keep each list focused. Name lists after the target, e.g. "Acme – Financial buyers".

In chat with the user: plain English only — no tool names, no parameter names, no "scope=…".
