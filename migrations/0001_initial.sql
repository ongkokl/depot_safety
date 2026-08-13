PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS inspections (
  id TEXT PRIMARY KEY,
  inspection_no TEXT NOT NULL UNIQUE,
  location TEXT NOT NULL,
  inspector TEXT NOT NULL,
  created_at TEXT NOT NULL,
  overall_result TEXT NOT NULL DEFAULT 'CHECK_REQUIRED'
);

CREATE TABLE IF NOT EXISTS inspection_photos (
  id TEXT PRIMARY KEY,
  inspection_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (inspection_id) REFERENCES inspections(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS safety_checks (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  check_question TEXT NOT NULL,
  guidance TEXT NOT NULL,
  source_title TEXT NOT NULL,
  source_url TEXT NOT NULL,
  keywords TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  inspection_id TEXT NOT NULL,
  photo_id TEXT NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  observation TEXT NOT NULL,
  status TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  confidence REAL NOT NULL,
  check_id TEXT,
  source_title TEXT,
  source_url TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (inspection_id) REFERENCES inspections(id) ON DELETE CASCADE,
  FOREIGN KEY (photo_id) REFERENCES inspection_photos(id) ON DELETE CASCADE,
  FOREIGN KEY (check_id) REFERENCES safety_checks(id)
);

CREATE TABLE IF NOT EXISTS corrective_actions (
  id TEXT PRIMARY KEY,
  finding_id TEXT NOT NULL,
  description TEXT NOT NULL,
  responsible_person TEXT,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN',
  created_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (finding_id) REFERENCES findings(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_findings_inspection ON findings(inspection_id);
CREATE INDEX IF NOT EXISTS idx_checks_category ON safety_checks(category);
