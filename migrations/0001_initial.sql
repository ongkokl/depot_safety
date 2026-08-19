PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  google_sub TEXT UNIQUE,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  company TEXT,
  role TEXT NOT NULL DEFAULT 'inspector'
    CHECK (role IN ('inspector','action_user','admin','super_admin')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by INTEGER
);

CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by INTEGER
);

CREATE TABLE IF NOT EXISTS areas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by INTEGER
);

CREATE TABLE IF NOT EXISTS inspection_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_no TEXT UNIQUE NOT NULL,
  inspection_date TEXT NOT NULL,
  inspector_name TEXT NOT NULL,
  company TEXT NOT NULL,
  location TEXT NOT NULL,
  created_by_user_id INTEGER NOT NULL,
  created_by_google_sub TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','submitted')),
  submitted_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS inspection_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL,
  item_no INTEGER NOT NULL,
  finding_type TEXT NOT NULL
    CHECK (finding_type IN ('safe_good_practice','unsafe_act','unsafe_condition','improvement_opportunity')),
  area TEXT NOT NULL,
  description TEXT NOT NULL,
  immediate_action TEXT,
  corrective_action TEXT,
  responsible_company TEXT,
  responsible_user_id INTEGER,
  responsible_person_name TEXT,
  target_date TEXT,
  remark TEXT,
  status TEXT NOT NULL DEFAULT 'closed'
    CHECK (status IN ('closed','open','in_progress','ready_for_closure','closure_requested','rejected')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (report_id) REFERENCES inspection_reports(id),
  FOREIGN KEY (responsible_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  photo_type TEXT NOT NULL
    CHECK (photo_type IN ('inspection','update','closure')),
  r2_key TEXT NOT NULL UNIQUE,
  original_name TEXT,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  uploaded_by_user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (report_id) REFERENCES inspection_reports(id),
  FOREIGN KEY (item_id) REFERENCES inspection_items(id),
  FOREIGN KEY (uploaded_by_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS action_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  remark TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (item_id) REFERENCES inspection_items(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER,
  actor_google_sub TEXT,
  actor_email TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  before_json TEXT,
  after_json TEXT,
  ip_hash TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (actor_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reports_owner ON inspection_reports(created_by_google_sub);
CREATE INDEX IF NOT EXISTS idx_reports_date ON inspection_reports(inspection_date);
CREATE INDEX IF NOT EXISTS idx_items_status ON inspection_items(status);
CREATE INDEX IF NOT EXISTS idx_items_responsible ON inspection_items(responsible_user_id);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);

INSERT OR IGNORE INTO companies(name, active) VALUES
('PSA',1),('Reefertec',1),('CWT',1),('E61',1);

INSERT OR IGNORE INTO locations(name, active) VALUES
('P12 Depot',1),('Block A',1),('Tuas Depot',1);

INSERT OR IGNORE INTO areas(name, active) VALUES
('Gate',1),('Survey Area',1),('Yard',1),('Workshop',1),
('Reefer Area',1),('Container Repair Area',1),('Office',1),
('Parking Area',1),('Pedestrian Walkway',1),('Container Storage Area',1),
('Other',1);
