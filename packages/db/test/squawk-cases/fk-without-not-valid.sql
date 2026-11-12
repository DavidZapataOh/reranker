alter table app.orders
  add constraint orders_user_id_fkey foreign key (user_id) references app.users (id);
