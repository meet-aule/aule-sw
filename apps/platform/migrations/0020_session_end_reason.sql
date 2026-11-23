-- A bounded reason survives room deletion so a family can understand a close.
-- Existing sessions stay NULL: their reason cannot be reconstructed reliably.
alter table sessions add column end_reason text check (
    end_reason in ('child_ended', 'idle', 'budget_reached', 'parent_ended',
                   'device_offline', 'not_working', 'error', 'provider_error')
);
