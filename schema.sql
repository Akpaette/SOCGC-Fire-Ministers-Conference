-- Minister's Fire Conference 2026: manual bank-transfer confirmation flow
create extension if not exists pgcrypto;
create table registrations(
  id uuid primary key default gen_random_uuid(),
  full_name text not null, email text not null, phone text not null, gender text not null,
  country text not null, state text not null, city text not null,
  church_affiliation text, ministerial_designation text,
  reference text not null unique,
  fee_ngn int not null default 10000,
  payment_status text not null default 'AWAITING_PROOF' check (payment_status in ('AWAITING_PROOF','PAID','REJECTED')),
  status text not null default 'PENDING' check (status in ('PENDING','CONFIRMED','CANCELLED')),
  consent_at timestamptz not null, approved_by uuid, approved_at timestamptz, approval_note text,
  created_at timestamptz default now());
create unique index one_reg_per_email on registrations(lower(email)) where status <> 'CANCELLED';
create table event_passes(
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null unique references registrations(id),
  ticket_number text not null unique, pass_status text not null default 'ACTIVE' check (pass_status in ('ACTIVE','CANCELLED')),
  generated_at timestamptz default now(), checked_in_at timestamptz);
create table check_ins(id uuid primary key default gen_random_uuid(), registration_id uuid references registrations(id),
  checked_in_by uuid, check_in_time timestamptz default now(), check_in_status text not null);
create table email_notifications(id uuid primary key default gen_random_uuid(), registration_id uuid references registrations(id),
  recipient text not null, subject text not null, notification_type text not null, delivery_status text not null default 'QUEUED',
  attempts int default 0, error text, sent_at timestamptz, created_at timestamptz default now());
create table admin_users(user_id uuid primary key, role text not null check (role in ('admin','usher')));
create table admin_audit_logs(id uuid primary key default gen_random_uuid(), administrator_id uuid, action text not null,
  affected_record text, timestamp timestamptz default now());
do $$ declare t text; begin
 foreach t in array array['registrations','event_passes','check_ins','email_notifications','admin_users','admin_audit_logs']
 loop execute format('alter table %I enable row level security',t); end loop; end $$;  -- no public policies: server-only access

-- Admin approval: one transaction, audited, idempotent (one pass per registration).
create or replace function approve_payment(p_reg uuid, p_admin uuid, p_ticket text, p_note text) returns jsonb language plpgsql security definer as $$
declare r registrations; begin
 select * into r from registrations where id=p_reg for update;
 if not found then return jsonb_build_object('ok',false); end if;
 if r.payment_status='PAID' then return jsonb_build_object('ok',true,'first_time',false); end if;
 update registrations set payment_status='PAID',status='CONFIRMED',approved_by=p_admin,approved_at=now(),approval_note=p_note where id=p_reg;
 insert into event_passes(registration_id,ticket_number) values(p_reg,p_ticket) on conflict (registration_id) do nothing;
 insert into admin_audit_logs(administrator_id,action,affected_record) values(p_admin,'APPROVE_PAYMENT',r.reference);
 return jsonb_build_object('ok',true,'first_time',true); end $$;

-- Atomic check-in: the single UPDATE lets only one usher win.
create or replace function check_in_pass(p_ticket text, p_usher uuid) returns jsonb language plpgsql security definer as $$
declare p event_passes; r registrations; won int; begin
 select * into p from event_passes where ticket_number=p_ticket;
 if not found then return jsonb_build_object('outcome','INVALID'); end if;
 select * into r from registrations where id=p.registration_id;
 if p.pass_status='CANCELLED' or r.status='CANCELLED' then return jsonb_build_object('outcome','CANCELLED'); end if;
 if r.payment_status<>'PAID' then return jsonb_build_object('outcome','PAYMENT_NOT_VERIFIED'); end if;
 update event_passes set checked_in_at=now() where id=p.id and checked_in_at is null; get diagnostics won=row_count;
 if won=0 then select checked_in_at into p.checked_in_at from event_passes where id=p.id;
   return jsonb_build_object('outcome','ALREADY_CHECKED_IN','name',r.full_name,'at',p.checked_in_at); end if;
 insert into check_ins(registration_id,checked_in_by,check_in_status) values(r.id,p_usher,'VALID');
 return jsonb_build_object('outcome','VALID','name',r.full_name,'ticket',p_ticket); end $$;
revoke all on function approve_payment, check_in_pass from public, anon, authenticated;

-- Branch harvesting: SOCGC members must give their branch and address.
alter table registrations add column ministry_type text, add column branch_name text, add column branch_address text,
  add constraint socgc_branch_required check (ministry_type is distinct from 'SOCGC' or (nullif(trim(branch_name),'') is not null and nullif(trim(branch_address),'') is not null));
create view branch_directory as
  select branch_name, branch_address, count(*) as registrants, count(*) filter (where payment_status='PAID') as confirmed
  from registrations where ministry_type='SOCGC' and status<>'CANCELLED' group by 1,2 order by 1;
revoke all on branch_directory from anon, authenticated;   -- admin export via server route only

-- Payment tracking fields (filled when an admin approves or rejects a transfer)
alter table registrations add column amount_received int, add column bank_reference text, add column proof_received_at timestamptz;
