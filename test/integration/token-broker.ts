import { githubWebhookProcessorBrokerService } from "../../workers/cyspbot-github-webhook-processor/test/integration/outbound.ts";

export default {
  fetch: githubWebhookProcessorBrokerService,
} satisfies ExportedHandler;
