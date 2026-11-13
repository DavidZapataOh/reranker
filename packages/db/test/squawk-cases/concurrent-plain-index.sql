-- squawk-disable-assume-in-transaction
create index idx_reports_status on app.reports (status);
