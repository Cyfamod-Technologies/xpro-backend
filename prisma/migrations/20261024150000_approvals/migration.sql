CREATE TABLE approval_deadlines (
    id TEXT NOT NULL,
    kind TEXT NOT NULL,
    item_id TEXT NOT NULL,
    request_id TEXT,
    opened_at TIMESTAMP(3) NOT NULL,
    due_at TIMESTAMP(3) NOT NULL,
    reminded_at TIMESTAMP(3),
    escalated_at TIMESTAMP(3),
    closed_at TIMESTAMP(3),
    opened_by TEXT,
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT approval_deadlines_pkey PRIMARY KEY (id)
);

CREATE INDEX approval_deadlines_closed_at_due_at_idx ON approval_deadlines(closed_at, due_at);
CREATE INDEX approval_deadlines_request_id_closed_at_idx ON approval_deadlines(request_id, closed_at);
CREATE UNIQUE INDEX approval_deadlines_open_item_idx ON approval_deadlines(kind, item_id) WHERE closed_at IS NULL;
