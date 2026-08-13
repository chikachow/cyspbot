import { methodNotAllowed } from "hono/method-not-allowed";
import { Hono } from "hono/tiny";

const rootDocument = "<!doctype html><title>cyspbot</title><p>beep, boop. i am a bot.</p>";

export function createCyspbotWorker(): ExportedHandler<CyspbotEnv> {
  const app = new Hono<{ Bindings: CyspbotEnv }>();

  app.use(
    methodNotAllowed({
      app,
      onMethodNotAllowed: (_context, allowedMethods) =>
        new Response(null, {
          headers: {
            allow: allowedMethods.join(", "),
          },
          status: 405,
        }),
    }),
  );

  app.get("/", (context) => context.html(rootDocument));

  app.notFound(() => new Response(null, { status: 404 }));

  return app;
}
