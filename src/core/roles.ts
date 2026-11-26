import type { AgentSpec, ScenarioPack } from "./types.js";

export interface ScenarioRoles {
  dispatcher: string;
  intake: string;
  auditor: string;
  checkers: string[];
  explainer: string;
}

export interface ScenarioPackWithRoles extends ScenarioPack {
  roles?: ScenarioRoles;
}

export function scenarioRoles(pack: ScenarioPackWithRoles): ScenarioRoles {
  if (pack.roles) return pack.roles;

  const agents = pack.agents();
  const checkers = pack.requiredVerdicts;
  function agentFor(trigger: AgentSpec["trigger"]): string {
    const agent = agents.find((agent) => agent.trigger === trigger && !checkers.includes(agent.name));
    if (!agent) throw new Error(`Missing agent for the ${trigger} trigger in ${pack.id}`);
    return agent.name;
  }

  return {
    dispatcher: agentFor("start"), intake: agentFor("arrival"), auditor: agentFor("chunk"), checkers,
    explainer: agentFor("verdict"),
  };
}
