-- ---------------------------------------------------------------------------
-- 0018_usage_can_be_unknown.sql
--
-- A cost nobody knows is not a cost of zero.
--
-- WHAT WAS WRONG
--
-- 0016 gave ai_usage three numeric columns that were NOT NULL DEFAULT 0. That
-- is fine for a request that answered, where the provider reports exactly what
-- was used. It is wrong for a request that failed.
--
-- A provider that refuses a malformed request charges nothing and says so. A
-- request that times out after the model has already generated tokens is
-- charged, and the response that would have carried the counts never arrives.
-- Both landed in the same row shape: zero tokens, zero cost. The first was
-- true. The second read as free when the honest answer was "this cost
-- something and we cannot say how much".
--
-- This project already has a rule for that, and has had since the first
-- migration: unknown is never zero. Nulls stay null and no screen coerces one
-- into a number. The cost table was the one place the rule had been broken, and
-- it was broken in the direction that understates a bill.
--
-- WHAT CHANGES
--
-- The three numbers become nullable, and null means "not known". The check
-- constraints stay as they are: a null passes them, which is correct, because
-- an unknown count is not a negative one.
--
-- `note` is new, so "there is no price on file for this model" stops being
-- written into `error`. A model with no price is not a failed request, and
-- filing it as one makes every count of failures wrong.
--
-- And a row may only leave its cost unknown if it says why. Otherwise unknown
-- becomes the lazy default, and a cost table whose rows are mostly null is no
-- more use than one whose rows are mostly zero.
-- ---------------------------------------------------------------------------

alter table ai_usage alter column input_tokens  drop not null;
alter table ai_usage alter column input_tokens  drop default;
alter table ai_usage alter column output_tokens drop not null;
alter table ai_usage alter column output_tokens drop default;
alter table ai_usage alter column cost_micros   drop not null;
alter table ai_usage alter column cost_micros   drop default;

/**
 * Why a cost is not known.
 *
 * Separate from `error`, which stays for requests that actually failed. The two
 * reasons a cost can be unknown are a provider that returned no usage figures,
 * and a model with no price on file, and only the first of those is a failure.
 */
alter table ai_usage add column if not exists note text;

alter table ai_usage drop constraint if exists unknown_cost_says_why;
alter table ai_usage add constraint unknown_cost_says_why check (
  cost_micros is not null or error is not null or note is not null);

comment on column ai_usage.cost_micros is
  'Millionths of a currency unit. Null means the cost is not known, which is '
  'different from zero, and the row then has to say why in error or note.';

comment on column ai_usage.note is
  'Why a cost or a token count is not known, where that is not a failure. A '
  'model with no price on file is the usual reason.';
