# Essay Assistant Upgrade Design

## Goal

Upgrade the current essay writing assistant from delayed side-card suggestions into an interactive writing aid for exam practice.

The first implementation keeps the scope focused:
- inline ghost completion at the cursor
- a side panel with candidates, rewrite options, and short reasons
- context-aware completion that uses the topic OCR, objective image description, nearby draft text, cursor position, and paragraph stage
- keyboard-first accept/dismiss behavior

This is not a full essay grading or correction system.

## Current Problems

The current module waits 900ms, sends the whole draft, then renders up to three cards in the right rail. A click appends text to the end of the draft. This misses the real writing flow:
- suggestions are not tied to the cursor
- stale requests are only ignored, not aborted
- the backend prompt does not know prefix/suffix or paragraph stage
- no inline preview, no keyboard accept, no undo affordance
- all suggestions feel equally heavy and remote

## Product Design

The editor becomes a writing surface with an inline assistant layer.

When the user pauses at the cursor, the frontend requests a completion using:
- `prefix`: text before the cursor
- `suffix`: text after the cursor
- `cursor_index`
- word count
- paragraph stage: opening, development, transition, conclusion, or unknown
- topic OCR and objective description from the session

The best candidate appears as gray ghost text after the cursor. `Tab` accepts it, `Esc` dismisses it, and normal typing hides it. The right rail shows the same primary candidate plus alternates and rewrite chips, with concise reasons.

Accepted text is inserted at the cursor, not appended to the end. The UI shows a small “已补全，可撤销” state after acceptance.

## Backend Design

Extend `/api/essay/suggest` payload without breaking older callers:
- keep `session_id`, `content`, and `model`
- add optional `prefix`, `suffix`, `cursor_index`, `word_count`, `paragraph_stage`

The response keeps `suggestions` but each item may include:
- `kind`: `word`, `phrase`, `sentence`, or `rewrite`
- `text`
- `reason`
- `confidence`
- `insert_mode`: `inline` or `replace`

Prompt rules:
- continue from `prefix`, not from the full draft blindly
- do not repeat words already immediately before the cursor
- match exam essay tone
- prefer short, usable English
- avoid unsupported facts from the picture
- output strict JSON only

Fallback suggestions become cursor-aware and stage-aware.

## Frontend Design

Add a small completion state machine inside `EssayView`:
- idle
- waiting
- ready
- accepted
- dismissed
- error

Add refs for:
- textarea element
- current cursor index
- active suggestion abort controller
- last accepted suggestion for undo

The textarea remains the actual input. Ghost text is rendered by an absolutely positioned overlay inside the editor shell. The overlay mirrors the textarea font, line height, padding, and scroll position, then renders the draft prefix invisibly and the suggested continuation visibly in muted gray.

Interactions:
- pause triggers remote suggestion after a shorter debounce
- any text change, cursor move, model change, topic context change, or session switch cancels the active request
- `Tab` accepts the inline suggestion
- `Esc` dismisses the inline suggestion
- clicking a rail candidate inserts at the cursor
- undo removes the last accepted suggestion if the draft still contains it at the accepted range

## Error Handling

If the request fails, keep the draft untouched and show a compact status. Do not block writing.

If overlay positioning is not reliable, the rail still works and insertion remains cursor-aware.

If the backend returns invalid JSON, use fallback suggestions.

## Testing

Worker tests:
- prompt includes prefix, suffix, cursor index, paragraph stage, topic OCR, and objective description
- response normalizes new suggestion kinds and insert modes
- fallback suggestions are stage-aware

Frontend static tests:
- API payload supports cursor context
- Essay UI includes inline ghost completion, keyboard accept/dismiss, abort controller, and cursor insertion
- styles include ghost overlay aligned with the editor

Frontend unit tests where practical:
- insert suggestion at cursor
- undo accepted suggestion
- derive paragraph stage from draft context

Full verification:
- `npm --prefix worker test`
- `npm --prefix frontend test`
- `npm --prefix frontend run build`
- `npm --prefix worker run build`
