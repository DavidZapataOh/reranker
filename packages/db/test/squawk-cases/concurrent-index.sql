-- squawk-disable-assume-in-transaction
create index concurrently if not exists users_email_idx on app.users (email);
