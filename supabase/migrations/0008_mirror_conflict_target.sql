-- SiteLaunch Marketing Cockpit, migration 0008
--
-- Makes the activity external-key index usable as an ON CONFLICT target.
--
-- WHAT WENT WRONG
--
-- Migration 0007 created this index as a partial one:
--
--   create unique index activity_events_unique_external_key
--     on activity_events (owner_id, external_source, external_id)
--     where external_id is not null and external_source is not null;
--
-- It enforced exactly the right rule. It could not, however, be used as the
-- arbiter of an upsert. Postgres will only pick a partial unique index for
-- ON CONFLICT if the statement restates the index predicate, and PostgREST emits
-- a bare ON CONFLICT (col, col, col) with no WHERE clause, because its onConflict
-- parameter is a list of column names and has nowhere to put one. So the first
-- live reconciliation inserted all twenty-one leads and then failed on the
-- touches with:
--
--   there is no unique or exclusion constraint matching the ON CONFLICT specification
--
-- WHY DROPPING THE PREDICATE CHANGES NOTHING ABOUT THE RULE
--
-- Postgres treats nulls as distinct in a unique index by default, so two rows
-- that both have a null external_id never conflict with each other whether the
-- predicate is there or not. The WHERE clause was therefore not providing the
-- "only rows with an external id are constrained" behaviour; nulls were already
-- providing it. All the predicate did was keep the index smaller, at the cost of
-- making it unusable for the one operation it exists to support.
--
-- The index is slightly larger now because it covers every activity rather than
-- only the imported ones. On a table of this size that is nothing, and a correct
-- upsert is worth more than a smaller index.
--
-- WHY THE OTHER TWO INDEXES FROM 0007 ARE LEFT ALONE
--
-- leads_unique_external_key and tasks_one_open_follow_up_per_lead are never used
-- as an ON CONFLICT target. Leads are inserted plainly and tasks are created and
-- updated by id, so both keep their predicates, and
-- tasks_one_open_follow_up_per_lead genuinely needs its one: without the
-- predicate it would allow only a single follow-up task per lead ever, rather
-- than a single *open* one.

drop index if exists activity_events_unique_external_key;

/**
 * One activity per external key per owner.
 *
 * Same rule as before, now expressible as an upsert target. A row with no
 * external id is not constrained, because nulls are distinct.
 */
create unique index activity_events_unique_external_key
  on activity_events (owner_id, external_source, external_id);
