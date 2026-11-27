-- ATLAS (lead agent): one market briefing per IST day and the day's task list for the other agents.
-- Tasks are checks on real app state. No task can place, close or change a trade or a setting.
CREATE TABLE IF NOT EXISTS agent_briefings (
 day date PRIMARY KEY,
 market jsonb NOT NULL DEFAULT '{}'::jsonb,
 notes jsonb NOT NULL DEFAULT '[]'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS agent_tasks (
 id bigserial PRIMARY KEY,
 day date NOT NULL,
 agent varchar(20) NOT NULL,
 task_key varchar(40) NOT NULL,
 title varchar(200) NOT NULL,
 priority varchar(10) NOT NULL DEFAULT 'NORMAL',
 status varchar(16) NOT NULL DEFAULT 'ASSIGNED',
 evidence varchar(400) NOT NULL DEFAULT '',
 assigned_at timestamptz NOT NULL DEFAULT now(),
 checked_at timestamptz,
 done_at timestamptz,
 UNIQUE(day,agent,task_key)
);
CREATE INDEX IF NOT EXISTS agent_tasks_day ON agent_tasks(day);

-- Web Push: browser subscriptions per account and the alerts waiting to be shown.
-- Pushes carry no payload; the service worker fetches the alert text with the signed-in session.
CREATE TABLE IF NOT EXISTS push_vapid (
 id integer PRIMARY KEY CHECK (id=1),
 public_key text NOT NULL,
 private_key text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
 id bigserial PRIMARY KEY,
 username varchar(48) NOT NULL REFERENCES auth_users(username),
 endpoint varchar(1000) NOT NULL UNIQUE,
 device varchar(80) NOT NULL DEFAULT '',
 failures integer NOT NULL DEFAULT 0,
 last_error varchar(200) NOT NULL DEFAULT '',
 last_sent_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS push_alerts (
 id bigserial PRIMARY KEY,
 username varchar(48) NOT NULL REFERENCES auth_users(username),
 record_type varchar(40) NOT NULL,
 source_id text NOT NULL,
 title varchar(120) NOT NULL,
 body varchar(400) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 sent_at timestamptz,
 UNIQUE(username,record_type,source_id)
);
CREATE INDEX IF NOT EXISTS push_alerts_unsent ON push_alerts(created_at) WHERE sent_at IS NULL;
