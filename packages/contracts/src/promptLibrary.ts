import * as Schema from "effect/Schema";

export const SavedPrompt = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100_000)),
  favorite: Schema.Boolean,
  order: Schema.Number.check(Schema.isFinite()),
  tags: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40))).check(
    Schema.isMaxLength(20),
  ),
});
export type SavedPrompt = typeof SavedPrompt.Type;

export const PromptLibrary = Schema.Record(Schema.String, Schema.NullOr(SavedPrompt));
export type PromptLibrary = typeof PromptLibrary.Type;
