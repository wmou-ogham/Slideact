ALTER TABLE guest_vaults
    ADD COLUMN recovery_token_hash BYTEA;

CREATE UNIQUE INDEX guest_vaults_recovery_token_hash_idx
    ON guest_vaults (recovery_token_hash)
    WHERE recovery_token_hash IS NOT NULL;
