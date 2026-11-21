DROP INDEX IF EXISTS users_wallet_address_key;
ALTER TABLE users DROP COLUMN IF EXISTS wallet_address;
