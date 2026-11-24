-- Fake CRM and HR data for the Agent Gateway demo. Two schemas in one database so each MCP server can later be limited to its own.
CREATE SCHEMA IF NOT EXISTS crm;
CREATE SCHEMA IF NOT EXISTS hr;
CREATE TABLE crm.customers (
  customer_id   text PRIMARY KEY,
  name          text NOT NULL,
  industry      text,
  tier          text,
  contact_name  text,
  contact_email text,
  account_owner text
);
CREATE TABLE crm.deals (
  deal_id     text PRIMARY KEY,
  customer_id text NOT NULL REFERENCES crm.customers (customer_id),
  title       text NOT NULL,
  stage       text NOT NULL,
  amount_usd  numeric(12,2) NOT NULL,
  owner       text
);
CREATE TABLE hr.employees (
  employee_id text PRIMARY KEY,
  name        text NOT NULL,
  department  text NOT NULL,
  title       text,
  location    text,
  manager     text,
  email       text
);
-- Pay lives in its own table so the sensitive data is separate from the directory.
CREATE TABLE hr.compensation (
  employee_id text PRIMARY KEY REFERENCES hr.employees (employee_id),
  salary_usd  numeric(12,2) NOT NULL
);
