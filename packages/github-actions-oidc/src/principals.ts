export type GitHubActionsSubject =
  | {
      kind: "environment";
      environment: string;
      raw: string;
      repositorySubject: string;
    }
  | {
      kind: "pull_request";
      raw: string;
      repositorySubject: string;
    }
  | {
      kind: "ref";
      raw: string;
      ref: string;
      repositorySubject: string;
    };

export interface GitHubActionsPrincipal {
  actor: string | null;
  eventName: string;
  jobWorkflowRef: string | null;
  rawSubject: string;
  ref: string | null;
  refType: string;
  repository: string;
  repositoryId: string;
  repositoryOwnerId: string | null;
  repositoryVisibility: string | null;
  runAttempt: string | null;
  runId: string | null;
  sha: string | null;
  subject: GitHubActionsSubject;
  workflow: string | null;
  workflowRef: string | null;
}
