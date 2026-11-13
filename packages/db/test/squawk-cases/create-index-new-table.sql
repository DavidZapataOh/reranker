create table app.widgets (
  id uuid primary key default uuidv7(),
  name text not null
);
create index idx_widgets_name on app.widgets (name);
