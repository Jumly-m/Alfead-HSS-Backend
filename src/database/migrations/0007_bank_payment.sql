-- Migration 0007: Add bank payment method support
-- Adds bank_name column to sales table for storing selected bank (NMB, CRDB, etc.)

ALTER TABLE sales ADD COLUMN IF NOT EXISTS bank_name VARCHAR(100);
