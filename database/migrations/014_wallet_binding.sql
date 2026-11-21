ALTER TABLE users ADD COLUMN wallet_address TEXT;

CREATE UNIQUE INDEX users_wallet_address_key ON users(wallet_address) WHERE wallet_address IS NOT NULL;
