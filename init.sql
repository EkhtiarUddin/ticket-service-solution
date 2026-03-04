CREATE TABLE IF NOT EXISTS ticket_pools (
    event_id VARCHAR(50) PRIMARY KEY,
    total INTEGER NOT NULL,
    available INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS issued_tickets (
    id SERIAL PRIMARY KEY,
    event_id VARCHAR(50) NOT NULL,
    user_id VARCHAR(50) NOT NULL,
    ticket_number INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_event_ticket UNIQUE (event_id, ticket_number)
);

CREATE INDEX IF NOT EXISTS idx_issued_tickets_event ON issued_tickets(event_id);
CREATE INDEX IF NOT EXISTS idx_issued_tickets_user ON issued_tickets(user_id);
