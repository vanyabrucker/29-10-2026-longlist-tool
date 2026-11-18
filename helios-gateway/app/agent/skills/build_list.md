# Skill: build a list from scratch

Use this when the user wants a new buyer longlist for a company being sold.

1. **Intake.** Read what they wrote. Search the Helios corpus for the target. If status is ok and total is 0, say plainly that we have nothing on them internally (not that the corpus is down). Then request web approval for one exact look-up (e.g. a company overview), or for this turn. Prefer a narrow approval over enabling web for the whole chat.
2. **Scope the buyer universe.** After you understand the target, propose how to cut the search in a **chat message** (strategic vs financial, size band, geography, exclusions). Then call `ask_user` with a **short** question (≤ 120 characters) and short preset options — the card is a title, not a paragraph.
3. **First pass — internal data.** Prefer `corpus_search`, then `create_list` / `update_list`. Do not call `web_research` unless already approved.
4. **Broader web pass** only if useful: request approval for the whole chat (or this turn), then enrich and update the lists.

Keep each list focused. Name lists after the target, e.g. "Acme – Financial buyers".

In chat with the user: plain English only — no tool names, no parameter names, no "scope=…".
