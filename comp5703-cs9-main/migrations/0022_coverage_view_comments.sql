-- 0022  Two coverage views that disagree, and the comment that misleads
--
-- v_api_schema_coverage and v_api_input_coverage both answer "how much of the
-- catalogue can the BP-Builder reason about", and today they give different
-- numbers: 56 records under "no schema" against 43 under "nothing stored".
-- Both are right. They count different things, and only one of them answers
-- the question a report would ask.
--
-- The difference is the 13 records whose whole input is path or query
-- parameters and which therefore have no request body: Serbia's downloads,
-- Greece's retrievals, Egypt's package requests. 0017 gave parameters a table
-- so that exactly those records could be compared, and they are -- but
-- v_api_schema_coverage only looks at api_schema, so it files them under "no
-- schema".
--
-- v_api_schema_coverage's own comment then states the wrong conclusion:
-- '"no schema" is the backlog the BP-Builder cannot yet reason about'. That
-- was true when it was written, before parameters existed. Quoting it now
-- overstates the backlog by 13 records, and the number has been quoted -- it
-- reads as the headline of the whole schema effort.
--
-- Nothing about either view's data changes. Both comments now say what their
-- view counts and which question it answers.

comment on view public.v_api_schema_coverage is
  'How many active catalogue records carry a request body schema, a response
   body schema, both, or neither. It counts api_schema only, so a record whose
   whole input is path or query parameters -- and which the comparison engine
   compares perfectly well, on those parameters -- is counted under
   "no schema". For "what can the BP-Builder reason about", read
   v_api_input_coverage instead: its "nothing stored" is the real backlog.';

comment on view public.v_api_input_coverage is
  'What the comparison engine has to work with on each active record: a request
   body, parameter inputs, both, or nothing. "nothing stored" is the backlog --
   the records for which no comparison can be attempted in either direction.
   This is the number to quote for coverage; v_api_schema_coverage counts
   bodies only and reads 13 records lower on inputs.';
