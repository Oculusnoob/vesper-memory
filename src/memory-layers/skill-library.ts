/**
 * Skill Library - v3.0 Voyager-Style Implementation
 *
 * Procedural memory: reusable patterns learned from conversations.
 */

import Database from 'better-sqlite3';

export interface Skill {
  id: string;
  name: string;
  description: string;
  category: string;
  triggers: string[];
  successCount: number;
  failureCount: number;
  avgSatisfaction: number;
}

export class SkillLibrary {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  addSkill(skill: Omit<Skill, 'id' | 'successCount' | 'failureCount' | 'avgSatisfaction'>): string {
    const id = 'skill_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

    this.db.prepare(`
      INSERT INTO skills (id, name, description, category, triggers, success_count, failure_count, avg_user_satisfaction)
      VALUES (?, ?, ?, ?, ?, 0, 0, 0.5)
    `).run(
      id,
      skill.name,
      skill.description,
      skill.category,
      JSON.stringify(skill.triggers)
    );

    return id;
  }

  search(query: string, limit: number = 5): Skill[] {
    const queryLower = query.toLowerCase();

    const skills = this.db.prepare(
      'SELECT * FROM skills ORDER BY avg_user_satisfaction DESC, success_count DESC'
    ).all() as any[];

    const scored = skills
      .map(skill => {
        const triggers = JSON.parse(skill.triggers || '[]');
        const matchScore = triggers.some((t: string) =>
          queryLower.includes(t.toLowerCase()) || t.toLowerCase().includes(queryLower)
        ) ? 1 : 0;

        const nameMatch = skill.name.toLowerCase().includes(queryLower) ? 0.5 : 0;

        return {
          id: skill.id,
          name: skill.name,
          description: skill.description,
          category: skill.category,
          triggers,
          successCount: skill.success_count,
          failureCount: skill.failure_count,
          avgSatisfaction: skill.avg_user_satisfaction,
          score: matchScore + nameMatch
        };
      })
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score);

    return scored.slice(0, limit);
  }

  recordSuccess(skillId: string, satisfaction: number): void {
    const skill = this.db.prepare('SELECT * FROM skills WHERE id = ?').get(skillId) as any;

    if (skill) {
      const newAvg = (skill.avg_user_satisfaction * skill.success_count + satisfaction) / (skill.success_count + 1);

      this.db.prepare(
        'UPDATE skills SET success_count = success_count + 1, avg_user_satisfaction = ? WHERE id = ?'
      ).run(newAvg, skillId);
    }
  }

  recordFailure(skillId: string): void {
    this.db.prepare('UPDATE skills SET failure_count = failure_count + 1 WHERE id = ?').run(skillId);
  }
}
