// ── Skills Module (CC-equivalent)
// Exports skills loading, bundled skills, and SkillTool integration.

export { registerBundledSkill, getBundledSkills, clearBundledSkills, initBundledSkills, type BundledSkillDefinition } from './bundled-skills.js';
export { loadSkills, type SkillCommand, type LoadedFrom, getSkillsPath } from './load-skills-dir.js';
