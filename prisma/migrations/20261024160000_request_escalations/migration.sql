CREATE TABLE request_escalations (
    id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    target TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'staff',
    note TEXT NOT NULL,
    raised_by TEXT,
    raised_at TIMESTAMP(3) NOT NULL,
    resolved_by TEXT,
    resolved_at TIMESTAMP(3),
    resolution TEXT,
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT request_escalations_pkey PRIMARY KEY (id),
    CONSTRAINT request_escalations_request_id_fkey FOREIGN KEY (request_id) REFERENCES service_requests(id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX request_escalations_request_id_resolved_at_idx ON request_escalations(request_id, resolved_at);
CREATE UNIQUE INDEX request_escalations_open_target_idx ON request_escalations(request_id, target) WHERE resolved_at IS NULL;
