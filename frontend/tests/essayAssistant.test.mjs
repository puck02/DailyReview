import assert from "node:assert/strict";
import { test } from "node:test";
import {
  countEssayWords,
  deriveEssayParagraphStage,
  insertEssaySuggestionAtCursor,
  normalizeEssaySuggestionForInsert,
  undoAcceptedEssaySuggestion
} from "/tmp/dailyreview-frontend-tests/frontend/src/essayAssistant.js";

test("countEssayWords counts English words instead of characters", () => {
  assert.equal(countEssayWords("In today's world, self-discipline matters."), 5);
  assert.equal(countEssayWords("手机 distracts students."), 2);
});

test("deriveEssayParagraphStage detects opening development transition and conclusion", () => {
  assert.equal(deriveEssayParagraphStage("", 0), "opening");
  assert.equal(deriveEssayParagraphStage("As is shown in the picture, a student is reading", 24), "opening");
  assert.equal(
    deriveEssayParagraphStage("As is shown in the picture, a student is reading.\nMoreover, this phenomenon is common", 75),
    "transition"
  );
  assert.equal(
    deriveEssayParagraphStage("The reason is obvious. We should build good habits and keep learning every day.", 78),
    "development"
  );
  assert.equal(
    deriveEssayParagraphStage("The reason is obvious.\nIn conclusion, we should take action", 61),
    "conclusion"
  );
});

test("insertEssaySuggestionAtCursor keeps punctuation and spacing clean", () => {
  assert.deepEqual(
    insertEssaySuggestionAtCursor("This reflects", "a lack of self-discipline", 13),
    {
      text: "This reflects a lack of self-discipline",
      range: { start: 13, end: 39 },
      insertedText: " a lack of self-discipline"
    }
  );
  assert.equal(
    insertEssaySuggestionAtCursor("This is important ", " because it affects learning.", 18).text,
    "This is important because it affects learning."
  );
  assert.equal(
    insertEssaySuggestionAtCursor("Students should focus", ", therefore, they need discipline.", 21).text,
    "Students should focus, therefore, they need discipline."
  );
  assert.equal(
    insertEssaySuggestionAtCursor("We should act.", ". Only in this way can we improve.", 14).text,
    "We should act. Only in this way can we improve."
  );
});

test("normalizeEssaySuggestionForInsert trims suggestions without breaking intended punctuation", () => {
  assert.equal(normalizeEssaySuggestionForInsert("  , therefore, students should stay focused.  "), ", therefore, students should stay focused.");
  assert.equal(normalizeEssaySuggestionForInsert("   a useful habit   "), "a useful habit");
});

test("undoAcceptedEssaySuggestion removes only the last accepted range", () => {
  const accepted = insertEssaySuggestionAtCursor("This reflects", "a lack of self-discipline", 13);
  assert.equal(undoAcceptedEssaySuggestion(accepted.text, accepted), "This reflects");
  assert.equal(undoAcceptedEssaySuggestion(`${accepted.text}.`, accepted), null);
});
