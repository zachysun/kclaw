/**
 * Skill-proposal wire shapes (type-only re-export from the proposals
 * module): the named canon server/web/cli share instead of hand-copied
 * mirrors. SkillProposalRow is the listing row the routes serve (proposal
 * plus the applied-usage count); SkillProposalResult is the tagged outcome
 * of propose/apply/reject/revert/remove.
 */
export type { SkillProposal, SkillProposalRow, SkillProposalResult } from "../skills/proposals.js"
