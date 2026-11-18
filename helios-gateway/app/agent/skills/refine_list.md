# Skill: refine a list

Use this when the user wants to narrow, rescore or extend an existing longlist linked to this chat (or named by them).

1. Confirm which list and what changes in chat; use `ask_user` with a short card title (≤ 120 characters) if unclear.
2. **First pass — internal only.** Read the list first (`read_list`) for its row ids and columns, then use `corpus_search` and `update_list`. Empty hits (status ok, total 0) mean no matches, not an outage. Do not call `web_research` unless already approved for this chat/turn/query.
3. Summarise what changed, in plain English.
4. For external signals, request web approval (one look-up, this turn, or the whole chat), then update the list after approval.

In chat with the user: no tool names, no parameter names, no "scope=…".
