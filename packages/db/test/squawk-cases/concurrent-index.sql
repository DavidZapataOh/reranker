-- squawk-disable-assume-in-transaction
create index concurrently if not exists idx_reports_status on app.reports (status);
