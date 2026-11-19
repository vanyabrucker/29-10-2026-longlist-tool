# Skill: score buyers and explain the score

Use this every time you write a relevance score or rationale: a new list, a refinement, or filling empty cells after an import. The score says how well a buyer fits this mandate. The rationale says why, with the evidence.

## 1. Know the mandate and the kind of buyer

You need the company being sold (sector, size, what it does) and whether the list is strategic or financial. If the chat doesn't make that clear, ask first. Strategic and financial buyers are judged on different things.

**Strategic buyer — judge on:**
- Sector and sub-sector fit with the target, and the buyer's **role**: component supplier, integrator, service provider, software provider or similar. Say how that role fits the target's theme.
- Size and capacity: revenue, employees, and any cash, debt or profit figures, each with its period.
- Profitability. No profit is a possible negative, never a reason to drop the buyer.
- Past acquisitions and stated strategy.
- Ownership and group: who owns it, and whether it belongs to a group.

**Financial buyer — judge on:**
- Investment scope: the sectors and kinds of company it backs, as it states them.
- Size: its published ticket size or fund size against the target's likely value.
- For a venture fund, the stage it invests in.
- Target preferences it publishes, and recent deals in this area.

## 2. Check what is missing before you write

For every buyer, note which of the inputs above you can source. If many are likely unknown (for example you only have a name, or the internal data holds no financials or ticket size), do not guess:

1. Say in the chat which inputs are missing and for how many buyers.
2. If web research is not yet approved, call `request_web_research` for this turn (or one exact look-up for a single buyer) so you can fill the blanks. Word the card plainly: what you would look up and why.
3. Once approved, search, then write the rationale and score for all those buyers in one list update. Do not stop after the search to ask again.
4. If the user says no, score from what you have. Say what is missing and how it lowers your confidence. If you lack both the sector fit and the size, leave the score empty and say why. An empty score means unknown. **Never write 0 for unknown.**

## 3. Write the rationale

One short paragraph, plain words, 2–4 sentences. In this order:
1. The segment and role, and whether the fit is strong, partial or weak. Example: "Strategic, component supplier: strong fit on aerospace propulsion."
2. The facts that drive the score: sector, size, profitability and capacity, deal history. Give the period of every figure.
3. What is missing, and what that does to your confidence. Example: "No profit figures found, so confidence is medium."
4. Process notes, when true: a foundation-controlled or listed owner is something to flag, never a reason to exclude. If the buyer sits in a group with another buyer on the list, say so and list it once, under the group's main buyer, unless there is a documented reason to treat them as separate.

Keep sourced facts apart from your judgement. A fact gets a citation. A judgement ("probably interested because…") is marked as your view: "likely", "I read this as".

Never invent a figure, a date, a deal or an owner. If a fact has no source, leave it out or say it is unconfirmed.

## 4. Cite your sources

After each sourced fact, add a citation: `[[source | url | evidence]]`. The user sees a small numbered chip that opens to show the source and the evidence.

- **source**: who says it. For internal data, the name of the person who gave it, or the provider: `S&P Capital IQ`, `Orbis`, `Internal file`. For a web page, its short name; the user will see "Web research" and the site's address.
- **url**: the web page, in full. Leave it empty for internal data. Never put a link here that a search did not return.
- **evidence**: what the source says, in a few words, with its period. Example: `Revenue CHF 412m, FY2024`.

Write it like this:

> Strategic, component supplier: strong fit on engine parts. Revenue is CHF 412m [[S&P Capital IQ | | Revenue CHF 412m, FY2024]] and it bought two machining firms since 2022 [[Web research | https://example.com/news/acquisition | Acquired Mecano AG in March 2023 and Frei GmbH in 2022]]. No profit figures found, so confidence is medium.

Rules:
- Exactly three parts split by `|`. Do not use `|` or `]]` inside a part.
- One citation per fact. Do not stack many on one sentence. Do not cite your own judgement.
- Every number on the rationale has a citation. A claim you cannot cite is a judgement, so label it as one.
- A web fact needs a real url from a search result. Facts from the web with no url are unsourced and read as low quality.
- Use citations in the rationale and also in chat messages when you state a fact about a buyer.

## 5. Score

Score 0–100 for fit with this mandate. Use the whole range:
- 80–100: strong fit on sector and size, with sourced evidence, and no major concern.
- 50–79: fits on sector or size, but something is partial or unknown.
- 20–49: weak or distant fit.
- Under 20: probably not a buyer.

Weigh the criteria for the buyer's kind (section 1). Missing inputs pull the score toward the middle and lower your confidence; they never count as a zero on that criterion. Do not give two buyers the same score unless they fit equally well. The list shows buyers by score, so the order is the rank.

If a person has already set a score or rationale, leave it. Never overwrite it.

In chat with the user: plain English only. No tool names, no parameter names, no column keys.
