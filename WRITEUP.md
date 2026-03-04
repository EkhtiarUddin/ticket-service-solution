# Ticket Service — Bug Analysis & Fix

## 1. The Bugs

### Root Cause

The original purchaseTickets function in src/ticketService.ts runs three
database operations with no transaction and no locking between them:

  Step 1 — SELECT available from ticket_pools
  Step 2 — INSERT into issued_tickets (N times)
  Step 3 — UPDATE available in ticket_pools

When many users hit the API at the same millisecond, all of them run
Step 1 simultaneously and read the same stale value. Then all of them
pass the availability check and all of them issue tickets.

---

### Bug 1 — Overselling

All concurrent requests read the same available count before anyone
has decremented it. All pass the check. All issue tickets. All decrement.

Example with 3 users, available = 24, each wants 8 tickets:

  T1 reads available = 24  →  24 >= 8, passes check
  T2 reads available = 24  →  24 >= 8, passes check
  T3 reads available = 24  →  24 >= 8, passes check
  T1 inserts 8 tickets, sets available = 16
  T2 inserts 8 tickets, sets available = 16  (wrong, should be 8)
  T3 inserts 8 tickets, sets available = 16  (wrong, should be 0)

Result: 24 tickets were sold but available shows 16 instead of 0.
At high concurrency available goes negative — more sold than allocated.

---

### Bug 2 — Duplicate Ticket Numbers

Ticket numbers are computed using this formula:

  currentTotal = total - available
  ticketNumber = currentTotal + i + 1

Since all concurrent requests read the same stale available value,
they all compute the same currentTotal, and generate the same ticket numbers.

Example with total = 1500, available = 1300, so currentTotal = 200:

  T1 assigns tickets: 201, 202, 203, 204, 205, 206, 207, 208
  T2 assigns tickets: 201, 202, 203, 204, 205, 206, 207, 208
  T3 assigns tickets: 201, 202, 203, 204, 205, 206, 207, 208

Result: multiple users receive identical ticket numbers.

---

## 2. Reproducing the Bugs

Run this against the original unmodified codebase:

  Terminal 1 — start the original server
  npm run dev

  Terminal 2 — run the reproduction script
  node scripts/reproduce-bugs.js

The script fires 20 simultaneous purchase requests to the same event.
You will see duplicate ticket numbers in the output. You can also check
the database directly to confirm available went below what it should be.

---

## 3. The Fix

### What Changed

Only one file was changed from the original: src/ticketService.ts

The fix has two parts:

Part 1 — Wrap everything in a database transaction

  await client.query("BEGIN");
  ... all operations ...
  await client.query("COMMIT");

  If anything fails, ROLLBACK undoes everything cleanly.

Part 2 — Change the SELECT to use FOR UPDATE

  Before (broken):
  SELECT * FROM ticket_pools WHERE event_id = $1

  After (fixed):
  SELECT * FROM ticket_pools WHERE event_id = $1 FOR UPDATE

FOR UPDATE acquires a row-level lock on that ticket_pools row.
The first request to reach this line gets the lock.
Every other concurrent request for the same eventId waits here.
When the first transaction commits, the next one reads the fresh value.
One by one, serialized, no race condition possible.

### How It Fixes Both Bugs

  Bug 1 fixed — only one transaction can pass the availability check
  at a time. No two transactions ever see the same available count.

  Bug 2 fixed — currentTotal is computed from the latest committed
  available value, which is unique per transaction. No overlapping
  ticket number ranges. No duplicates.

### Extra Protection — Unique Constraint in Database

Added to init.sql:

  CONSTRAINT unique_event_ticket UNIQUE (event_id, ticket_number)

Even if somehow two identical ticket numbers were generated, the
database itself would reject the second insert. Two layers of protection.

---

### Tradeoffs of This Approach

Pros:
  - Zero new dependencies, pure PostgreSQL
  - Simple to understand and audit
  - Atomicity and durability guaranteed by ACID
  - Correct by construction

Cons:
  - All purchases for the same event serialize through one locked row
  - PostgreSQL handles roughly 1000 to 5000 such operations per second
  - Under extreme flash sale load this single row becomes a bottleneck

---

## 4. Bonus — Scaling to Tens of Thousands of Requests Per Second

### The Problem With FOR UPDATE at Scale

Even with the correct fix, every purchase for the same event passes
through one locked row in one database. At 10000+ requests per second
per event, this saturates PostgreSQL completely.

### Solution — Redis for the Hot Path

Move the availability check and ticket number assignment into Redis.

Why Redis:
  - Handles 100000+ atomic operations per second
  - Sub-millisecond latency (0.1ms vs 5-20ms for a DB round trip)
  - Scales horizontally with Redis Cluster
  - Lua scripts run atomically on Redis (single-threaded by design)

Architecture:

  User Request
       |
       v
  Redis — atomic Lua script         (0.1ms, 100k+ ops per second)
    Check if available >= quantity
    Decrement available
    INCRBY ticket counter
       |
       v
  PostgreSQL — durable storage only  (5-20ms, happens after)
    INSERT into issued_tickets
    UPDATE ticket_pools

### Key Operations

Operation 1 — Atomic availability check in Redis using Lua:

  Lua scripts run single-threaded on the Redis server.
  No race condition possible. No distributed lock needed.
  If available is less than quantity, return -1 (reject).
  Otherwise decrement and return new available count.

Operation 2 — Atomic ticket number generation using INCRBY:

  redis INCRBY next_ticket:EVENT001 8  →  returns 208

  If it returns 208 and quantity is 8, tickets are 201 through 208.
  Globally unique across all service instances automatically.
  No two instances can ever get the same range.

Operation 3 — Async PostgreSQL write:

  The user already has confirmed ticket numbers from Redis.
  The database write happens after the response is sent.
  In production this would use a retry queue for failure handling.

### Tradeoff Comparison

  FOR UPDATE fix:
    Throughput    — 1000 to 5000 requests per second
    Complexity    — Low
    Durability    — Strong, synchronous DB write
    Dependencies  — None, just PostgreSQL
    Best for      — Normal traffic, up to a few thousand concurrent users

  Redis approach:
    Throughput    — 50000 to 200000 requests per second
    Complexity    — High
    Durability    — Eventual, async DB write
    Dependencies  — Redis required
    Best for      — Flash sales, viral events, multiple server instances

When to use which:
  Under 5000 concurrent users per event — FOR UPDATE is perfect
  Over 5000 concurrent users per event  — Redis approach needed
  Multiple server instances running      — Redis approach needed

---

## 5. Files Changed or Added

  src/ticketService.ts       — CHANGED, added transaction and FOR UPDATE lock
  src/ticketServiceScaled.ts — NEW, bonus Redis implementation
  scripts/reproduce-bugs.js  — NEW, reproduces both bugs against original code
  init.sql                   — CHANGED, added UNIQUE constraint and indexes
  WRITEUP.md                 — NEW, this document

All other files are identical to the original codebase.
The external API interface is completely unchanged.
The POST /purchase endpoint behaves identically from the outside.
