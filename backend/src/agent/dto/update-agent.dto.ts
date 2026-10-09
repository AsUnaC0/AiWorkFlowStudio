import { CreateAgentDto } from './create-agent.dto';

export class UpdateAgentDto implements Partial<CreateAgentDto> {
  name?: string;
  description?: string;
  avatar?: string;
  type?: 'GENERAL' | 'KNOWLEDGE' | 'WORKFLOW' | 'TOOL' | 'CUSTOM';
  model?: string;
  systemPrompt?: string;
  workflowIds?: string[];
  knowledgeBaseIds?: string[];
  skillIds?: string[];
  mcpServerIds?: string[];
  maxToolIterations?: number;
  temperature?: number;
}
