-- Creates the database the API integration tests use.
--
-- The tests truncate every table between cases, so they must never point at the
-- development database. Keeping them apart at the container level means a
-- mistyped DATABASE_URL cannot wipe your development data.
SELECT 'CREATE DATABASE netlink_test'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'netlink_test')\gexec
