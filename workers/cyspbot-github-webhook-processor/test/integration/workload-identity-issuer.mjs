import { WorkerEntrypoint } from "cloudflare:workers";

const audience = "https://cyspbot.local";

export class WorkloadIdentityIssuer extends WorkerEntrypoint {
  issueToken(requestedAudience) {
    if (requestedAudience !== audience) {
      throw new TypeError("unexpected workload identity audience");
    }

    return { token: "eyJ.integration.workload.identity" };
  }
}

export default WorkloadIdentityIssuer;
