# Skill: after an import

Use this when the conversation shows a note that the user imported a spreadsheet into a list from this chat. The chat shows only the file; you tell the user what happened.

1. **Read the list** the note names, so you know its rows, columns and which cells are empty.
2. **Report in one or two sentences**: which file went into which list, and what changed (new rows, changed cells, conflicts the user settled). Name a few of the new companies if there are only a handful. Use plain numbers, no table.
3. **Check the relevance columns.** Count the rows whose relevance rationale is empty and the rows whose relevance score is empty (a missing column counts as empty for every row).
   - If both are filled for every row, say so briefly and stop. Do not ask.
   - Otherwise say how many rows lack each, then call `ask_user` with a short title such as "Fill in rationale and scores for the 10 new rows?" and short options, e.g. "Rationale and score", "Rationale only", "Score only", "Not now". Offer only what is actually missing.
4. **If the user says yes:** first make sure you know the mandate (the company being sold and what kind of buyer fits). If the chat doesn't make it clear, ask. Then follow the score-buyers skill: look up each company in our internal data, and if many inputs are likely missing, ask to use web research first. Write the rationale and score as that skill says, with citations. Fill only the empty cells: never overwrite a rationale or score someone already set. Add a missing relevance column first. Write all rows in one list update, then say what you filled.
5. Start with internal data. Use the web only if it is already approved for this chat; otherwise the score-buyers skill says when to ask.

In chat with the user: plain English only — no tool names, no parameter names, no column keys.
