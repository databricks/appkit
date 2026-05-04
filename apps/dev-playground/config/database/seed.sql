-- AML demo fixture for the AppKit database plugin.
-- Data only. Table structure is created from config/database/schema.ts via
-- `appkit db migration generate` and `appkit db migrate up`.

INSERT INTO cases (
  case_id,
  entity_id,
  entity_name,
  risk_score,
  risk_level,
  status,
  case_type,
  typologies,
  alert_ids,
  alert_count,
  cluster_id,
  assigned_to,
  is_historical
) VALUES
  (
    'CASE-001',
    'ENT-1001',
    'Acme Trading LLC',
    87,
    'High',
    'In Review',
    'Structuring',
    'smurfing,cash_deposits',
    'ALT-001,ALT-002',
    2,
    'CL-01',
    'Jane Doe',
    FALSE
  ),
  (
    'CASE-002',
    'ENT-1002',
    'Globex Imports',
    73,
    'Medium',
    'New',
    'Sanctions Screening',
    'sanctions_proximity',
    'ALT-003',
    1,
    'CL-02',
    'John Smith',
    FALSE
  )
ON CONFLICT (case_id) DO UPDATE SET
  entity_id = EXCLUDED.entity_id,
  entity_name = EXCLUDED.entity_name,
  risk_score = EXCLUDED.risk_score,
  risk_level = EXCLUDED.risk_level,
  status = EXCLUDED.status,
  case_type = EXCLUDED.case_type,
  typologies = EXCLUDED.typologies,
  alert_ids = EXCLUDED.alert_ids,
  alert_count = EXCLUDED.alert_count,
  cluster_id = EXCLUDED.cluster_id,
  assigned_to = EXCLUDED.assigned_to,
  is_historical = EXCLUDED.is_historical,
  updated_at = NOW();

INSERT INTO activity_log (log_id, case_id, action, actor, details, metadata)
VALUES
  (
    'LOG-001',
    'CASE-001',
    'case_opened',
    'system',
    'High-risk structuring case generated from AML model output.',
    '{"source":"aml_gold.cases","severity":"HIGH"}'::jsonb
  ),
  (
    'LOG-002',
    'CASE-001',
    'assigned',
    'supervisor',
    'Assigned to Jane for enhanced due diligence.',
    '{"queue":"EDD"}'::jsonb
  )
ON CONFLICT (log_id) DO UPDATE SET
  action = EXCLUDED.action,
  actor = EXCLUDED.actor,
  details = EXCLUDED.details,
  metadata = EXCLUDED.metadata;

INSERT INTO investigation_notes (note_id, case_id, author, content, note_type)
VALUES
  (
    'NOTE-001',
    'CASE-001',
    'Jane Doe',
    'Initial review confirms unusual cash deposit velocity across linked accounts.',
    'analyst_note'
  ),
  (
    'NOTE-002',
    'CASE-002',
    'John Smith',
    'Screening match requires business ownership validation before escalation.',
    'triage_note'
  )
ON CONFLICT (note_id) DO UPDATE SET
  author = EXCLUDED.author,
  content = EXCLUDED.content,
  note_type = EXCLUDED.note_type;

INSERT INTO ai_summaries (
  case_id,
  summary,
  trigger_reason,
  suspicious_patterns,
  typology_tags,
  recommended_actions,
  linked_accounts_count,
  previous_alerts_count,
  model,
  raw_json
) VALUES
  (
    'CASE-001',
    'Customer activity shows repeated cash deposits below reporting thresholds.',
    'High composite risk score and linked alerts.',
    '["structured_cash_deposits","rapid_movement"]'::jsonb,
    '["structuring","layering"]'::jsonb,
    '["request_source_of_funds","review_linked_entities"]'::jsonb,
    4,
    2,
    'aml-briefing-agent-fixture',
    '{"confidence":"high"}'::jsonb
  )
ON CONFLICT (case_id) DO UPDATE SET
  summary = EXCLUDED.summary,
  trigger_reason = EXCLUDED.trigger_reason,
  suspicious_patterns = EXCLUDED.suspicious_patterns,
  typology_tags = EXCLUDED.typology_tags,
  recommended_actions = EXCLUDED.recommended_actions,
  linked_accounts_count = EXCLUDED.linked_accounts_count,
  previous_alerts_count = EXCLUDED.previous_alerts_count,
  model = EXCLUDED.model,
  raw_json = EXCLUDED.raw_json;

INSERT INTO alert_triage (alert_id, decision, reviewer, reason, case_id)
VALUES
  (
    'ALT-001',
    'investigate',
    'Jane Doe',
    'Alert is consistent with structuring typology.',
    'CASE-001'
  ),
  (
    'ALT-003',
    'review',
    'John Smith',
    'Potential sanctions proximity requires second-level review.',
    'CASE-002'
  )
ON CONFLICT (alert_id) DO UPDATE SET
  decision = EXCLUDED.decision,
  reviewer = EXCLUDED.reviewer,
  reason = EXCLUDED.reason,
  case_id = EXCLUDED.case_id,
  decided_at = NOW();
