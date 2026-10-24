-- Preserve one live round while allowing its market to be selected at creation.
ALTER TABLE rounds DROP CONSTRAINT rounds_market_check;
ALTER TABLE rounds ADD CONSTRAINT rounds_market_check CHECK (market IN ('BTC-USD', 'ETH-USD', 'SOL-USD', 'ADA-USD'));
