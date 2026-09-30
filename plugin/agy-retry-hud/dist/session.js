import fs from 'node:fs';import path from 'node:path';
export const DEFAULT_RESUME_MESSAGE='Continue the existing task in this same conversation from the last confirmed checkpoint. Preserve the agreed requirements, decisions, constraints, and approved plan. Review the available conversation history, progress notes, and current workspace state to identify completed work and the next unfinished step. Verify the outcome of any interrupted operation before retrying it; do not repeat completed work or duplicate side effects. Continue within the existing scope and permissions. If essential context is missing or an operation\'s outcome is uncertain, pause and ask for clarification instead of guessing or restarting the task.';
export function validateMessage(message){if(typeof message!=='string'||!message.trim()||Buffer.byteLength(message)>4096)throw Error('message must contain 1–4096 UTF-8 bytes');return message;}
export function validateResume(job,event){
 if(job.conversation&&event.conversation_id!==job.conversation)throw Error('conversation ID mismatch; no message sent');
 if(!event.conversation_id)throw Error('missing conversation ID');
 if(!event.init?.cwd||fs.realpathSync(event.init.cwd)!==fs.realpathSync(job.cwd))throw Error('workspace mismatch');
 for(const key of ['model','agent'])if(job[key]&&event.init[key]!==job[key])throw Error(key+' identity mismatch');
 if(Object.keys(job.pendingTools||{}).length)throw Error('interrupted tool outcome uncertain');
 if(job.checkpointFile){const cp=fs.realpathSync(job.checkpointFile),rel=path.relative(job.cwd,cp);if(rel.startsWith('..')||path.isAbsolute(rel)||!fs.statSync(cp).isFile())throw Error('checkpoint must be a workspace file');}
}
