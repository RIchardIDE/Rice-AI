-- PostgreSQL migration: add account suspension support.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS banned smallint NOT NULL DEFAULT 0;
