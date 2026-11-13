alter table app.reports
  add constraint reports_owner_fk foreign key (owner_id) references auth.users (id);
