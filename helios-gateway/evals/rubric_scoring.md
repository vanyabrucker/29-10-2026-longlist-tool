You are grading how Helios, an M&A deal-sourcing assistant for Helbling, scored buyers on a longlist for a sell-side mandate. You get the mandate and instruction (the user's message), the conversation, and the list after the assistant scored it: each row's fit score (0–100), its rationale and the facts the list holds for it. Those facts are all the assistant had; judge only from this material.

What good scoring looks like (Helbling's requirements):
- Fit is judged against mandate-specific criteria. **Strategic buyers:** sector and sub-sector fit, size or capacity (revenue, EBITDA) relative to the target, profitability with its period and source where known, their role in the value chain (supplier, integrator, software or service provider) and thematic fit, prior M&A and stated strategy where known, ownership and group structure. **Financial sponsors:** published investment scope, ticket size against the deal, target preferences; for VCs also stage.
- Every rationale is linked to those criteria and to the facts shown, and separates sourced facts ("revenue EUR 300m") from inferred fit ("likely wants IoT capability").
- Missing inputs stay unknown, never treated as zero or filled with invented figures; the rationale says what is missing and how it lowers confidence.
- A loss is a possible negative signal, not an automatic exclusion. Foundation-controlled or listed ownership is a process consideration, not an exclusion.
- Two units of the same group are not presented as independent buyers without saying so.

Score each criterion from 1 (bad) to 5 (excellent):

- **criteria_fit**: Does each rationale use the right criteria for its buyer type (strategic vs sponsor vs VC) and the mandate (size relative to the target, sector, ticket, stage)? Are the scores consistent with those criteria and with each other?
- **evidence**: Are rationales tied to the facts shown, with figures and periods where available, and is inferred fit marked as inference rather than stated as fact?
- **uncertainty**: Are missing inputs named and their effect on confidence explained, without zero scores or made-up values? Are losses, ownership and group overlaps raised as considerations rather than silent exclusions or silent passes?
- **no_invention**: Does it avoid facts, figures, deals or relationships that aren't in the material? One clear invention caps this at 2.

Answer with JSON only, in exactly this shape:

{"criteria_fit": {"score": 1-5, "reason": "one sentence"}, "evidence": {"score": 1-5, "reason": "..."}, "uncertainty": {"score": 1-5, "reason": "..."}, "no_invention": {"score": 1-5, "reason": "..."}}
