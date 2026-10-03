import { tokenBrokerFixture } from "../../workers/cyspbot/test/integration/token-broker.ts";
import { githubWebhookProcessorBrokerService } from "../../workers/cyspbot-github-webhook-processor/test/integration/outbound.ts";

export default {
  fetch(request) {
    return request.url === "https://broker.example/github/apps/example-app/token"
      ? tokenBrokerFixture(request)
      : githubWebhookProcessorBrokerService(request);
  },
} satisfies ExportedHandler;
