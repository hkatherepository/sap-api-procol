CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE vendor_status AS ENUM ('draft','submitted','under_review','pending','verified','rejected','suspended','blacklisted');
CREATE TYPE pr_status AS ENUM ('draft','submitted','approved','rejected','converted');
CREATE TYPE po_status AS ENUM ('draft','issued','acknowledged','partial','delivered','closed','cancelled');

CREATE TABLE vendor_registrations (
  id uuid PRIMARY KEY,
  user_id uuid,
  vendor_code text NOT NULL UNIQUE,
  company_name text NOT NULL,
  npwp text,
  address text,
  phone text,
  email text,
  status vendor_status NOT NULL DEFAULT 'draft',
  circle_number text,
  city text,
  approved_at timestamptz,
  approver_name text,
  vendor_created_at date,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL
);

CREATE TABLE purchase_requests (
  id uuid PRIMARY KEY,
  pr_number text NOT NULL UNIQUE,
  total_amount numeric,
  items jsonb,
  status pr_status NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL
);

CREATE TABLE purchase_orders (
  id uuid PRIMARY KEY,
  po_number text NOT NULL UNIQUE,
  vendor_id uuid REFERENCES vendor_registrations(id),
  total_amount numeric,
  items jsonb,
  status po_status NOT NULL DEFAULT 'draft',
  issued_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL
);
