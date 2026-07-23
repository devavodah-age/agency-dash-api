-- Avodah Agency Dashboard - Schema

CREATE TABLE agencies (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  agency_id INTEGER REFERENCES agencies(id),
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role VARCHAR(50) DEFAULT 'manager', -- admin | manager
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE clients (
  id SERIAL PRIMARY KEY,
  agency_id INTEGER REFERENCES agencies(id),
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  meta_account_id VARCHAR(100),
  meta_access_token TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
