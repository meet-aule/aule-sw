export interface TeachingResource {
  id: string;
  skillId: string;
  title: string;
  goal: string;
  prompt: string;
  workedExample: string;
  plan: string[];
  rubric: string[];
  exitTicket: string;
  answerKey: string;
  practiceTopic: string;
}

export function teachingResource(id: unknown, language: string): TeachingResource | null;
export function listTeachingResources(language: string): Pick<TeachingResource, "id" | "title">[];
