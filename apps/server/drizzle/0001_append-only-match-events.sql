-- Event history is immutable, including for the connection role that owns the tables.
CREATE FUNCTION reject_match_event_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'match_events is append-only' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER match_events_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON match_events
FOR EACH STATEMENT EXECUTE FUNCTION reject_match_event_mutation();
