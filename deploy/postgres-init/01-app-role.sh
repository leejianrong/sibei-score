#!/bin/sh
# Runs once, when Postgres initialises an empty data directory (docker-entrypoint-initdb.d).
#
# Creates the ordinary role the API connects as, and the database it owns. This is the point of the
# script: row-level security does not bind a superuser or a BYPASSRLS role, and the API refuses to run as
# either (ADR-0034 decision 2), so the stack needs a role that is neither, and that owns its tables.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
CREATE ROLE sibei_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${SIBEI_APP_PASSWORD}';
CREATE DATABASE sibei OWNER sibei_app;
SQL
