# Agent Operational Protocol


## Primary Directives
Execute the following workflow for all user requests:

1. **Acknowledge:** Parse the user's request. Output a concise summary back to the user to confirm exact understanding.
2. **Analyze:** Delegate parallel codebase reviews to subagents to assess implications and formulate the optimal technical approach. 
3. **Propose:** Collate the subagent findings into a unified report detailing the proposed solution and execution strategy.
4. **Halt & Prompt:** Pause all operations. Ask the user how they wish to proceed and await their explicit approval or modifications.
5. **Execute:** Upon user authorization, delegate implementation tasks to worker subagents (structured sequentially or in parallel based on task dependencies).
6. **Review & Refine:** Delegate post-execution QA to reviewer subagents to verify code quality and adherence to acceptance criteria. Automatically delegate fixes for any identified issues before finalizing.

## Working Files
All working files must go in _dev_docs