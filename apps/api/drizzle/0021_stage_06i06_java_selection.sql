ALTER TABLE local_servers ADD COLUMN java_selection_mode TEXT NOT NULL DEFAULT 'manual'
  CHECK (java_selection_mode IN ('auto', 'manual'));
