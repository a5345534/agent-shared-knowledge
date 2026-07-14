## ADDED Requirements

### Requirement: Follow-up authorities are configurable
The system SHALL retain built-in skill and module-doc authorities and SHALL accept validated additional authority definitions without requiring their downstream system.

#### Scenario: Configure OpenSpec promotion
- **WHEN** an adopter configures a `promote_to_openspec` authority
- **THEN** classification, follow-up creation, destination, handoff, schema acceptance, and lint validation recognize it

#### Scenario: No authority configuration
- **WHEN** no additional authority is configured
- **THEN** built-in behavior remains available and OpenSpec is not required

#### Scenario: Malformed authority configuration
- **WHEN** authority JSON is malformed or missing required fields
- **THEN** the command fails closed with an actionable configuration error
