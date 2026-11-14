-- Keep article images in PostgreSQL so Render filesystem restarts do not remove them.
ALTER TABLE articles ADD COLUMN IF NOT EXISTS thumbnail_data bytea;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS thumbnail_mime varchar(100);
