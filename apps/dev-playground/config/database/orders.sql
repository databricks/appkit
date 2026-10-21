-- Tables and seed data for the operations example (config/database/routes/orders.ts).
create table if not exists orders (
  id serial primary key,
  team_id text not null,
  created_by text not null,
  status varchar(16) not null,
  total_cents integer not null,
  approved_by text
);

create table if not exists team_members (
  id serial primary key,
  user_id text not null,
  team_id text not null,
  role varchar(16) not null,
  approval_limit_cents integer not null,
  unique (user_id, team_id)
);

insert into team_members (user_id, team_id, role, approval_limit_cents) values
  ('alice', 'red', 'approver', 100000),
  ('bob', 'red', 'member', 0),
  ('carol', 'blue', 'approver', 100000);

insert into orders (team_id, created_by, status, total_cents) values
  ('red', 'bob', 'pending', 25000),
  ('red', 'bob', 'pending', 500000),
  ('blue', 'carol', 'pending', 9900);
