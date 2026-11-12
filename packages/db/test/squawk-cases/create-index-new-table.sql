create table app.widgets (id uuid primary key, label text);

create index widgets_label_idx on app.widgets (label);
