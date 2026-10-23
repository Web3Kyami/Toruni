-- Bind each server-issued identifier to the exact client-side order terms approved by server preflight.
ALTER TABLE quote_intents
  ADD COLUMN requested_price numeric NOT NULL CHECK (requested_price > 0),
  ADD COLUMN requested_size numeric NOT NULL CHECK (requested_size > 0);
