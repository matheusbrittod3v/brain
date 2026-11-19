export interface RoleItem {
  roleId: string
  name: string
  description: string
  permissions: string[]
  allowedPolicies: string[]
}

export interface RegisteredUser {
  id: string
  name: string
  email?: string
  roles: string[]
  allowedProjects?: string[]
  allowedPolicies?: string[]
  linkedAgentIds: string[]
  source: string
}

export interface AssignmentItem {
  userId: string
  roleIds: string[]
  linkedAgentIds: string[]
  inheritUserPermissions: boolean
  extraPermissions?: string[]
  deniedPermissions?: string[]
}

export interface GrantItem {
  grantId: string
  actorId: string
  roles: string[]
  policyIds: string[]
  expiresAt: string
}

export interface PermissionItem {
  id: string
  group: string
  label: string
}

export interface UnifiedUserRow extends RegisteredUser {
  assignment?: AssignmentItem
  effectiveRoles: string[]
  effectiveAgents: string[]
}

export const KNOWN_AGENTS = ['cursor-mcp', 'claude-code', 'brain-runner', 'ci-bot'] as const
export const ALL_POLICIES = ['public-org', 'internal-project', 'confidential-business', 'restricted-security'] as const
export const SYSTEM_ROLE_IDS = new Set([
  'admin',
  'tech-lead',
  'developer',
  'viewer',
  'project-reader',
  'runner-operator',
  'service-agent',
  'integration-manager',
  'domain-approver',
  'auditor',
  'access-admin'
])

