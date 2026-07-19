-- Schema documentation for the app.* Postgres/PostGIS schema used by this
-- backend (distinct from public.*, which holds attractions/OSM data and is
-- not owned by this app). Tables were created by hand in DBeaver as the
-- project went through Фаза 1-3 — this file is not applied automatically by
-- anything and is not a migration tool; it exists so the schema survives if
-- the dev database is ever lost. To regenerate it against the live DB:
--
--   pg_dump "$DATABASE_URL" --schema=app --schema-only --no-owner --no-privileges --no-tablespaces
--
-- To rebuild the schema from scratch, run this whole file against an empty
-- database that already has the pgcrypto extension (for gen_random_uuid()).

--
-- Name: app; Type: SCHEMA
--

CREATE SCHEMA app;

--
-- Name: touch_updated_at(); Type: FUNCTION; Schema: app
--

CREATE FUNCTION app.touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

--
-- Name: anonymous_sessions; Type: TABLE; Schema: app
--

CREATE TABLE app.anonymous_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    user_id uuid
);

--
-- Name: credit_accounts; Type: TABLE; Schema: app
--

CREATE TABLE app.credit_accounts (
    user_id uuid NOT NULL,
    balance integer DEFAULT 0 NOT NULL
);

--
-- Name: credit_ledger; Type: TABLE; Schema: app
--

CREATE TABLE app.credit_ledger (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    amount integer NOT NULL,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: finalization_jobs; Type: TABLE; Schema: app
--

CREATE TABLE app.finalization_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    trip_project_id uuid NOT NULL,
    user_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    idempotency_key text NOT NULL,
    error text,
    trip_version_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT finalization_jobs_status_chk CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'done'::text, 'failed'::text])))
);

--
-- Name: trip_projects; Type: TABLE; Schema: app
--

CREATE TABLE app.trip_projects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid,
    anonymous_session_id uuid,
    title text,
    origin_name text,
    destination_name text,
    origin_lat double precision,
    origin_lon double precision,
    destination_lat double precision,
    destination_lon double precision,
    status text DEFAULT 'draft'::text NOT NULL,
    quiz_answers jsonb,
    draft_state jsonb,
    finalized_version_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT trip_projects_owner_chk CHECK (((owner_user_id IS NOT NULL) OR (anonymous_session_id IS NOT NULL))),
    CONSTRAINT trip_projects_status_chk CHECK ((status = ANY (ARRAY['draft'::text, 'finalizing'::text, 'finalized'::text])))
);

--
-- Name: trip_versions; Type: TABLE; Schema: app
--

CREATE TABLE app.trip_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    trip_project_id uuid NOT NULL,
    version_type text DEFAULT 'finalized'::text NOT NULL,
    snapshot jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: users; Type: TABLE; Schema: app
--

CREATE TABLE app.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text,
    auth_provider text,
    provider_sub text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Primary keys / unique constraints
--

ALTER TABLE ONLY app.anonymous_sessions
    ADD CONSTRAINT anonymous_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.credit_accounts
    ADD CONSTRAINT credit_accounts_pkey PRIMARY KEY (user_id);

ALTER TABLE ONLY app.credit_ledger
    ADD CONSTRAINT credit_ledger_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.finalization_jobs
    ADD CONSTRAINT finalization_jobs_idem_uk UNIQUE (trip_project_id, idempotency_key);

ALTER TABLE ONLY app.finalization_jobs
    ADD CONSTRAINT finalization_jobs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.trip_projects
    ADD CONSTRAINT trip_projects_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.trip_versions
    ADD CONSTRAINT trip_versions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.users
    ADD CONSTRAINT users_provider_uk UNIQUE (auth_provider, provider_sub);

--
-- Indexes
--

CREATE INDEX credit_ledger_user_ix ON app.credit_ledger USING btree (user_id, created_at);

CREATE INDEX finalization_jobs_project_ix ON app.finalization_jobs USING btree (trip_project_id);

CREATE INDEX finalization_jobs_user_ix ON app.finalization_jobs USING btree (user_id);

CREATE INDEX trip_projects_owner_ix ON app.trip_projects USING btree (owner_user_id);

CREATE INDEX trip_projects_session_ix ON app.trip_projects USING btree (anonymous_session_id);

CREATE INDEX trip_projects_updated_ix ON app.trip_projects USING btree (updated_at DESC);

CREATE INDEX trip_versions_project_ix ON app.trip_versions USING btree (trip_project_id);

--
-- Triggers
--

CREATE TRIGGER finalization_jobs_touch BEFORE UPDATE ON app.finalization_jobs FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TRIGGER trip_projects_touch BEFORE UPDATE ON app.trip_projects FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

--
-- Foreign keys
--

ALTER TABLE ONLY app.anonymous_sessions
    ADD CONSTRAINT anonymous_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES app.users(id);

ALTER TABLE ONLY app.credit_accounts
    ADD CONSTRAINT credit_accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES app.users(id);

ALTER TABLE ONLY app.credit_ledger
    ADD CONSTRAINT credit_ledger_user_id_fkey FOREIGN KEY (user_id) REFERENCES app.users(id);

ALTER TABLE ONLY app.finalization_jobs
    ADD CONSTRAINT finalization_jobs_trip_project_id_fkey FOREIGN KEY (trip_project_id) REFERENCES app.trip_projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY app.finalization_jobs
    ADD CONSTRAINT finalization_jobs_trip_version_id_fkey FOREIGN KEY (trip_version_id) REFERENCES app.trip_versions(id);

ALTER TABLE ONLY app.finalization_jobs
    ADD CONSTRAINT finalization_jobs_user_id_fkey FOREIGN KEY (user_id) REFERENCES app.users(id);

ALTER TABLE ONLY app.trip_projects
    ADD CONSTRAINT trip_projects_anonymous_session_id_fkey FOREIGN KEY (anonymous_session_id) REFERENCES app.anonymous_sessions(id);

ALTER TABLE ONLY app.trip_projects
    ADD CONSTRAINT trip_projects_finalized_version_fk FOREIGN KEY (finalized_version_id) REFERENCES app.trip_versions(id);

ALTER TABLE ONLY app.trip_projects
    ADD CONSTRAINT trip_projects_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES app.users(id);

ALTER TABLE ONLY app.trip_versions
    ADD CONSTRAINT trip_versions_trip_project_id_fkey FOREIGN KEY (trip_project_id) REFERENCES app.trip_projects(id) ON DELETE CASCADE;
