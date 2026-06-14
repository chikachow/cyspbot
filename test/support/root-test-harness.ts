import { problemResponse } from "@cyspbot/http/problem-details";

export default {
  fetch(_request: Request, _env: unknown, _ctx: ExecutionContext) {
    return problemResponse(404);
  },
} satisfies ExportedHandler;
